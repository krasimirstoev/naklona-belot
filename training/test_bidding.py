import argparse
import copy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch
from torch import nn

import learn
from bidding import bidding_metrics, bid_index, reuse_teacher_data, validate_teacher_data
from cycle import Cycle
import ppo


def example(label=0, *, playing=False, forced=False, split='train'):
    obs = torch.zeros(learn.OBSERVATION_SIZE)
    obs[37 if playing else 36] = 1
    actions = torch.zeros(1 if forced else 3, learn.ACTION_SIZE)
    if playing:
        actions[0, 0] = 1
        actions[1, 1] = 1
        actions[2, 2] = 1
    else:
        actions[0, 32] = 1
        if not forced:
            actions[1, 33] = 1
            actions[2, 39] = 1
    seed = next(s for s in range(100) if ppo.match_split(s) == split)
    return obs, actions, label, seed


class BiddingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_balanced_batch_12_pass_6_calls_18_cards_4_scenarios(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1, bidding_profile='balanced-v1')
            try:
                session.dataset.extend([example(), example(1), example(2), example(playing=True), example(forced=True)])
                groups = ppo.teacher_groups(session.dataset, session.bidding_profile)
                scenario = [(example(playing=True)[0], example(playing=True)[1], [0])]
                batch = ppo.teacher_batch(session, groups, scenario)
                self.assertEqual(len(batch), 40)
                self.assertEqual(sum(bool(o[36]) for o, _, _ in batch), 18)
                bids = [(a, preferred[0]) for o, a, preferred in batch if o[36]]
                self.assertEqual(sum(bid_index(a, i) == 0 for a, i in bids), 12)
                self.assertEqual(sum(bid_index(a, i) != 0 for a, i in bids), 6)
                self.assertTrue(all(len(a) > 1 for a, _ in bids))
                self.assertEqual(len(groups['call']), 2)  # Contracts and doubles share the same pool.
                self.assertEqual(session.metrics['teacherSelection']['forcedExcluded'], 1)
                self.assertEqual(session.metrics['teacherSelection']['missingGroups'], [])
            finally:
                session.close()

    def test_missing_classes_use_only_available_examples_and_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1, bidding_profile='balanced-v1')
            try:
                scenarios = [(example(playing=True)[0], example(playing=True)[1], [0])]
                for dataset, absent in [([example(), example(playing=True)], 'call'),
                                        ([example(1), example(playing=True)], 'pass')]:
                    batch = ppo.teacher_batch(session, ppo.teacher_groups(dataset, 'balanced-v1'), scenarios)
                    self.assertEqual(len(batch), 40)
                    self.assertIn(absent, session.metrics['teacherSelection']['missingGroups'])
                with self.assertRaisesRegex(ValueError, 'with a choice'):
                    ppo.teacher_batch(session, ppo.teacher_groups([example(forced=True)], 'balanced-v1'), scenarios)
            finally:
                session.close()

    def test_triple_anchor_weights_only_bidding_and_pretrain_is_unweighted(self):
        network = ppo.ActorCritic(learn.OBSERVATION_SIZE, learn.ACTION_SIZE)
        bid = example(1)
        card = example(playing=True)
        bidding = ppo.teacher_loss(network, [(bid[0], bid[1], [bid[2]])])
        playing = ppo.teacher_loss(network, [(card[0], card[1], [card[2]])])
        batch = [(bid[0], bid[1], [bid[2]]), (card[0], card[1], [card[2]])]
        torch.testing.assert_close(ppo.teacher_loss(network, batch, bidding_weight=3), (3 * bidding + playing) / 2)
        torch.testing.assert_close(ppo.teacher_loss(network, batch), (bidding + playing) / 2)
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1, bidding_profile='balanced-v1')
            try:
                session.dataset.extend([bid, card])
                fixed_batch = batch * 20
                expected = ppo.teacher_loss(session.network, fixed_batch).detach()
                with patch('ppo.teacher_batch', return_value=fixed_batch), patch.object(session, 'update', side_effect=lambda loss, metric: session.metrics.update(pretrainUpdates=1)) as update:
                    session.pretrain(stop_at=1)
                self.assertEqual(update.call_count, 1)
                torch.testing.assert_close(update.call_args.args[0].detach(), expected)
            finally:
                session.close()

    def test_metrics_distinguish_misses_false_calls_wrong_contracts_and_doubles(self):
        result = bidding_metrics([(0, 0), (0, 1), (1, 0), (1, 1), (1, 2), (7, 7), (8, 7)])
        self.assertEqual([result[k] for k in ['correctPasses', 'missedCalls', 'callsInsteadOfPass', 'wrongCall', 'correctCalls']], [1, 1, 1, 2, 2])
        self.assertEqual(result['allCalls']['precision'], .4)
        self.assertEqual(result['allCalls']['recall'], .4)
        self.assertEqual(result['doubles']['precision'], .5)
        self.assertEqual(result['falseCallRate'], .5)
        empty = bidding_metrics([(0, 0)])
        self.assertIsNone(empty['doubles']['precision'])
        self.assertIsNone(empty['allCalls']['recall'])
        self.assertFalse(empty['diagnosticGoalsMet'])

    def test_ppo_uses_profile_specific_anchor_without_changing_other_coefficients(self):
        for profile, multiplier in [('legacy', 1), ('balanced-v1', 3)]:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                session = learn.Session(directory, workers=1, bidding_profile=profile)
                try:
                    session.dataset.extend([example(), example(1), example(playing=True)])
                    obs, actions, index, _ = example()
                    with torch.no_grad():
                        distribution = torch.distributions.Categorical(logits=session.network.logits(obs, actions))
                        sample = dict(observation=obs, actions=actions, index=index,
                                      oldLogProb=float(distribution.log_prob(torch.tensor(index))),
                                      oldValue=float(session.network.value(obs)), team=0)
                    session.rollout = [{**sample, 'return': 1.}, {**sample, 'return': -1.}]
                    with patch('ppo.teacher_loss', wraps=ppo.teacher_loss) as anchor:
                        self.assertTrue(ppo.optimize(session, session.training_scenarios(), float('inf')))
                    self.assertTrue(all(call.kwargs['bidding_weight'] == multiplier for call in anchor.call_args_list))
                    self.assertEqual(session.config['ppo']['teacherCoefficient'], .1)
                    self.assertEqual(session.config['ppo']['entropyCoefficient'], .01)
                    self.assertEqual(session.config['ppo']['clip'], .2)
                finally:
                    session.close()

    def test_diagnostics_cover_full_bidding_split_without_consuming_rng(self):
        dataset = [example()] * 150 + [example(1)] * 50 + [example(forced=True)] * 10
        network = SimpleNamespace(logits=lambda obs, actions: torch.zeros(len(actions)))
        session = SimpleNamespace(network=network, dataset=dataset, holdout=dataset, metrics={}, bidding_profile='balanced-v1')
        before = torch.get_rng_state().clone()
        ppo.diagnostics(session)
        torch.testing.assert_close(torch.get_rng_state(), before, rtol=0, atol=0)
        report = session.metrics['diagnostics']['holdout']['bidding']
        self.assertEqual(report['sampled'], 210)
        self.assertEqual(report['forced'], 10)
        self.assertEqual(report['decisions'], 200)
        self.assertEqual(report['missedCalls'], 50)
        self.assertEqual(report['allCalls']['recall'], 0)
        self.assertIsNone(report['allCalls']['precision'])

    def test_profile_persists_legacy_absence_is_supported_and_changes_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1, bidding_profile='balanced-v1')
            session.save()
            session.close()
            resumed = learn.Session(directory, workers=1)
            self.assertEqual(resumed.bidding_profile, 'balanced-v1')
            resumed.close()
            with self.assertRaisesRegex(ValueError, 'bidding profile'):
                learn.Session(directory, workers=1, bidding_profile='legacy')
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1)
            session.save()
            session.close()
            path = Path(directory) / 'checkpoint.pt'
            saved = torch.load(path, weights_only=False)
            saved['config'].pop('biddingProfile')
            torch.save(saved, path)
            resumed = learn.Session(directory, workers=1)
            self.assertEqual(resumed.bidding_profile, 'legacy')
            self.assertNotIn('biddingProfile', resumed.config)
            resumed.close()

    def test_reuse_rejects_changed_teachers_versions_and_missing_match_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1)
            try:
                source = dict(config=dict(session.config), dataset=[example()], holdout=[example(split='holdout')])
                validate_teacher_data(source, session.config)
                for key in ['referenceFingerprint', 'encodingVersion', 'scenarioDigest', 'algorithm']:
                    bad = copy.deepcopy(source)
                    bad['config'][key] = 'different'
                    with self.assertRaises(ValueError):
                        validate_teacher_data(bad, session.config)
                for bad in [dict(source, holdout=[example()]), dict(source, dataset=[example()[:3]]), dict(source, holdout=[])]:
                    with self.assertRaises(ValueError):
                        validate_teacher_data(bad, session.config)
                reuse_teacher_data(session, source)
                self.assertEqual(len(session.dataset), 1)
                self.assertEqual(len(session.holdout), 1)
                self.assertEqual(session.optimizer.state_dict()['state'], {})
            finally:
                session.close()

    def test_cycle_fork_reuses_data_without_source_mutation_or_old_work_state(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'source'
            args = argparse.Namespace(run=str(source), workers=1, teacher_examples=2, holdout_examples=1, pretrain_steps=2)
            controller = Cycle(args)
            controller.close()
            session = learn.Session(source, workers=1)
            session.dataset.extend([example(), example(1)])
            session.holdout.append(example(split='holdout'))
            session.metrics.update(matches=194, pretrainUpdates=1000)
            session.snapshot_network(baseline=True)
            session.save()
            session.close()
            before = learn.file_digest(source / 'checkpoint.pt')
            target = Path(root) / 'fork'
            fork = Cycle(argparse.Namespace(run=str(target), from_run=str(source), reuse_teacher_data=True, bidding_profile='balanced-v1'))
            try:
                checkpoint = torch.load(target / 'checkpoint.pt', weights_only=False)
                self.assertEqual(len(checkpoint['dataset']), 2)
                self.assertEqual(len(checkpoint['holdout']), 1)
                self.assertEqual(checkpoint['metrics']['matches'], 0)
                self.assertEqual(checkpoint['metrics']['pretrainUpdates'], 0)
                self.assertEqual(checkpoint['optimizer']['state'], {})
                self.assertEqual(checkpoint['environments'], {})
                self.assertEqual(checkpoint['rollout'], [])
                self.assertEqual(fork.state['origin']['metrics']['matches'], 194)
                self.assertTrue(fork.state['origin']['teacherDataReused'])
                fork.step(None)
                self.assertEqual(fork.state['phase'], 'pretrain')
                fork.step(None)
                self.assertEqual(fork.state['phase'], 'validation')
            finally:
                fork.close()
            self.assertEqual(learn.file_digest(source / 'checkpoint.pt'), before)
            with self.assertRaisesRegex(ValueError, 'Bidding profile changed'):
                Cycle(argparse.Namespace(run=str(target), bidding_profile='legacy'))
            with self.assertRaisesRegex(ValueError, 'requires --from-run'):
                Cycle(argparse.Namespace(run=str(Path(root) / 'invalid'), reuse_teacher_data=True))


if __name__ == '__main__':
    unittest.main()
