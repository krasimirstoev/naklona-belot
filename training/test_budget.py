import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import torch
from budget import GameBudget, validation_rejection
from learn import Bridge, Network, Session, atomic_json, evaluate, export_model, ROOT


class BudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_exact_early_rejection_bound_and_final_checks_unchanged(self):
        for seeds in [1, 2, 20]:
            total = seeds * 4
            for played in range(total + 1):
                for wins in range(played + 1):
                    results = [1] * wins + [0] * (played - wins)
                    state = {'groups': [results[i:i+4] for i in range(0, played//4*4, 4)], 'current': results[played//4*4:]}
                    rejected = validation_rejection(state, 'validation', seeds)
                    self.assertEqual(bool(rejected), played < total and wins + total - played <= total/2)
                    self.assertIsNone(validation_rejection(state, 'final', seeds))
        self.assertIsNotNone(validation_rejection({'groups': [[0]*4]*10, 'current': [1]}, 'validation', 20))
        self.assertIsNone(validation_rejection({'groups': [[0]*4]*9, 'current': [1, 0, 0]}, 'validation', 20))

    def test_budget_refuses_invalid_limits_and_overshoot(self):
        for bad in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                GameBudget(bad)
        budget = GameBudget(1)
        budget.complete()
        self.assertTrue(budget.exhausted)
        with self.assertRaises(ValueError):
            budget.complete()

    def test_real_teacher_and_selfplay_game_limits_resume_without_worker_overshoot(self):
        for mode, metric in [('collect', 'collectMatches'), ('train', 'matches')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                for expected in [1, 2]:
                    session = Session(directory, algorithm="dmc-v1", workers=2)
                    original = session.new_worker
                    def medium_worker(bridge):
                        worker = original(bridge)
                        worker['policies'] = ['medium'] * 4
                        return worker
                    try:
                        session.metrics['pretrainUpdates'] = 1
                        with patch.object(session, 'new_worker', side_effect=medium_worker):
                            budget = GameBudget(1)
                            session.collect_or_train(mode, game_budget=budget)
                        self.assertEqual(budget.used, 1)
                        self.assertEqual(session.metrics[metric], expected)
                        self.assertEqual(session.bridges[1].call('snapshot')['game']['revision'], 0)
                        self.assertEqual(len(session.replay), 0)  # no learner samples, no invented reward
                    finally:
                        session.close()

    def test_restored_impossible_candidate_is_rejected_without_playing_or_activation(self):
        with tempfile.TemporaryDirectory() as directory, Bridge() as bridge:
            path = Path(directory)
            model, report = path / 'model.json', path / 'report.json'
            atomic_json(model, export_model(Network()))
            args = argparse.Namespace(model=str(model), report=str(report), split='validation', partner='hard', seeds=20,
                                      minutes=.00001, quiet=True)
            evaluate(args)
            progress = Path(str(report) + '.progress.pt')
            saved = torch.load(progress, weights_only=False)
            saved['groups'] = [[0, 0, 0, 0]] * 10
            saved['current'] = [0, 1]
            # Snapshot still represents the actual unfinished game; it must not gain a reward.
            torch.save(saved, progress)
            args.minutes = None
            args.game_budget = GameBudget(20)
            with patch.object(Bridge, 'call', autospec=True, side_effect=Bridge.call) as calls:
                result = evaluate(args)
            self.assertFalse(any(c.args[1] == 'act' for c in calls.call_args_list))
            self.assertTrue(result['earlyRejected'])
            self.assertFalse(result['complete'])
            self.assertEqual(result['games'], 42)
            self.assertEqual(result['earlyRejection']['maxPossibleWinRate'], 39/80)
            self.assertEqual(args.game_budget.used, 0)
            self.assertFalse(Path(str(model)+'.approval.json').exists())
            self.assertEqual(evaluate(args)['earlyRejection'], result['earlyRejection'])

    def test_shell_wrapper_forwards_game_limit_and_custom_run_from_any_directory(self):
        with tempfile.TemporaryDirectory(prefix='belot wrapper ') as directory:
            fake = Path(directory) / 'fake python'
            fake.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@"\n')
            fake.chmod(0o755)
            env = {**os.environ, 'BELOT_TRAINING_PYTHON': str(fake)}
            def run(*args):
                return subprocess.check_output([str(ROOT / 'scripts/train-bots.sh'), *args], cwd=directory, env=env, text=True).splitlines()
            output = run('--games', '20')
            self.assertEqual(output, [str(ROOT), 'training/learn.py', 'cycle', '--run', 'data/quality/ppo-v2-1', '--games', '20'])
            output = run('--run', 'custom path', '--games', '2')
            self.assertEqual(output[-4:], ['--run', 'custom path', '--games', '2'])


if __name__ == '__main__':
    unittest.main()
