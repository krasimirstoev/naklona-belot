import argparse
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch

import learn
import experiment
from cycle import Cycle
from test_bidding import example


class BiddingExperimentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def source(self, root):
        source = Path(root) / 'source'
        cycle = Cycle(argparse.Namespace(run=str(source), workers=1))
        cycle.close()
        session = learn.Session(source, workers=1)
        try:
            session.dataset.extend([example(), example(1), example(playing=True)])
            session.holdout.extend([example(split='holdout'), example(1, split='holdout')])
            session.snapshot_network(baseline=True)
            session.metrics.update(matches=194, pretrainUpdates=1000)
            session.save()
        finally:
            session.close()
        return source

    def evaluator(self, namespaces, *, tied=False):
        def evaluate(args):
            self.assertTrue(args.full_validation)
            self.assertEqual(args.split, 'validation')
            self.assertEqual(args.partner, 'hard')
            namespaces.append(args.namespace)
            # Identify the pinned model's profile, not its path/digest.
            import json
            profile = json.loads(Path(args.model).read_text())['metadata']['config']['biddingProfile']
            group = [1, 0, 1, 0] if tied or profile == 'legacy' else [1, 1, 1, 0]
            groups = [group] * args.seeds
            report = dict(complete=True, games=4 * args.seeds, wins=sum(group) * args.seeds, diagnosticOnly=True)
            learn.atomic_json(args.report, report)
            torch.save({'groups': groups}, args.report + '.progress.pt')
            return report
        return evaluate

    def train(self, owner, mode, minutes=None, stop_at=None, game_budget=None, holdout_target=None, stop_updates=None):
        self.assertEqual(mode, 'train')
        self.assertEqual(stop_updates, 10)
        owner.metrics.update(rolloutUpdates=stop_updates, matches=200)
        bidding = owner.metrics['diagnostics']['holdout']['bidding']
        bidding['allCalls'].update(recall=.6 if owner.bidding_profile == 'balanced-v1' else .1, precision=.9)
        bidding.update(falseCallRate=.01, diagnosticGoalsMet=owner.bidding_profile == 'balanced-v1')
        owner.save()

    def test_comparison_uses_identical_bc_data_and_fresh_optimizer_and_pins_four_models(self):
        with tempfile.TemporaryDirectory() as root:
            source = self.source(root)
            original_digest = learn.file_digest(source / 'checkpoint.pt')
            directory = Path(root) / 'experiment'
            starts, namespaces = [], []
            pretrain = learn.Session.pretrain
            def observe(owner, minutes=None, stop_at=None):
                starts.append((owner.bidding_profile, owner.network.encoder[0].weight.detach().clone(),
                               len(owner.dataset), len(owner.holdout), len(owner.optimizer.state_dict()['state'])))
                return pretrain(owner, minutes, stop_at)
            with patch.object(learn.Session, 'pretrain', observe), \
                 patch.object(learn.Session, 'collect_or_train', autospec=True, side_effect=self.train), \
                 patch('learn.evaluate', side_effect=self.evaluator(namespaces)), contextlib.redirect_stdout(io.StringIO()):
                result = experiment.run(argparse.Namespace(run=str(directory), comparison='bidding', from_run=str(source),
                                                          minutes=10, pretrain_steps=2, workers=1))
            self.assertEqual(result['stage'], 'done')
            self.assertEqual(result['recommendedProfile'], 'balanced-v1')
            self.assertEqual(len(namespaces), 4)
            self.assertEqual(len(set(namespaces)), 1)
            self.assertEqual([v[0] for v in starts], ['legacy', 'balanced-v1'])
            torch.testing.assert_close(starts[0][1], starts[1][1], rtol=0, atol=0)
            self.assertEqual([v[2:] for v in starts], [(3, 2, 0), (3, 2, 0)])
            self.assertEqual(len(result['rounds']['7']['models']), 4)
            self.assertEqual(result['rounds']['7']['budgetExhausted'], {})
            self.assertFalse(list(directory.rglob('*.approval.json')))
            self.assertFalse((directory / 'active.json').exists())
            self.assertEqual(learn.file_digest(source / 'checkpoint.pt'), original_digest)
            # A completed comparison resumes without training or evaluating again.
            with patch('learn.evaluate') as evaluate, contextlib.redirect_stdout(io.StringIO()):
                resumed = experiment.run(argparse.Namespace(run=str(directory), minutes=.01))
            evaluate.assert_not_called()
            self.assertEqual(resumed['recommendedProfile'], 'balanced-v1')

    def test_inconclusive_full_comparison_repeats_once_with_seed_19(self):
        with tempfile.TemporaryDirectory() as root:
            source = self.source(root)
            namespaces = []
            with patch.object(learn.Session, 'collect_or_train', autospec=True, side_effect=self.train), \
                 patch('learn.evaluate', side_effect=self.evaluator(namespaces, tied=True)), contextlib.redirect_stdout(io.StringIO()):
                result = experiment.run(argparse.Namespace(run=str(Path(root) / 'experiment'), comparison='bidding',
                    from_run=str(source), minutes=10, pretrain_steps=1, workers=1))
            self.assertEqual(result['stage'], 'done')
            self.assertEqual(set(result['rounds']), {'7', '19'})
            self.assertEqual(len(namespaces), 8)
            self.assertEqual(len(set(namespaces)), 1)
            self.assertIsNone(result['recommendedProfile'])
            self.assertIsNone(result['rounds']['19']['summary']['comparisons']['ppo']['nextTrainingSeedIfInconclusive'])

    def test_preparation_budget_exhaustion_is_explicit_and_never_evaluates_unprepared_actor(self):
        with tempfile.TemporaryDirectory() as root:
            source = self.source(root)
            with patch('learn.evaluate') as evaluate, contextlib.redirect_stdout(io.StringIO()):
                result = experiment.run(argparse.Namespace(run=str(Path(root) / 'experiment'), comparison='bidding',
                    from_run=str(source), minutes=2, pretrain_steps=200, arm_minutes=.000001, workers=1))
            self.assertEqual(result['stage'], 'done')
            self.assertEqual(result['rounds']['7']['budgetExhausted'], {'legacy': 'pretrain', 'balanced-v1': 'pretrain'})
            self.assertFalse(result['rounds']['7']['summary']['trainingTargetsMet'])
            self.assertEqual(result['rounds']['7']['models'], {})
            evaluate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
