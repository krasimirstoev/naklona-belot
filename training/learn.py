"""Manual CPU self-play sessions. The TypeScript engine owns all game rules."""
from __future__ import annotations

import argparse
import collections
import copy
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import signal
import subprocess
import time

import torch
from torch import nn
from reporting import event_output, print_status
from budget import GameBudget, deadline_for, validation_rejection

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((Path(__file__).resolve().parents[1] / "src/game/learning-manifest.json").read_text())
OBSERVATION_SIZE = sum(b["size"] for b in MANIFEST["observation"])
ACTION_SIZE = sum(b["size"] for b in MANIFEST["action"])
ENCODING_VERSION = MANIFEST["encodingVersion"]
STOP = False


def stop_requested(_signal, _frame):
    global STOP
    STOP = True


class Bridge:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", "--import", "tsx", "training/environment.ts"], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
        self.info = self.call("info")
        if (self.info["observationSize"], self.info["actionSize"], self.info["encodingVersion"]) != (
                OBSERVATION_SIZE, ACTION_SIZE, ENCODING_VERSION):
            self.close()
            raise ValueError("Python/TypeScript encodings do not match")

    def call(self, command, **kwargs):
        self.process.stdin.write(json.dumps({"command": command, **kwargs}, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Game environment exited unexpectedly")
        reply = json.loads(line)
        if not reply["ok"]:
            raise ValueError(reply["error"])
        return reply["result"]

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class Network(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(OBSERVATION_SIZE + ACTION_SIZE, 128), nn.ReLU(),
                                    nn.Linear(128, 128), nn.ReLU(), nn.Linear(128, 1))

    def forward(self, x):
        return self.layers(x).squeeze(-1)


def inputs(observation, actions):
    state = torch.as_tensor(observation, dtype=torch.float32)
    features = torch.as_tensor(actions, dtype=torch.float32)
    return torch.cat((state.expand(len(features), -1), features), dim=1)


def choose(network, observation, actions):
    with torch.no_grad():
        return int(network(inputs(observation, actions)).argmax())


def export_model(network, metadata=None):
    return {"formatVersion": 1, "encodingVersion": ENCODING_VERSION,
            "observationSize": OBSERVATION_SIZE, "actionSize": ACTION_SIZE, "hiddenSizes": [128, 128],
            "layers": [{"weight": layer.weight.detach().tolist(), "bias": layer.bias.detach().tolist()}
                       for layer in network.layers if isinstance(layer, nn.Linear)], "metadata": metadata or {}}


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, separators=(",", ":"), allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def bootstrap_confidence(groups, repeats=2000):
    """Resample whole seed clusters, keeping all four seating rotations together."""
    if not groups:
        return {"mean": 0.5, "lower": 0.0, "upper": 1.0}
    means = torch.tensor([sum(g) / len(g) for g in groups], dtype=torch.float64)
    generator = torch.Generator().manual_seed(481516)
    samples = []
    for start in range(0, repeats, 100):
        indices = torch.randint(len(means), (min(100, repeats - start), len(means)), generator=generator)
        samples.append(means[indices].mean(dim=1))
    bounds = torch.quantile(torch.cat(samples), torch.tensor([.025, .975], dtype=torch.float64)).tolist()
    return {"mean": float(means.mean()), "lower": bounds[0], "upper": bounds[1]}


def match_targets(samples, terminal):
    if not terminal.get("done"):
        raise ValueError("A partial match must never receive a terminal reward")
    return [(x, float(terminal["rewards"][team])) for x, team in samples]


class Session:
    def __init__(self, directory, workers=2, threads=2, seed=7):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = (self.directory / "session.lock").open("a+")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.bridges = []
        self.active = []
        self.mode = None
        self.progress_json = True
        self.path = self.directory / "checkpoint.pt"
        torch.set_num_threads(threads)
        torch.manual_seed(seed)
        self.rng = random.Random(seed)
        self.network = Network()
        self.optimizer = torch.optim.Adam(self.network.parameters(), lr=1e-3)
        with Bridge() as bridge:
            fingerprint = bridge.info["referenceFingerprint"]
            scenario_digest = bridge.info["scenarioDigest"]
        self.config = {"version": 1, "encodingVersion": ENCODING_VERSION, "workers": workers,
                       "threads": threads, "seed": seed, "referenceFingerprint": fingerprint,
                       "scenarioDigest": scenario_digest, "scenarioRatio": .1, "epsilon": .1, "replayCapacity": 20000, "trainingHardBatches": 4}
        self.metrics = {"collectSteps": 0, "trainSteps": 0, "matches": 0, "pretrainUpdates": 0, "rlUpdates": 0}
        self.dataset = collections.deque(maxlen=20000)
        self.replay = collections.deque(maxlen=20000)
        self.environments = {}
        self.league = {}
        self.pool = []
        self.next_seed = {"collect": 0, "train": 0}
        if self.path.exists():
            # Checkpoints are local trusted training files, never files accepted by the website.
            saved = torch.load(self.path, map_location="cpu", weights_only=False)
            if saved["config"] != self.config:
                raise ValueError("Run configuration or engine changed; use a new run directory")
            self.network.load_state_dict(saved["network"])
            self.optimizer.load_state_dict(saved["optimizer"])
            self.rng.setstate(saved["random"])
            torch.set_rng_state(saved["torchRandom"])
            for name in ["metrics", "dataset", "replay", "environments", "league", "pool", "next_seed"]:
                setattr(self, name, saved[name])

    def start(self, mode):
        self.mode = mode
        for i in range(self.config["workers"]):
            bridge = Bridge()
            self.bridges.append(bridge)
            saved = self.environments.get(mode, [])
            if i < len(saved):
                worker = {**saved[i], "observation": bridge.call("restore", snapshot=saved[i]["snapshot"])}
            else:
                worker = self.new_worker(bridge)
            self.active.append(worker)

    def new_worker(self, bridge):
        mode = self.mode
        seed = self.config["seed"] * 1_000_000 + self.next_seed[mode]
        self.next_seed[mode] += 1
        observation = bridge.call("reset", namespace="train-collect-v1" if mode == "collect" else "train-selfplay-v1", seed=seed)
        if mode == "collect":
            policies = ["hard" if self.rng.random() < .25 else "medium" for _ in range(4)]
        else:
            if not self.pool:
                self.snapshot_network()
            frozen = ["medium", "hard", *self.pool]
            policies = [self.rng.choice(frozen) for _ in range(4)]
            seat = self.rng.randrange(4)
            policies[seat] = "learner"
            if self.rng.random() >= .75:
                policies[(seat + 2) % 4] = "learner"
        return {"observation": observation, "policies": policies, "samples": []}

    def snapshot_network(self):
        key = f"snapshot-{self.metrics['matches']}-{self.metrics['rlUpdates']}"
        self.league[key] = copy.deepcopy(self.network.state_dict())
        self.pool = [*self.pool, key][-4:]

    def save(self):
        if self.mode:
            self.environments[self.mode] = [{"snapshot": b.call("snapshot"), "policies": w["policies"], "samples": w["samples"]}
                                           for b, w in zip(self.bridges, self.active)]
        used = set(self.pool)
        for workers in self.environments.values():
            for worker in workers:
                used.update(p for p in worker["policies"] if p.startswith("snapshot-"))
        self.league = {k: v for k, v in self.league.items() if k in used}
        saved = {name: getattr(self, name) for name in ["config", "metrics", "dataset", "replay", "environments", "league", "pool", "next_seed"]}
        saved.update(network=self.network.state_dict(), optimizer=self.optimizer.state_dict(), random=self.rng.getstate(), torchRandom=torch.get_rng_state())
        temp = self.path.with_name("checkpoint.pt.tmp")
        torch.save(saved, temp)
        with temp.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temp, self.path)
        atomic_json(self.directory / "candidate.json", export_model(self.network, {"config": self.config, "metrics": self.metrics}))
        with (self.directory / "metrics.jsonl").open("a") as stream:
            stream.write(json.dumps({"time": time.time(), **self.metrics, "teacherExamples": len(self.dataset), "replayExamples": len(self.replay)}) + "\n")

    def close(self):
        for b in self.bridges:
            b.close()
        self.lock.close()

    def collect_or_train(self, mode, minutes=None, stop_at=None, game_budget=None):
        if mode == "train" and self.metrics["pretrainUpdates"] == 0:
            raise ValueError("Collect examples and run pretrain before self-play")
        game_budget = game_budget or GameBudget()
        if minutes is None and stop_at is None and game_budget.limit is None:
            raise ValueError("A game, time or phase limit is required")
        self.start(mode)
        deadline, last_save = deadline_for(minutes), time.monotonic()
        frozen_networks = {}
        executor = ThreadPoolExecutor(max_workers=self.config["workers"])

        def teacher_step(bridge, policy):
            index = bridge.call("recommend", policy=policy)["index"]
            return index, bridge.call("step", index=index)

        clean_exit = False
        try:
            while not STOP and not game_budget.exhausted and time.monotonic() < deadline and (stop_at is None or
                    self.metrics["collectSteps" if mode == "collect" else "matches"] < stop_at):
                pending = []
                # Reserve at most one possible completion per active actor. This prevents
                # two concurrent terminal actions from overshooting a one-game remainder.
                actor_count = len(self.active) if game_budget.remaining is None else min(len(self.active), game_budget.remaining)
                for bridge, worker in zip(self.bridges[:actor_count], self.active[:actor_count]):
                    obs = worker["observation"]
                    policy = worker["policies"][obs["seat"]]
                    if mode == "collect":
                        future = executor.submit(teacher_step, bridge, policy)
                    elif policy == "learner":
                        index = self.rng.randrange(len(obs["actions"])) if self.rng.random() < self.config["epsilon"] else choose(
                            self.network, obs["observation"], obs["actionFeatures"])
                        x = torch.tensor(obs["observation"] + obs["actionFeatures"][index], dtype=torch.float32)
                        worker["samples"].append((x, obs["team"]))
                        future = executor.submit(bridge.call, "step", index=index)
                    elif policy.startswith("snapshot-"):
                        if policy not in frozen_networks:
                            with torch.random.fork_rng():
                                net = Network()
                            net.load_state_dict(self.league[policy])
                            frozen_networks[policy] = net
                        index = choose(frozen_networks[policy], obs["observation"], obs["actionFeatures"])
                        future = executor.submit(bridge.call, "step", index=index)
                    else:
                        future = executor.submit(bridge.call, "act", policy=policy)
                    pending.append(future)
                # Both Node actors can work concurrently. Apply results in fixed actor order.
                # Checkpoints are taken only after all in-flight actions have been committed.
                for i, (bridge, worker, future) in enumerate(zip(self.bridges, self.active, pending)):
                    result = future.result()
                    if mode == "collect":
                        index, result = result
                        obs = worker["observation"]
                        self.dataset.append((torch.tensor(obs["observation"], dtype=torch.float32),
                                             torch.tensor(obs["actionFeatures"], dtype=torch.float32), index))
                        self.metrics["collectSteps"] += 1
                    else:
                        self.metrics["trainSteps"] += 1
                    if result["done"]:
                        game_budget.complete()
                        if mode == "collect":
                            self.metrics["collectMatches"] = self.metrics.get("collectMatches", 0) + 1
                        if mode == "train":
                            self.replay.extend(match_targets(worker["samples"], result))
                            self.metrics["matches"] += 1
                            if self.metrics["matches"] % 20 == 0:
                                self.snapshot_network()
                        self.active[i] = self.new_worker(bridge)
                    else:
                        worker["observation"] = result
                    if mode == "train" and len(self.replay) >= 64 and self.metrics["trainSteps"] % 8 == 0:
                        batch = self.rng.sample(list(self.replay), 64)
                        prediction = self.network(torch.stack([x for x, _ in batch]))
                        loss = nn.functional.mse_loss(prediction, torch.tensor([y for _, y in batch]))
                        self.update(loss, "rlUpdates")
                if time.monotonic() - last_save >= 30:
                    self.save()
                    frozen_networks = {k: v for k, v in frozen_networks.items() if k in self.league}
                    event_output({"event": "training-progress", "phase": mode, **self.metrics}, self.progress_json)
                    last_save = time.monotonic()
            clean_exit = True
        finally:
            executor.shutdown(wait=True)
            if clean_exit:
                self.save()

    def update(self, loss, metric):
        if not torch.isfinite(loss):
            raise ValueError("Non-finite training loss")
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.network.parameters(), 5, error_if_nonfinite=True)
        self.optimizer.step()
        self.metrics[metric] += 1
        self.metrics["lastLoss"] = float(loss.detach())

    def pretrain(self, minutes=None, stop_at=None):
        if not self.dataset:
            raise ValueError("No teacher examples; run collect first")
        if minutes is None and stop_at is None:
            raise ValueError("A step or time limit is required for pretraining")
        deadline, last_save = deadline_for(minutes), time.monotonic()
        data = list(self.dataset)
        with Bridge() as bridge:
            catalog = bridge.call("trainingScenarios")
        if catalog["catalogDigest"] != self.config["scenarioDigest"]:
            raise ValueError("Scenario catalog changed; start a new experiment")
        scenarios = [(torch.tensor(s["observation"], dtype=torch.float32),
                      torch.tensor(s["actionFeatures"], dtype=torch.float32), s["preferred"]) for s in catalog["examples"]]
        if not scenarios:
            raise ValueError("Missing training scenarios")
        try:
            while not STOP and time.monotonic() < deadline and (stop_at is None or self.metrics["pretrainUpdates"] < stop_at):
                # Exactly 90% natural teacher examples / 10% training scenarios per update.
                batch = [(obs, actions, [index]) for obs, actions, index in self.rng.choices(data, k=36)]
                batch += self.rng.choices(scenarios, k=4)
                logits = self.network(torch.cat([inputs(obs, actions) for obs, actions, _ in batch]))
                offset, losses = 0, []
                for _, actions, preferred in batch:
                    losses.append(preference_loss(logits[offset:offset + len(actions)], preferred))
                    offset += len(actions)
                self.update(torch.stack(losses).mean(), "pretrainUpdates")
                self.metrics["pretrainNaturalExamples"] = self.metrics.get("pretrainNaturalExamples", 0) + 36
                self.metrics["pretrainScenarioExamples"] = self.metrics.get("pretrainScenarioExamples", 0) + 4
                if time.monotonic() - last_save >= 30:
                    self.save()
                    event_output({"event": "training-progress", "phase": "pretrain", **self.metrics}, self.progress_json)
                    last_save = time.monotonic()
        finally:
            self.save()


def preference_loss(logits, preferred):
    """Probability mass of a preferred set; singleton equals cross entropy."""
    if not preferred or len(set(preferred)) != len(preferred) or any(i < 0 or i >= len(logits) for i in preferred):
        raise ValueError("Invalid preferred action set")
    return torch.logsumexp(logits, dim=0) - torch.logsumexp(logits[preferred], dim=0)


def profile(minutes):
    with Bridge() as bridge:
        observation = bridge.call("reset", namespace="profile-v1", seed=0)
        start, steps, matches = time.monotonic(), 0, 0
        while not STOP and time.monotonic() - start < minutes * 60:
            observation = bridge.call("act", policy="medium")
            steps += 1
            if observation["done"]:
                matches += 1
                observation = bridge.call("reset", namespace="profile-v1", seed=matches)
        elapsed = time.monotonic() - start
        print(json.dumps({"seconds": elapsed, "steps": steps, "matches": matches, "stepsPerSecond": steps / elapsed,
                          "note": "Medium-only environment throughput; hard teachers and learning add cost."}))


def evaluation_progress(args, state, event):
    if not getattr(args, "progress", False):
        return
    groups, current = state["groups"], state["current"]
    event_output({"event": event, "phase": getattr(args, "progress_phase", args.split),
                      "completedSeeds": len(groups), "seedsRequested": args.seeds,
                      "games": len(groups) * 4 + len(current), "gamesRequested": args.seeds * 4,
                      "wins": sum(sum(group) for group in groups) + sum(current),
                      "model": state["config"]["modelSha256"][:12], "earlyRejection": state.get("earlyRejection")}, getattr(args, "progress_json", True))


def evaluate(args):
    game_budget = getattr(args, "game_budget", None) or GameBudget(getattr(args, "games", None))
    if args.minutes is None and game_budget.limit is None:
        raise ValueError("A game or time limit is required")
    path = Path(args.report)
    path.parent.mkdir(parents=True, exist_ok=True)
    progress_path = path.with_name(path.name + ".progress.pt")
    digest = file_digest(args.model)
    namespace = getattr(args, "namespace", None) or ("final-v1" if args.split == "final" else "validation-v1")
    prefix = "final-v1" if args.split == "final" else "validation-v1"
    if not re.fullmatch(re.escape(prefix) + r"(?::[a-f0-9]{32})?", namespace):
        raise ValueError("Evaluation namespace does not match the split")
    opponent_path = getattr(args, "opponent", None)
    opponent_digest = file_digest(opponent_path) if opponent_path else None
    quiet = getattr(args, "quiet", False)
    with path.with_name(path.name + ".lock").open("a+") as lock, Bridge() as bridge:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = {"version": 1, "modelSha256": digest, "referenceFingerprint": bridge.info["referenceFingerprint"],
                  "split": args.split, "partner": args.partner, "seedsRequested": args.seeds,
                  "namespace": namespace, "opponentSha256": opponent_digest, "scenarioDigest": bridge.info["scenarioDigest"]}
        state = {"config": config, "groups": [], "current": [], "snapshot": None,
                 "latencies": [], "latencyCount": 0, "contracts": {}}
        if progress_path.exists():
            state = torch.load(progress_path, map_location="cpu", weights_only=False)
            if state["config"] != config:
                raise ValueError("Evaluation configuration changed; do not reuse this report path")
        elif path.exists():
            raise ValueError("Report exists without resumable state; choose a new path")
        loaded = bridge.call("loadModel", path=str(Path(args.model).resolve()))
        if loaded["digest"] != digest:
            raise ValueError("Model changed while evaluation was starting")
        if "scenarios" not in state:
            state["scenarios"] = bridge.call("scenarioReport")
        if opponent_path:
            loaded_opponent = bridge.call("loadOpponent", path=str(Path(opponent_path).resolve()))
            if loaded_opponent["digest"] != opponent_digest:
                raise ValueError("Opponent changed while evaluation was starting")
        obs = bridge.call("restore", snapshot=state["snapshot"]) if state["snapshot"] else None
        deadline, last_save = deadline_for(args.minutes), time.monotonic()
        evaluation_progress(args, state, "evaluation-start")

        def save():
            state["snapshot"] = bridge.call("snapshot") if obs and not obs["done"] else None
            temp = progress_path.with_name(progress_path.name + ".tmp")
            torch.save(state, temp)
            os.replace(temp, progress_path)
            latencies = sorted(state["latencies"])
            report = {**config, "completedSeeds": len(state["groups"]), "games": len(state["groups"]) * 4 + len(state["current"]),
                      "complete": len(state["groups"]) == args.seeds,
                      "earlyRejected": bool(state.get("earlyRejection")), "earlyRejection": state.get("earlyRejection"),
                      "wins": sum(sum(group) for group in state["groups"]) + sum(state["current"]), "confidence": bootstrap_confidence(state["groups"]),
                      "contracts": state["contracts"], "scenarios": state["scenarios"], "latency": {"count": state["latencyCount"],
                      "p95Ms": latencies[min(len(latencies) - 1, math.floor(len(latencies) * .95))] if latencies else 0}}
            atomic_json(path, report)
            return report

        try:
            while not STOP and time.monotonic() < deadline and len(state["groups"]) < args.seeds:
                # Check restored results before taking any action, even if this session's
                # game budget has just been used by the preceding phase.
                rejection = validation_rejection(state, args.split, args.seeds)
                if rejection:
                    state["earlyRejection"] = rejection
                    break
                if game_budget.exhausted:
                    break
                seat = len(state["current"])
                seed = len(state["groups"])
                if obs is None:
                    obs = bridge.call("reset", namespace=namespace, seed=seed)
                opponent_seat = (seat + (1 if seed % 2 == 0 else 3)) % 4
                policy = ("model" if obs["seat"] == seat else args.partner if obs["seat"] == (seat + 2) % 4
                          else "opponent" if opponent_path and obs["seat"] == opponent_seat else "hard")
                obs = bridge.call("act", policy=policy)
                if policy == "model":
                    state["latencies"].append(obs["elapsedMs"])
                    state["latencies"] = state["latencies"][-10000:]
                    state["latencyCount"] += 1
                if obs["done"]:
                    game_budget.complete()
                    state["current"].append(float(obs["rewards"][seat % 2] > 0))
                    for r in obs["results"]:
                        bucket = state["contracts"].setdefault(r["contract"], {"rounds": 0, "scoreDifference": 0, "made": 0, "failed": 0, "hanging": 0})
                        bucket["rounds"] += 1
                        bucket["scoreDifference"] += r["added"][seat % 2] - r["added"][1 - seat % 2]
                        bucket[r["outcome"]] += 1
                    if len(state["current"]) == 4:
                        state["groups"].append(state["current"])
                        state["current"] = []
                    obs = None
                if time.monotonic() - last_save >= 30:
                    report = save()
                    evaluation_progress(args, state, "evaluation-progress")
                    if not quiet:
                        print(json.dumps({k: report[k] for k in ["completedSeeds", "games", "confidence"]}), flush=True)
                    last_save = time.monotonic()
        finally:
            state["earlyRejection"] = state.get("earlyRejection") or validation_rejection(state, args.split, args.seeds)
            report = save()
            evaluation_progress(args, state, "evaluation-rejected" if report["earlyRejected"] else "evaluation-complete" if report["complete"] else "evaluation-paused")
        if not quiet:
            print(json.dumps(report))
        return report


def promote(args):
    primary = json.loads(Path(args.report).read_text())
    crossplay = json.loads(Path(args.crossplay).read_text())
    digest = file_digest(args.model)
    approval = {"version": 1, "modelSha256": digest, "primary": primary, "crossplay": crossplay}
    if getattr(args, "champion", None):
        approval["champion"] = json.loads(Path(args.champion).read_text())
    with Bridge() as bridge:
        if primary["referenceFingerprint"] != bridge.info["referenceFingerprint"]:
            raise ValueError("Reference bot changed after evaluation")
        bridge.call("validateApproval", approval=approval, digest=digest)
    atomic_json(str(args.model) + ".approval.json", approval)
    print("Approved the exact model artifact; enable explicitly with BELOT_MODEL_PATH.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["collect", "pretrain", "train"]:
        p = sub.add_parser(name)
        p.add_argument("--run", required=True)
        limit = p.add_mutually_exclusive_group(required=True)
        limit.add_argument("--minutes", type=float)
        if name == "pretrain":
            limit.add_argument("--steps", type=int)
        else:
            limit.add_argument("--games", type=int)
        p.add_argument("--workers", type=int, default=2)
        p.add_argument("--threads", type=int, default=2)
        p.add_argument("--seed", type=int, default=7)
    for name in ["cycle", "status"]:
        p = sub.add_parser(name)
        p.add_argument("--run", required=True)
        p.add_argument("--registry")
        p.add_argument("--json", action="store_true", help="Emit machine-readable events and the full report")
        if name == "cycle":
            limit = p.add_mutually_exclusive_group(required=True)
            limit.add_argument("--minutes", type=float)
            limit.add_argument("--games", type=int, help="Additional completed matches across all phases")
            p.add_argument("--teacher-examples", type=int)
            p.add_argument("--pretrain-steps", type=int)
            p.add_argument("--matches-per-candidate", type=int)
            p.add_argument("--validation-seeds", type=int)
            p.add_argument("--workers", type=int)
            p.add_argument("--threads", type=int)
            p.add_argument("--seed", type=int)
    for name in ["activate", "rollback"]:
        p = sub.add_parser(name)
        p.add_argument("--registry", default=os.environ.get("BELOT_MODEL_REGISTRY", str(ROOT / "data/models")))
        if name == "activate":
            p.add_argument("--model", required=True)
    p = sub.add_parser("profile")
    p.add_argument("--minutes", type=float, required=True)
    p = sub.add_parser("evaluate")
    p.add_argument("--model", required=True)
    p.add_argument("--report", required=True)
    limit = p.add_mutually_exclusive_group(required=True)
    limit.add_argument("--minutes", type=float)
    limit.add_argument("--games", type=int)
    p.add_argument("--seeds", type=int, required=True)
    p.add_argument("--split", choices=["validation", "final"], default="validation")
    p.add_argument("--partner", choices=["hard", "medium"], default="hard")
    p.add_argument("--namespace")
    p.add_argument("--opponent", help="Compare against this frozen model paired with a hard bot")
    p = sub.add_parser("export")
    p.add_argument("--run", required=True)
    p.add_argument("--output", required=True)
    p = sub.add_parser("promote")
    p.add_argument("--model", required=True)
    p.add_argument("--report", required=True)
    p.add_argument("--crossplay", required=True)
    p.add_argument("--champion")
    args = parser.parse_args()
    if getattr(args, "minutes", None) is not None and (not math.isfinite(args.minutes) or args.minutes <= 0):
        parser.error("--minutes must be finite and positive")
    if getattr(args, "games", None) is not None and args.games < 1:
        parser.error("--games must be a positive integer")
    if getattr(args, "steps", None) is not None and args.steps < 1:
        parser.error("--steps must be a positive integer")
    if any(getattr(args, name, None) is not None and not 1 <= getattr(args, name) <= 8 for name in ["workers", "threads"]) or (getattr(args, "seed", None) is not None and not 0 <= args.seed < 2**31):
        parser.error("workers/threads must be 1..8 and seed 0..2^31-1")
    if hasattr(args, "seeds") and args.seeds < 1:
        parser.error("--seeds must be positive")
    signal.signal(signal.SIGINT, stop_requested)
    signal.signal(signal.SIGTERM, stop_requested)
    torch.set_num_threads(2)
    if args.command in ["cycle", "status"]:
        # Reuse this module instance: STOP signals and checkpoint classes must be shared.
        import sys
        sys.modules.setdefault("learn", sys.modules[__name__])
        from cycle import run_cycle, status
        if args.command == "cycle":
            run_cycle(args)
        else:
            print_status(status(args.run, args.registry), args.json)
    elif args.command in ["activate", "rollback"]:
        with Bridge() as bridge:
            request = {"directory": str(Path(args.registry).resolve())}
            if args.command == "activate":
                request["path"] = str(Path(args.model).resolve())
            print(json.dumps(bridge.call(args.command, **request)))
    elif args.command == "profile":
        profile(args.minutes)
    elif args.command == "evaluate":
        evaluate(args)
    elif args.command == "export":
        source = Path(args.run) / "candidate.json"
        with Bridge() as bridge:
            bridge.call("loadModel", path=str(source.resolve()))
        atomic_json(args.output, json.loads(source.read_text()))
        print(json.dumps({"model": args.output, "sha256": file_digest(args.output)}))
    elif args.command == "promote":
        promote(args)
    else:
        session = Session(args.run, args.workers, args.threads, args.seed)
        try:
            if args.command == "pretrain":
                session.pretrain(args.minutes, stop_at=session.metrics["pretrainUpdates"] + args.steps if args.steps is not None else None)
            else:
                session.collect_or_train(args.command, args.minutes, game_budget=GameBudget(args.games))
            print(json.dumps(session.metrics))
        finally:
            session.close()


if __name__ == "__main__":
    main()
