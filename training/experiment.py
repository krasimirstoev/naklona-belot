"""Bounded, resumable three-arm comparison; never qualifies or activates a model."""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import time
import uuid

import torch

import learn
from budget import deadline_for
from cycle import immutable_copy

STAGES = ['dmc-collect', 'dmc-pretrain', 'dmc-train', 'dmc-evaluate',
          'ppo-collect', 'ppo-pretrain', 'bc-evaluate', 'ppo-train', 'ppo-evaluate', 'done']


def paired_comparison(baseline, candidate):
    """Resample paired seed differences; report uncertainty without qualification."""
    if not baseline['groups'] or len(baseline['groups']) != len(candidate['groups']):
        return None
    differences = [sum(c) / 4 - sum(b) / 4 for b, c in zip(baseline['groups'], candidate['groups'])]
    values = torch.tensor(differences, dtype=torch.float64)
    generator = torch.Generator().manual_seed(481516)
    samples = []
    for _ in range(20):
        indices = torch.randint(len(values), (100, len(values)), generator=generator)
        samples.append(values[indices].mean(1))
    bounds = torch.quantile(torch.cat(samples), torch.tensor([.025, .975], dtype=torch.float64)).tolist()
    enough_seeds = len(values) >= 20
    return {'meanDifference': float(values.mean()), 'lower': bounds[0], 'upper': bounds[1],
            'seeds': len(values), 'enoughValidationSeeds': enough_seeds,
            'evidenceOfImprovement': enough_seeds and bounds[0] > 0,
            'nextTrainingSeedIfInconclusive': 19 if enough_seeds and bounds[0] <= 0 <= bounds[1] else None}


def run(args):
    directory = Path(args.run).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'experiment.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / 'experiment.json'
        state = json.loads(path.read_text()) if path.exists() else None
        if state is None and any((directory / arm / 'checkpoint.pt').exists() for arm in ['dmc', 'ppo']):
            raise ValueError('Experiment state is missing; use a fresh directory')
        defaults = dict(arm_minutes=180., teacher_examples=20000, holdout_examples=5000,
                        pretrain_steps=1000, validation_seeds=20, seed=7, workers=2, threads=2)
        config = {key: getattr(args, key, None) if getattr(args, key, None) is not None else
                  state['config'][key] if state else default for key, default in defaults.items()}
        with learn.Bridge() as bridge:
            config['referenceFingerprint'] = bridge.info['referenceFingerprint']
            config['scenarioDigest'] = bridge.info['scenarioDigest']
        if state and state['config'] != config:
            raise ValueError('Experiment configuration changed; choose a new directory')
        if not 1 <= config['teacher_examples'] <= 20000 or not 1 <= config['holdout_examples'] <= 5000:
            raise ValueError('teacher-examples must be 1..20000 and holdout-examples 1..5000')
        if config['arm_minutes'] <= 0 or min(config['pretrain_steps'], config['validation_seeds']) < 1:
            raise ValueError('Experiment budgets and thresholds must be positive')
        state = state or dict(version=1, config=config, stage='dmc-collect', namespace='validation-v1:' + uuid.uuid4().hex,
                              seconds={'dmc': 0., 'ppo': 0.}, reports={}, models={}, diagnosticsOnly=True)
        deadline = deadline_for(args.minutes)

        def save():
            learn.atomic_json(path, state)

        def advance():
            state['stage'] = STAGES[STAGES.index(state['stage']) + 1]
            save()

        def freeze(name, source):
            if name in state['models']:
                pinned = state['models'][name]
                if learn.file_digest(pinned['path']) != pinned['sha256']:
                    raise ValueError('Pinned comparison model changed')
                return
            digest = learn.file_digest(source)
            destination = directory / 'candidates' / digest / 'model.json'
            immutable_copy(source, destination)
            state['models'][name] = dict(path=str(destination), sha256=digest)
            save()

        save()
        while not learn.STOP and time.monotonic() < deadline and state['stage'] != 'done':
            stage = state['stage']
            print(f'Сравнение: {stage}; DMC {state["seconds"]["dmc"]:.1f}s, PPO {state["seconds"]["ppo"]:.1f}s.', flush=True)
            if stage.endswith('evaluate'):
                name = stage.split('-')[0]
                report_path = directory / f'{name}-validation.json'
                report = learn.evaluate(argparse.Namespace(model=state['models'][name]['path'], report=str(report_path),
                    split='validation', namespace=state['namespace'], partner='hard', seeds=config['validation_seeds'],
                    minutes=max(.000001, (deadline - time.monotonic()) / 60), quiet=True,
                    progress=True, progress_json=False, full_validation=True))
                state['reports'][name] = report
                save()
                if not report['complete']:
                    break
                advance()
                continue
            arm, phase = stage.split('-')
            remaining = config['arm_minutes'] * 60 - state['seconds'][arm]
            if remaining <= 0:
                if phase != 'train':
                    state['blockedReason'] = f'{arm}: preparation exceeded the arm budget; use a new experiment with a larger arm budget'
                    save()
                    break
                freeze(arm, directory / arm / 'candidate.json')
                advance()
                continue
            start = time.monotonic()
            session = learn.Session(directory / arm, config['workers'], config['threads'], config['seed'],
                                    'dmc-v1' if arm == 'dmc' else 'ppo-v2')
            session.progress_json = False
            try:
                minutes = max(.000001, min(remaining, deadline - time.monotonic()) / 60)
                if phase == 'collect':
                    target = min(10000, config['teacher_examples']) if arm == 'dmc' else config['teacher_examples']
                    session.collect_or_train('collect', minutes, stop_at=target,
                                             holdout_target=config['holdout_examples'] if arm == 'ppo' else None)
                    complete = len(session.dataset) >= target and (arm == 'dmc' or len(session.holdout) >= config['holdout_examples'])
                elif phase == 'pretrain':
                    session.pretrain(minutes, stop_at=config['pretrain_steps'])
                    complete = session.metrics['pretrainUpdates'] >= config['pretrain_steps']
                    if complete and arm == 'ppo':
                        session.snapshot_network(baseline=True)
                        session.save()
                        freeze('bc', directory / arm / 'candidate.json')
                else:
                    session.collect_or_train('train', minutes)
                    complete = False  # Self-play runs to its fixed wall-time budget.
                state.setdefault('metrics', {})[arm] = dict(session.metrics)
            finally:
                session.close()
                state['seconds'][arm] += time.monotonic() - start
                save()
            if complete:
                advance()
            elif state['seconds'][arm] < config['arm_minutes'] * 60:
                break
        if state['stage'] == 'done':
            snapshots = {name: torch.load(str(directory / f'{name}-validation.json') + '.progress.pt',
                                              map_location='cpu', weights_only=False) for name in ['bc', 'ppo']}
            state['ppoVersusBC'] = paired_comparison(snapshots['bc'], snapshots['ppo'])
            if state['ppoVersusBC']:
                updates = state.get('metrics', {}).get('ppo', {}).get('rolloutUpdates', 0)
                state['ppoVersusBC']['completedRolloutUpdates'] = updates
                if not updates:
                    state['ppoVersusBC'].update(evidenceOfImprovement=False, nextTrainingSeedIfInconclusive=None)
            save()
        print(json.dumps({'experiment': str(path), 'stage': state['stage'], 'seconds': state['seconds'],
                          'blockedReason': state.get('blockedReason'), 'ppoVersusBC': state.get('ppoVersusBC')}, ensure_ascii=False), flush=True)
        return state
