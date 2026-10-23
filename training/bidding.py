"""Teacher-relative bidding diagnostics and validated reuse of local teacher data."""
from __future__ import annotations

from contextlib import ExitStack
import copy
import fcntl
from pathlib import Path

import torch

PROFILES = ('legacy', 'balanced-v1')
BIDS = ['pass', 'C', 'D', 'H', 'S', 'NT', 'AT', 'contra', 'recontra']


def bid_index(actions, index):
    return int(actions[index, 32:41].argmax())


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def bidding_metrics(pairs):
    """Each pair is (teacher bid index, selected bid index), excluding forced turns."""
    pairs = list(pairs)
    result = {'decisions': len(pairs), 'correctPasses': 0, 'missedCalls': 0,
              'callsInsteadOfPass': 0, 'wrongCall': 0, 'correctCalls': 0}
    for teacher, selected in pairs:
        key = ('correctPasses' if teacher == selected == 0 else
               'correctCalls' if teacher == selected else
               'missedCalls' if selected == 0 else
               'callsInsteadOfPass' if teacher == 0 else 'wrongCall')
        result[key] += 1
    for name, kinds in [('allCalls', set(range(1, 9))), ('contracts', set(range(1, 7))), ('doubles', {7, 8})]:
        expected = sum(t in kinds for t, _ in pairs)
        predicted = sum(s in kinds for _, s in pairs)
        correct = sum(t == s and t in kinds for t, s in pairs)
        result[name] = {'expected': expected, 'predicted': predicted, 'correct': correct,
                        'precision': ratio(correct, predicted), 'recall': ratio(correct, expected)}
    pass_count = sum(t == 0 for t, _ in pairs)
    result['falseCallRate'] = ratio(result['callsInsteadOfPass'], pass_count)
    result['diagnosticGoalsMet'] = (
        result['allCalls']['recall'] is not None and result['allCalls']['recall'] >= .4
        and result['allCalls']['precision'] is not None and result['allCalls']['precision'] >= .85
        and result['falseCallRate'] is not None and result['falseCallRate'] <= .02)
    return result


def read_source(directory):
    """Read under the same locks as cycle; callers never mutate this checkpoint."""
    import learn
    directory = Path(directory).resolve()
    with ExitStack() as stack:
        for name in ['cycle.lock', 'session.lock']:
            lock = stack.enter_context((directory / name).open('a+'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        digest = learn.file_digest(directory / 'checkpoint.pt')
        checkpoint = torch.load(directory / 'checkpoint.pt', map_location='cpu', weights_only=False)
    return checkpoint, digest


def validate_teacher_data(checkpoint, config):
    """Do not reuse labels from another teacher/engine, encoding, or match split."""
    from ppo import match_split
    import learn
    source = checkpoint['config']
    if source.get('algorithm', 'dmc-v1') != 'ppo-v2' or config.get('algorithm') != 'ppo-v2':
        raise ValueError('Teacher data reuse requires PPO source and destination')
    for key in ['referenceFingerprint', 'encodingVersion', 'scenarioDigest']:
        if source.get(key) != config.get(key):
            raise ValueError(f'Teacher data reuse: incompatible {key}')
    seeds = {}
    for name, split in [('dataset', 'train'), ('holdout', 'holdout')]:
        examples = checkpoint.get(name, [])
        if not examples:
            raise ValueError(f'Teacher data reuse: missing {name}')
        seeds[name] = set()
        for example in examples:
            if len(example) != 4:
                raise ValueError('Teacher examples need whole-match provenance')
            obs, actions, index, seed = example
            if not isinstance(seed, int) or isinstance(seed, bool) or match_split(seed) != split:
                raise ValueError('Teacher example has an invalid match split')
            if not isinstance(obs, torch.Tensor) or tuple(obs.shape) != (learn.OBSERVATION_SIZE,) or not torch.isfinite(obs).all():
                raise ValueError('Invalid teacher observation')
            if (not isinstance(actions, torch.Tensor) or actions.ndim != 2 or actions.shape[1] != learn.ACTION_SIZE
                    or not isinstance(index, int) or not 0 <= index < len(actions) or not torch.isfinite(actions).all()):
                raise ValueError('Invalid teacher action features or label')
            seeds[name].add(seed)
    if not seeds['dataset'].isdisjoint(seeds['holdout']):
        raise ValueError('Teacher train/holdout match overlap')


def reuse_teacher_data(session, checkpoint):
    validate_teacher_data(checkpoint, session.config)
    session.dataset.extend(copy.deepcopy(checkpoint['dataset']))
    session.holdout.extend(copy.deepcopy(checkpoint['holdout']))
