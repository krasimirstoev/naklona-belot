"""CPU actor-critic, teacher anchoring and resumable on-policy rollouts.

Only complete match returns train the critic. No final/validation examples enter here.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import time

import torch
from torch import nn

SETTINGS = {"rolloutSize": 2048, "epochs": 4, "minibatch": 64, "clip": .2,
            "valueCoefficient": .5, "entropyCoefficient": .01, "teacherCoefficient": .1,
            "learningRate": .0003, "gradientNorm": .5, "holdoutExamples": 5000}
BIDS = ["pass", "C", "D", "H", "S", "NT", "AT", "contra", "recontra"]


class ActorCritic(nn.Module):
    def __init__(self, observation_size, action_size):
        super().__init__()
        self.observation_size = observation_size
        self.encoder = nn.Sequential(nn.Linear(observation_size, 128), nn.ReLU(), nn.Linear(128, 128), nn.ReLU())
        self.action_encoder = nn.Sequential(nn.Linear(action_size, 64), nn.ReLU())
        self.bidding_head = nn.Sequential(nn.Linear(192, 64), nn.ReLU(), nn.Linear(64, 1))
        self.playing_head = nn.Sequential(nn.Linear(192, 64), nn.ReLU(), nn.Linear(64, 1))
        self.value_head = nn.Sequential(nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, x):
        observation, action = x[..., :self.observation_size], x[..., self.observation_size:]
        features = torch.cat((self.encoder(observation), self.action_encoder(action)), dim=-1)
        return torch.where(observation[..., 36] == 1, self.bidding_head(features).squeeze(-1),
                           self.playing_head(features).squeeze(-1))

    def logits(self, observation, actions):
        state = self.encoder(torch.as_tensor(observation, dtype=torch.float32))
        features = self.action_encoder(torch.as_tensor(actions, dtype=torch.float32))
        x = torch.cat((state.expand(len(features), -1), features), dim=1)
        head = self.bidding_head if observation[36] == 1 else self.playing_head
        return head(x).squeeze(-1)

    def value(self, observation):
        return self.value_head(self.encoder(torch.as_tensor(observation, dtype=torch.float32))).squeeze(-1)


def export_actor(network):
    def layers(module):
        return [{"weight": l.weight.detach().tolist(), "bias": l.bias.detach().tolist()}
                for l in module if isinstance(l, nn.Linear)]
    return {"layers": layers(network.encoder), "actionEncoder": layers(network.action_encoder),
            "biddingHead": layers(network.bidding_head), "playingHead": layers(network.playing_head)}


def match_split(seed):
    # The whole match belongs to one split, including every seat and round.
    digest = hashlib.sha256(f"teacher-match-v2:{seed}".encode()).digest()
    return "holdout" if int.from_bytes(digest[:4], "big") % 5 == 0 else "train"


def teacher_groups(dataset, profile='legacy'):
    groups = [[example for example in dataset if bool(example[0][36]) == bidding] for bidding in [True, False]]
    if profile == 'legacy':
        return groups
    from bidding import bid_index
    eligible = [e for e in groups[0] if len(e[1]) > 1]
    return {'pass': [e for e in eligible if bid_index(e[1], e[2]) == 0],
            'call': [e for e in eligible if bid_index(e[1], e[2]) != 0],
            'playing': groups[1], 'forcedExcluded': len(groups[0]) - len(eligible)}


def teacher_batch(session, groups, scenarios):
    batch = []
    if isinstance(groups, dict):
        natural = groups['pass'] + groups['call'] + groups['playing']
        session.metrics['teacherSelection'] = {
            'profile': 'balanced-v1', 'available': {k: len(groups[k]) for k in ['pass', 'call', 'playing']},
            'missingGroups': [k for k in ['pass', 'call', 'playing'] if not groups[k]],
            'forcedExcluded': groups['forcedExcluded']}
        selections = [(groups['pass'] or groups['call'] or natural, 12),
                      (groups['call'] or groups['pass'] or natural, 6),
                      (groups['playing'] or natural, 18)]
    else:
        selections = [(group or next((g for g in groups if g), []), 18) for group in groups]
    for source, count in selections:
        if not source:
            raise ValueError("Collect current-rule teacher examples with a choice before PPO training")
        batch.extend((obs, actions, [index]) for obs, actions, index, *_ in session.rng.choices(source, k=count))
    batch.extend(session.rng.choices(scenarios, k=4))
    return batch


def teacher_loss(network, batch, bidding_weight=1):
    from learn import inputs, preference_loss
    logits = network(torch.cat([inputs(obs, actions) for obs, actions, _ in batch]))
    offset, losses = 0, []
    for obs, actions, preferred in batch:
        weight = bidding_weight if bool(obs[36]) else 1
        losses.append(weight * preference_loss(logits[offset:offset + len(actions)], preferred))
        offset += len(actions)
    return torch.stack(losses).mean()


def policy_loss(log_prob, old_log_prob, advantage, clip=.2):
    ratio = (log_prob - old_log_prob).exp()
    return -torch.minimum(ratio * advantage, ratio.clamp(1 - clip, 1 + clip) * advantage).mean()


def diagnostics(session):
    from learn import preference_loss
    from bidding import bidding_metrics, bid_index
    reports = {}
    with torch.no_grad():
        for name, dataset in [("train", session.dataset), ("holdout", session.holdout)]:
            report = {}
            for phase, group in zip(["bidding", "playing"], teacher_groups(dataset)):
                # Stable bounded sample; reporting must not consume training RNG.
                sample = group if phase == 'bidding' else group[::max(1, len(group) // 128)][:128]
                loss, correct, bids, teachers = 0., 0, {}, {}
                pairs, forced = [], 0
                for obs, actions, index, *_ in sample:
                    logits = session.network.logits(obs, actions)
                    selected = int(logits.argmax())
                    loss += float(preference_loss(logits, [index]))
                    correct += selected == index
                    if phase == "bidding":
                        if len(actions) == 1:
                            forced += 1
                        else:
                            pairs.append((bid_index(actions, index), bid_index(actions, selected)))
                        for target, action_index in [(bids, selected), (teachers, index)]:
                            bid = BIDS[int(actions[action_index, 32:41].argmax())]
                            target[bid] = target.get(bid, 0) + 1
                report[phase] = {"examples": len(group), "sampled": len(sample),
                                 "loss": loss / len(sample) if sample else None,
                                 "agreement": correct / len(sample) if sample else None,
                                 "bids": bids, "teacherBids": teachers}
                if phase == 'bidding':
                    report[phase].update(bidding_metrics(pairs), forced=forced, fullDataset=True)
            reports[name] = report
    if getattr(session, 'bidding_profile', 'legacy') == 'balanced-v1':
        groups = teacher_groups(session.dataset, 'balanced-v1')
        session.metrics['teacherSelection'] = {
            'profile': 'balanced-v1', 'available': {k: len(groups[k]) for k in ['pass', 'call', 'playing']},
            'missingGroups': [k for k in ['pass', 'call', 'playing'] if not groups[k]],
            'forcedExcluded': groups['forcedExcluded']}
    session.metrics["diagnostics"] = reports


def optimize(session, scenarios, deadline):
    """Resume a minibatch boundary, never recollect under a partially updated actor."""
    import learn
    cfg = session.config["ppo"]
    if not session.rollout:
        return True
    if session.ppo_update is None:
        advantages = torch.tensor([s["return"] - s["oldValue"] for s in session.rollout])
        advantages = (advantages - advantages.mean()) / advantages.std(unbiased=False).clamp_min(1e-8)
        session.ppo_update = {"epoch": 0, "offset": 0, "order": [], "advantages": advantages,
                              "kl": 0., "clipped": 0., "count": 0}
    state = session.ppo_update
    groups = teacher_groups(session.dataset, session.bidding_profile)
    while state["epoch"] < cfg["epochs"]:
        if learn.STOP or time.monotonic() >= deadline:
            return False
        if not state["order"]:
            state["order"] = list(range(len(session.rollout)))
            session.rng.shuffle(state["order"])
        indices = state["order"][state["offset"]:state["offset"] + cfg["minibatch"]]
        batch = [session.rollout[i] for i in indices]
        log_probs, entropies = [], []
        for sample in batch:
            distribution = torch.distributions.Categorical(logits=session.network.logits(sample["observation"], sample["actions"]))
            log_probs.append(distribution.log_prob(torch.tensor(sample["index"])))
            entropies.append(distribution.entropy())
        log_probs = torch.stack(log_probs)
        old_log_probs = torch.tensor([s["oldLogProb"] for s in batch])
        values = session.network.value(torch.stack([s["observation"] for s in batch]))
        value_loss = nn.functional.mse_loss(values, torch.tensor([s["return"] for s in batch]))
        anchor = teacher_loss(session.network, teacher_batch(session, groups, scenarios),
                              bidding_weight=3 if session.bidding_profile == 'balanced-v1' else 1)
        loss = (policy_loss(log_probs, old_log_probs, state["advantages"][indices], cfg["clip"])
                + cfg["valueCoefficient"] * value_loss - cfg["entropyCoefficient"] * torch.stack(entropies).mean()
                + cfg["teacherCoefficient"] * anchor)
        session.update(loss, "rlUpdates")
        with torch.no_grad():
            log_ratio = log_probs - old_log_probs
            ratio = log_ratio.exp()
            state["kl"] += float(((ratio - 1) - log_ratio).sum())
            state["clipped"] += int(((ratio - 1).abs() > cfg["clip"]).sum())
            state["count"] += len(batch)
        session.metrics.update(valueLoss=float(value_loss.detach()), teacherLoss=float(anchor.detach()),
                               policyEntropy=float(torch.stack(entropies).mean().detach()))
        state["offset"] += len(batch)
        if state["offset"] >= len(session.rollout):
            state.update(epoch=state["epoch"] + 1, offset=0, order=[])
    session.metrics.update(ppoKL=state["kl"] / state["count"], ppoClipFraction=state["clipped"] / state["count"],
                           lastUpdatedMatch=session.metrics["matches"],
                           rolloutUpdates=session.metrics.get("rolloutUpdates", 0) + 1,
                           lastRolloutExamples=len(session.rollout))
    session.rollout.clear()
    session.ppo_update = None
    diagnostics(session)
    return True


def train(session, minutes=None, stop_at=None, game_budget=None, stop_updates=None):
    import learn
    from budget import GameBudget, deadline_for
    from reporting import event_output
    if not session.dataset or not session.metrics["pretrainUpdates"]:
        raise ValueError("Collect current-rule teacher examples and pretrain before PPO self-play")
    if minutes is None and stop_at is None and game_budget is None:
        raise ValueError("A game, time or phase limit is required")
    budget = game_budget or GameBudget()
    deadline = deadline_for(minutes)
    started = last_save = time.monotonic()
    elapsed_start = session.metrics.get("trainingSeconds", 0.)
    session.snapshot_network(baseline=True)
    session.start("train")
    scenarios = session.training_scenarios()
    frozen = {}

    def progress():
        elapsed = time.monotonic() - started
        session.metrics.update(trainingSeconds=elapsed_start + elapsed,
                               decisionsPerSecond=session.metrics["trainSteps"] / max(.001, elapsed_start + elapsed),
                               pendingRolloutExamples=len(session.rollout),
                               inFlightExamples=sum(len(w["samples"]) for w in session.active))

    with ThreadPoolExecutor(max_workers=session.config["workers"]) as executor:
        try:
            while not learn.STOP and time.monotonic() < deadline:
                active = [(i, b, w) for i, (b, w) in enumerate(zip(session.bridges, session.active)) if not w["observation"]["done"]]
                ready = len(session.rollout) >= session.config["ppo"]["rolloutSize"] or session.ppo_update is not None
                if not active and ready:
                    if not optimize(session, scenarios, deadline):
                        break
                    progress()
                    session.save()
                boundary = not session.rollout and session.ppo_update is None and not active
                if boundary and stop_at is not None and session.metrics.get("lastUpdatedMatch", 0) >= stop_at:
                    break
                if boundary and stop_updates is not None and session.metrics.get('rolloutUpdates', 0) >= stop_updates:
                    break
                if budget.exhausted:
                    break
                if not active:
                    for i, bridge in enumerate(session.bridges):
                        session.active[i] = session.new_worker(bridge)
                    active = list(zip(range(len(session.bridges)), session.bridges, session.active))
                pending = []
                count = len(active) if budget.remaining is None else min(len(active), budget.remaining)
                for i, bridge, worker in active[:count]:
                    obs = worker["observation"]
                    policy = worker["policies"][obs["seat"]]
                    if policy == "learner":
                        with torch.no_grad():
                            distribution = torch.distributions.Categorical(logits=session.network.logits(obs["observation"], obs["actionFeatures"]))
                            chosen = distribution.sample()
                            index = int(chosen)
                            worker["samples"].append({"observation": torch.tensor(obs["observation"]),
                                                      "actions": torch.tensor(obs["actionFeatures"]), "index": index,
                                                      "oldLogProb": float(distribution.log_prob(chosen)),
                                                      "oldValue": float(session.network.value(obs["observation"])),
                                                      "team": obs["team"]})
                        future = executor.submit(bridge.call, "step", index=index)
                    elif policy.startswith("snapshot-"):
                        if policy not in frozen:
                            with torch.random.fork_rng():
                                net = ActorCritic(learn.OBSERVATION_SIZE, learn.ACTION_SIZE)
                            net.load_state_dict(session.league[policy])
                            frozen[policy] = net
                        index = learn.choose(frozen[policy], obs["observation"], obs["actionFeatures"])
                        future = executor.submit(bridge.call, "step", index=index)
                    else:
                        future = executor.submit(bridge.call, "act", policy=policy)
                    pending.append((i, bridge, worker, future))
                # Commit every action before checkpointing or observing a new signal.
                for i, bridge, worker, future in pending:
                    result = future.result()
                    session.metrics["trainSteps"] += 1
                    worker["observation"] = result
                    if result["done"]:
                        budget.complete()
                        for sample in worker["samples"]:
                            session.rollout.append({**sample, "return": float(result["rewards"][sample["team"]])})
                        session.metrics["matches"] += 1
                        learner = worker["policies"].index("learner")
                        session.metrics["trainingWins"] = session.metrics.get("trainingWins", 0) + int(result["rewards"][learner % 2] > 0)
                        learn.record_contracts(session.metrics.setdefault("trainingContracts", {}), result["results"], learner % 2)
                        worker["samples"] = []
                draining = len(session.rollout) + sum(len(w["samples"]) for w in session.active) >= session.config["ppo"]["rolloutSize"]
                if not draining and not budget.exhausted and not learn.STOP and time.monotonic() < deadline:
                    for i, bridge, worker, _ in pending:
                        if worker["observation"]["done"]:
                            session.active[i] = session.new_worker(bridge)
                if time.monotonic() - last_save >= 30:
                    progress()
                    session.save()
                    frozen = {key: net for key, net in frozen.items() if key in session.league}
                    event_output({"event": "training-progress", "phase": "train", **session.metrics}, session.progress_json)
                    last_save = time.monotonic()
        finally:
            progress()
            session.save()
