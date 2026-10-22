"""A persisted experiment controller. Activation is always a separate command."""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import time
import uuid

import torch
import learn
from reporting import event_output, next_step, print_status
from budget import GameBudget, deadline_for

DEFAULTS = {"teacher_examples": 10000, "pretrain_steps": 1000, "matches_per_candidate": 100,
            "validation_seeds": 20, "workers": 2, "threads": 2, "seed": 7}


def immutable_copy(source, destination):
    source, destination = Path(source), Path(destination)
    data = source.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("xb") as stream:
            stream.write(data)
    except FileExistsError:
        if destination.read_bytes() != data:
            raise ValueError("An immutable candidate cannot be overwritten")
    return destination


def read_json(path, default=None):
    return json.loads(Path(path).read_text()) if Path(path).exists() else default


def metrics(directory):
    path = Path(directory) / "checkpoint.pt"
    return torch.load(path, map_location="cpu", weights_only=False)["metrics"] if path.exists() else {}


def status(directory, registry=None):
    directory = Path(directory).resolve()
    state = read_json(directory / "cycle.json", {})
    registry = Path(registry or state.get("config", {}).get("registry", learn.ROOT / "data/models")).resolve()
    active = read_json(registry / "active.json", {"version": 1, "current": None, "previous": None, "revision": 0})
    candidate = state.get("candidate")
    def reports_for(entry):
        reports = {}
        for name in ["validation", "primary", "crossplay", "champion"]:
            report = read_json(entry[name]) if entry and entry.get(name) else None
            if report:
                summary = {k: report.get(k) for k in ["games", "wins", "earlyRejected", "earlyRejection", "completedSeeds", "seedsRequested", "complete", "confidence", "contracts", "latency", "namespace", "opponentSha256", "scenarios"]}
                # Legacy reports have no raw win count. Complete clusters have an exact mean.
                if summary["wins"] is None and report.get("complete"):
                    summary["wins"] = round(report["confidence"]["mean"] * report["games"])
                reports[name] = summary
        return reports
    reports = reports_for(candidate)
    history = state.get("history", [])
    last = history[-1] if history else None
    latest = directory / "candidate.json"
    compatible_active = candidate and active["current"] in [candidate.get("championId"), candidate["id"]]
    result = {"run": str(directory), "phase": state.get("phase", "not-started"), "metrics": metrics(directory),
            "latestModel": learn.file_digest(latest) if latest.exists() else None,
            "candidate": candidate, "bestValidation": state.get("best"), "active": active,
            "reports": reports, "readyForActivation": bool(state.get("phase") == "ready" and compatible_active),
            "thresholds": state.get("config"), "nextTrainingMatch": state.get("nextMatches"),
            "history": history, "lastOutcome": {**last, "reports": reports_for(last)} if last else None}
    result["nextStep"] = next_step(result)
    return result


class Cycle:
    def __init__(self, args):
        self.json_output = getattr(args, "json", False)
        self.directory = Path(args.run).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = (self.directory / "cycle.lock").open("a+")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.path = self.directory / "cycle.json"
        previous = read_json(self.path)
        self.bridge = learn.Bridge()
        try:
            saved = previous["config"] if previous else {}
            config = {key: getattr(args, key, None) if getattr(args, key, None) is not None else saved.get(key, default)
                      for key, default in DEFAULTS.items()}
            registry = getattr(args, "registry", None) or saved.get("registry") or learn.os.environ.get("BELOT_MODEL_REGISTRY", str(learn.ROOT / "data/models"))
            config.update(registry=str(Path(registry).resolve()), referenceFingerprint=self.bridge.info["referenceFingerprint"], version=1)
            if any(not isinstance(config[key], int) or config[key] < 1 for key in DEFAULTS if key != "seed") or not 1 <= config["teacher_examples"] <= 20000:
                raise ValueError("Cycle thresholds must be positive; teacher-examples must be 1..20000")
            if not 1 <= config["workers"] <= 8 or not 1 <= config["threads"] <= 8 or not 0 <= config["seed"] < 2**31:
                raise ValueError("Invalid worker/thread/seed configuration")
            if previous and saved != config:
                raise ValueError("Cycle configuration or reference bot changed; start a new run")
            self.state = previous or {"version": 1, "runId": uuid.uuid4().hex, "config": config, "phase": "collect",
                                      "nextMatches": config["matches_per_candidate"], "candidate": None, "best": None, "history": []}
            self.config = config
            self.save()
        except Exception:
            self.close()
            raise

    def close(self):
        self.bridge.close()
        self.lock.close()

    def save(self):
        learn.atomic_json(self.path, self.state)

    def active(self):
        return self.bridge.call("registryStatus", directory=self.config["registry"])

    def session_phase(self, phase, minutes, target):
        session = learn.Session(self.directory, self.config["workers"], self.config["threads"], self.config["seed"])
        session.progress_json = self.json_output
        try:
            if phase == "pretrain":
                session.pretrain(minutes, stop_at=target)
            else:
                session.collect_or_train(phase, minutes, stop_at=target, game_budget=getattr(self, "game_budget", None))
            return dict(session.metrics)
        finally:
            session.close()

    def freeze(self):
        source = self.directory / "candidate.json"
        digest = learn.file_digest(source)
        path = self.directory / "candidates" / digest / "model.json"
        immutable_copy(source, path)
        if learn.file_digest(path) != digest:
            raise ValueError("Candidate changed during export")
        self.state["candidate"] = {"id": digest, "path": str(path), "championId": self.active()["current"],
                                   "validation": str(path.parent / "validation.json")}
        self.state["phase"] = "validation"
        self.save()

    def evaluate(self, name, minutes, seeds, partner, split, opponent=None):
        candidate = self.state["candidate"]
        if name not in candidate:
            candidate[name] = str(Path(candidate["path"]).parent / f"{name}-{uuid.uuid4().hex}.json")
        namespace_key = name + "Namespace"
        if namespace_key not in candidate:
            candidate[namespace_key] = ("validation-v1:" + self.state["runId"] if split == "validation" else "final-v1:" + uuid.uuid4().hex)
        self.save()  # Reserve the exact immutable candidate, report and independent seed space first.
        args = argparse.Namespace(model=candidate["path"], report=candidate[name], split=split, partner=partner,
                                  seeds=seeds, minutes=minutes, namespace=candidate[namespace_key], opponent=opponent, quiet=True, progress=True, progress_phase=name, progress_json=self.json_output, game_budget=getattr(self, "game_budget", None))
        return learn.evaluate(args)

    @staticmethod
    def ranking(report):
        rounds = sum(bucket["rounds"] for bucket in report.get("contracts", {}).values())
        score = sum(bucket["scoreDifference"] for bucket in report.get("contracts", {}).values())
        return report["confidence"]["mean"], score / max(1, rounds)

    def reject(self, reason):
        candidate = self.state["candidate"]
        self.state["history"].append({"id": candidate["id"], "reason": reason,
                                      **{name: candidate[name] for name in ["validation", "primary", "crossplay", "champion"] if name in candidate}})
        self.state.update(phase="train", candidate=None,
                          nextMatches=metrics(self.directory)["matches"] + self.config["matches_per_candidate"])
        self.save()
        event_output({"event": "candidate-rejected", "model": candidate["id"], "reason": reason}, self.json_output)

    def ready(self):
        candidate = self.state["candidate"]
        current = self.active()["current"]
        if current is None:
            candidate["championId"] = None
        if current and current != candidate["championId"]:
            candidate["championId"] = current
            for key in ["champion", "championNamespace"]:
                candidate.pop(key, None)
            self.state["phase"] = "champion"
            self.save()
            return
        approval = {"version": 1, "modelSha256": candidate["id"], "primary": read_json(candidate["primary"]),
                    "crossplay": read_json(candidate["crossplay"])}
        if current:
            approval["champion"] = read_json(candidate["champion"])
        self.bridge.call("validateApproval", approval=approval, digest=candidate["id"])
        learn.atomic_json(candidate["path"] + ".approval.json", approval)
        self.state["phase"] = "ready"
        self.save()

    def step(self, minutes):
        phase = self.state["phase"]
        if phase in ["collect", "pretrain", "train"]:
            key = {"collect": "collectSteps", "pretrain": "pretrainUpdates", "train": "matches"}[phase]
            target = {"collect": self.config["teacher_examples"], "pretrain": self.config["pretrain_steps"], "train": self.state["nextMatches"]}[phase]
            values = metrics(self.directory)
            if values.get(key, 0) < target:
                budget = getattr(self, "game_budget", None)
                if budget and budget.exhausted:
                    return
                values = self.session_phase(phase, minutes, target)
            if values.get(key, 0) >= target:
                if phase == "train":
                    self.freeze()
                else:
                    self.state["phase"] = "pretrain" if phase == "collect" else "train"
                    self.save()
        elif phase == "validation":
            report = self.evaluate("validation", minutes, self.config["validation_seeds"], "hard", "validation")
            if report.get("earlyRejected"):
                self.reject("validation-no-possible-advantage")
                return
            if not report["complete"]:
                return
            rank = self.ranking(report)
            best = self.state["best"]
            if best and rank <= tuple(best["ranking"]):
                self.reject("validation-not-better")
            else:
                self.state["best"] = {"id": self.state["candidate"]["id"], "path": self.state["candidate"]["path"],
                                      "ranking": list(rank), "report": self.state["candidate"]["validation"]}
                if rank[0] <= .5:
                    self.reject("validation-no-advantage")
                else:
                    self.state["phase"] = "primary"
                    self.save()
        elif phase in ["primary", "crossplay"]:
            report = self.evaluate(phase, minutes, 1000 if phase == "primary" else 200,
                                   "hard" if phase == "primary" else "medium", "final")
            if report["complete"]:
                if phase == "primary" and report["confidence"]["lower"] <= .5:
                    self.reject("final-no-proven-advantage")
                elif report["latency"]["p95Ms"] > 220:
                    self.reject("decision-budget-exceeded")
                elif phase == "primary":
                    self.state["phase"] = "crossplay"
                    self.save()
                elif self.active()["current"]:
                    self.state["phase"] = "champion"
                    self.save()
                else:
                    self.ready()
        elif phase == "champion":
            current = self.active()["current"]
            if not current:
                self.state["candidate"]["championId"] = None
                self.ready()
                return
            if current != self.state["candidate"]["championId"]:
                self.state["candidate"]["championId"] = current
                for key in ["champion", "championNamespace"]:
                    self.state["candidate"].pop(key, None)
                self.save()
            path = self.bridge.call("registryModel", id=current, directory=self.config["registry"])["path"]
            report = self.evaluate("champion", minutes, 1000, "hard", "final", opponent=path)
            if report["complete"]:
                if report["confidence"]["lower"] <= .5 or report["latency"]["p95Ms"] > 220:
                    self.reject("no-proven-advantage-over-active")
                else:
                    self.ready()
        elif phase == "ready":
            active = self.active()["current"]
            candidate = self.state["candidate"]
            if active == candidate["id"]:
                self.state["history"].append({"id": candidate["id"], "reason": "manually-activated"})
                self.state.update(phase="train", candidate=None,
                                  nextMatches=metrics(self.directory)["matches"] + self.config["matches_per_candidate"])
                self.save()
            elif active != candidate["championId"]:
                candidate["championId"] = active
                for key in ["champion", "championNamespace"]:
                    candidate.pop(key, None)
                self.state["phase"] = "champion" if active else "crossplay"
                self.save()
            else:
                return False  # Never activate automatically or keep training over a ready version.
        else:
            raise ValueError("Unknown experiment phase")
        return True

    def run(self, minutes=None, games=None):
        if minutes is None and games is None:
            raise ValueError("A game or time limit is required")
        self.game_budget = GameBudget(games)
        deadline = deadline_for(minutes)
        while not learn.STOP and not self.game_budget.exhausted and time.monotonic() < deadline:
            event_output({"event": "cycle-phase", "phase": self.state["phase"],
                          "gamesRemaining": self.game_budget.remaining,
                          "minutesRemaining": round(max(0, deadline - time.monotonic()) / 60, 2) if minutes is not None else None}, self.json_output)
            if self.step((deadline - time.monotonic()) / 60 if minutes is not None else None) is False:
                break
        result = status(self.directory, self.config["registry"])
        result["sessionBudget"] = {"gamesRequested": games, "gamesCompleted": self.game_budget.used,
                                   "gamesRemaining": self.game_budget.remaining, "minutesRequested": minutes}
        return result


def run_cycle(args):
    event_output({"event": "cycle-start", "run": str(Path(args.run).resolve()), "minutes": args.minutes, "games": getattr(args, "games", None)}, getattr(args, "json", False))
    controller = Cycle(args)
    try:
        print_status(controller.run(args.minutes, getattr(args, "games", None)), getattr(args, "json", False))
    finally:
        controller.close()
