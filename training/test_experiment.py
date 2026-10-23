import argparse
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch

import experiment
import learn


class ExperimentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_paired_confidence_uses_seed_differences(self):
        baseline = {'groups': [[1, 0, 1, 0]] * 20}
        self.assertEqual(experiment.paired_comparison(baseline, baseline)['meanDifference'], 0)
        better = experiment.paired_comparison(baseline, {'groups': [[1, 1, 1, 1]] * 20})
        self.assertEqual(better['lower'], .5)
        self.assertTrue(better['evidenceOfImprovement'])
        tiny = experiment.paired_comparison({'groups': [[0, 0, 0, 0]]}, {'groups': [[1, 1, 1, 1]]})
        self.assertFalse(tiny['evidenceOfImprovement'])
        self.assertFalse(tiny['enoughValidationSeeds'])
        self.assertIsNone(experiment.paired_comparison(baseline, {'groups': []}))

    def test_orchestration_pins_models_shares_seeds_and_has_no_activation(self):
        saved = {}
        namespaces = []
        class FakeSession:
            def __init__(self, path, _workers, _threads, _seed, algorithm):
                self.directory = path
                self.directory.mkdir(parents=True, exist_ok=True)
                self.algorithm = algorithm
                self.metrics = saved.get(algorithm, dict(pretrainUpdates=0))
                self.dataset = [0] * self.metrics.get('examples', 0)
                self.holdout = [0] * self.metrics.get('holdout', 0)
            def collect_or_train(self, phase, _minutes, stop_at=None, holdout_target=None):
                if phase == 'collect':
                    self.dataset = [0] * stop_at
                    self.holdout = [0] * (holdout_target or 0)
                    self.metrics.update(examples=len(self.dataset), holdout=len(self.holdout))
                else:
                    # Simulate consuming the arm budget without sleeping.
                    self.metrics['matches'] = 10
                self.save()
            def pretrain(self, _minutes, stop_at):
                self.metrics['pretrainUpdates'] = stop_at
                self.save()
            def snapshot_network(self, baseline=False):
                self.metrics['baseline'] = baseline
            def save(self):
                saved[self.algorithm] = self.metrics
                learn.atomic_json(self.directory / 'candidate.json', {'algorithm': self.algorithm, 'metrics': dict(self.metrics)})
            def close(self):
                pass
        def evaluate(args):
            self.assertTrue(args.full_validation)
            namespaces.append(args.namespace)
            report = {'complete': True, 'games': 4, 'wins': 2, 'confidence': {'mean': .5}, 'diagnosticOnly': True}
            learn.atomic_json(args.report, report)
            torch.save({'groups': [[1, 0, 1, 0]]}, args.report + '.progress.pt')
            return report
        # Every operation advances the virtual wall clock. No training or long wait.
        clock = iter(range(10000))
        with tempfile.TemporaryDirectory() as directory, patch('experiment.time.monotonic', side_effect=lambda: next(clock)), \
             patch('learn.Session', FakeSession), patch('learn.evaluate', side_effect=evaluate):
            args = argparse.Namespace(run=directory, minutes=100, arm_minutes=.2, teacher_examples=2,
                                      holdout_examples=1, pretrain_steps=1, validation_seeds=1)
            for _ in range(20):
                state = experiment.run(args)
                if state['stage'] == 'done':
                    break
            self.assertEqual(state['stage'], 'done')
            self.assertEqual(set(state['models']), {'dmc', 'bc', 'ppo'})
            self.assertEqual(len(set(namespaces)), 1)
            self.assertEqual(len(namespaces), 3)
            self.assertEqual(state['ppoVersusBC']['meanDifference'], 0)
            self.assertTrue(state['diagnosticsOnly'])
            self.assertTrue(all(Path(model['path']).exists() for model in state['models'].values()))
            self.assertFalse((Path(directory) / 'active.json').exists())


if __name__ == '__main__':
    unittest.main()
