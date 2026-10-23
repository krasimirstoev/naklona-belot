"""Compare bidding profiles from one immutable BC network and teacher split.

All reports are exploratory. This runner never activates a model or changes defaults.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import time
import uuid

import torch

import learn
from bidding import PROFILES, read_source, reuse_teacher_data, validate_teacher_data
from budget import deadline_for
from cycle import immutable_copy
from experiment import paired_comparison
from ppo import diagnostics

STAGES = [(profile, phase) for profile in PROFILES for phase in ['pretrain', 'bc-evaluate', 'train', 'ppo-evaluate']]


def new_round():
    return dict(stage=0, seconds={p: 0. for p in PROFILES}, models={}, reports={}, metrics={}, budgetExhausted={})


def atomic_checkpoint(path, value):
    temporary = path.with_suffix('.tmp')
    torch.save(value, temporary)
    with temporary.open('rb') as stream:
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def round_summary(directory, result, config):
    comparisons = {}
    for phase in ['bc', 'ppo']:
        names = [f'{profile}-{phase}' for profile in PROFILES]
        if not all(result['reports'].get(name, {}).get('complete') for name in names):
            continue
        states = [torch.load(directory / f'{name}-validation.json.progress.pt', map_location='cpu', weights_only=False)
                  for name in names]
        comparisons[phase] = paired_comparison(*states)
    complete_training = all(result['metrics'].get(p, {}).get('pretrainUpdates', 0) >= config['pretrain_steps']
                            and result['metrics'].get(p, {}).get('rolloutUpdates', 0) >= config['rollout_updates'] for p in PROFILES)
    balanced = result['models'].get('balanced-v1-ppo', {}).get('bidding', {})
    control = result['models'].get('legacy-ppo', {}).get('bidding', {})
    recall, old_recall = balanced.get('allCalls', {}).get('recall'), control.get('allCalls', {}).get('recall')
    improved_diagnostics = bool(balanced.get('diagnosticGoalsMet') and recall is not None
                                and old_recall is not None and recall > old_recall)
    game = comparisons.get('ppo')
    return {'comparisons': comparisons, 'trainingTargetsMet': complete_training,
            'diagnosticsImproved': improved_diagnostics,
            'promising': bool(complete_training and improved_diagnostics and game and game['evidenceOfImprovement'])}


def run(args):
    directory = Path(args.run).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'experiment.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / 'experiment.json'
        state = json.loads(path.read_text()) if path.exists() else None
        source = getattr(args, 'from_run', None) or (state['config']['source'] if state else None)
        if not source:
            raise ValueError('Bidding comparison needs --from-run <PPO cycle> on first invocation')
        defaults = dict(arm_minutes=180., pretrain_steps=200, rollout_updates=10, validation_seeds=20,
                        seed=7, workers=2, threads=2)
        config = {key: getattr(args, key, None) if getattr(args, key, None) is not None else
                  state['config'][key] if state else default for key, default in defaults.items()}
        config.update(source=str(Path(source).resolve()), comparison='bidding')
        with learn.Bridge() as bridge:
            config.update(referenceFingerprint=bridge.info['referenceFingerprint'], scenarioDigest=bridge.info['scenarioDigest'])
        if state and state['config'] != config:
            raise ValueError('Bidding experiment configuration changed; choose a new directory')
        if (not math.isfinite(config['arm_minutes']) or not 0 < config['arm_minutes'] <= 180
                or any(not isinstance(config[k], int) or config[k] < 1 for k in ['pretrain_steps', 'rollout_updates', 'validation_seeds'])
                or not 1 <= config['workers'] <= 8 or not 1 <= config['threads'] <= 8 or not 0 <= config['seed'] < 2**31):
            raise ValueError('Invalid bidding experiment budget, threshold or CPU configuration')
        if any(getattr(args, key, None) is not None for key in ['teacher_examples', 'holdout_examples']):
            raise ValueError('Bidding comparison reuses the full source teacher data; omit data collection thresholds')
        source_path = directory / 'source.pt'
        if state is None:
            if any((directory / f'seed-{config["seed"]}' / profile / 'checkpoint.pt').exists() for profile in PROFILES):
                raise ValueError('Experiment state is missing; choose a fresh directory')
            checkpoint, digest = read_source(config['source'])
            validate_teacher_data(checkpoint, {**config, 'algorithm': 'ppo-v2', 'encodingVersion': learn.ENCODING_VERSION})
            initial = checkpoint.get('league', {}).get('snapshot-bc')
            if initial is None:
                raise ValueError('Source PPO cycle has no snapshot-bc; finish initial imitation first')
            # Pin once: subsequent sessions and seed-19 repeats do not reread a changing source.
            package = dict(config=checkpoint['config'], dataset=checkpoint['dataset'], holdout=checkpoint['holdout'], network=initial)
            atomic_checkpoint(source_path, package)
            state = dict(version=1, config=config, sourceCheckpointSha256=digest, sourceSha256=learn.file_digest(source_path),
                         namespace='validation-v1:' + uuid.uuid4().hex, currentSeed=config['seed'],
                         rounds={str(config['seed']): new_round()}, stage='running', diagnosticOnly=True,
                         recommendedProfile=None)
            learn.atomic_json(path, state)
            del checkpoint, package
        if learn.file_digest(source_path) != state['sourceSha256']:
            raise ValueError('Pinned teacher source changed')
        deadline = deadline_for(args.minutes)

        def save():
            learn.atomic_json(path, state)

        def freeze(result, name, actor_path, round_directory):
            if name in result['models']:
                pinned = result['models'][name]
                if learn.file_digest(pinned['path']) != pinned['sha256']:
                    raise ValueError('Pinned bidding model changed')
                return
            digest = learn.file_digest(actor_path)
            destination = round_directory / 'candidates' / digest / 'model.json'
            immutable_copy(actor_path, destination)
            actor = json.loads(destination.read_text())
            result['models'][name] = dict(path=str(destination), sha256=digest,
                                         bidding=actor['metadata']['metrics'].get('diagnostics', {}).get('holdout', {}).get('bidding', {}))
            save()

        while not learn.STOP and time.monotonic() < deadline and state['stage'] != 'done':
            seed = state['currentSeed']
            result = state['rounds'][str(seed)]
            round_directory = directory / f'seed-{seed}'
            round_directory.mkdir(parents=True, exist_ok=True)
            if result['stage'] == len(STAGES):
                result['summary'] = round_summary(round_directory, result, config)
                if seed == 19:
                    for comparison in result['summary']['comparisons'].values():
                        if comparison:
                            comparison['nextTrainingSeedIfInconclusive'] = None
                game = result['summary']['comparisons'].get('ppo')
                inconclusive = bool(game and game['enoughValidationSeeds'] and game['lower'] <= 0 <= game['upper'])
                if result['summary']['trainingTargetsMet'] and inconclusive and seed != 19:
                    state.update(currentSeed=19)
                    state['rounds']['19'] = new_round()
                    save()
                    continue
                # Repetition must support the same direction; a negative first result is not discarded.
                supported = all(r.get('summary', {}).get('diagnosticsImproved') and
                                r.get('summary', {}).get('comparisons', {}).get('ppo', {}).get('meanDifference', -1) >= 0
                                for r in state['rounds'].values())
                state.update(stage='done', recommendedProfile='balanced-v1' if result['summary']['promising'] and supported else None)
                save()
                break
            profile, phase = STAGES[result['stage']]
            print(f'Наддаване: seed {seed}; {profile}/{phase}; използвани {result["seconds"][profile]:.1f}s.', flush=True)
            if phase.endswith('evaluate'):
                name = f'{profile}-{phase.split("-")[0]}'
                if name not in result['models']:
                    result['stage'] += 1
                    save()
                    continue
                report_path = round_directory / f'{name}-validation.json'
                report = learn.evaluate(argparse.Namespace(model=result['models'][name]['path'], report=str(report_path),
                    split='validation', namespace=state['namespace'], partner='hard', seeds=config['validation_seeds'],
                    minutes=max(.000001, (deadline - time.monotonic()) / 60), quiet=True,
                    progress=True, progress_json=False, full_validation=True))
                result['reports'][name] = report
                save()
                if not report['complete']:
                    break
                result['stage'] += 1
                save()
                continue
            remaining = config['arm_minutes'] * 60 - result['seconds'][profile]
            arm_directory = round_directory / profile
            if remaining <= 0:
                result['budgetExhausted'][profile] = phase
                # Export only a policy at a completed optimization boundary, never a partial actor.
                if phase == 'train' and (arm_directory / 'candidate.json').exists():
                    freeze(result, f'{profile}-ppo', arm_directory / 'candidate.json', round_directory)
                result['stage'] += 4 if phase == 'pretrain' else 1
                save()
                continue
            started = time.monotonic()
            session = learn.Session(arm_directory, config['workers'], config['threads'], seed, 'ppo-v2', profile)
            session.progress_json = False
            try:
                if not session.path.exists():
                    package = torch.load(source_path, map_location='cpu', weights_only=False)
                    reuse_teacher_data(session, package)
                    session.network.load_state_dict(package['network'])
                    session.snapshot_network(baseline=True)
                    diagnostics(session)
                    session.save()
                    del package
                minutes = max(.000001, min(remaining, deadline - time.monotonic()) / 60)
                if phase == 'pretrain':
                    session.pretrain(minutes, stop_at=config['pretrain_steps'])
                    complete = session.metrics['pretrainUpdates'] >= config['pretrain_steps']
                    if complete:
                        freeze(result, f'{profile}-bc', arm_directory / 'candidate.json', round_directory)
                else:
                    session.collect_or_train('train', minutes, stop_updates=config['rollout_updates'])
                    complete = session.metrics.get('rolloutUpdates', 0) >= config['rollout_updates']
                    if complete:
                        freeze(result, f'{profile}-ppo', arm_directory / 'candidate.json', round_directory)
                result['metrics'][profile] = dict(session.metrics)
            finally:
                session.close()
                result['seconds'][profile] += time.monotonic() - started
                save()
            if complete:
                result['stage'] += 1
                save()
            else:
                # Deadline/interrupt is resumable; reaching the arm cap is handled on the next iteration.
                if result['seconds'][profile] < config['arm_minutes'] * 60:
                    break
        print(json.dumps({'experiment': str(path), 'stage': state['stage'], 'seed': state['currentSeed'],
                          'recommendedProfile': state['recommendedProfile'],
                          'rounds': {k: r.get('summary', {'stage': r['stage'], 'budgetExhausted': r['budgetExhausted']})
                                     for k, r in state['rounds'].items()}}, ensure_ascii=False), flush=True)
        return state
