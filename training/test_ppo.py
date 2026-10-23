import argparse
import copy
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import torch

import learn
from budget import GameBudget
from cycle import Cycle
import ppo


class PPOTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def example(self, bridge, seed=7):
        obs = bridge.call('reset', namespace='test-v1', seed=seed)
        return (torch.tensor(obs['observation']), torch.tensor(obs['actionFeatures']), 0, seed)

    def sample(self, example, network, result=1.):
        obs, actions, index, *_ = example
        with torch.no_grad():
            distribution = torch.distributions.Categorical(logits=network.logits(obs, actions))
            return dict(observation=obs, actions=actions, index=index, team=0,
                        oldLogProb=float(distribution.log_prob(torch.tensor(index))),
                        oldValue=float(network.value(obs)), **{'return': result})

    def test_both_heads_python_typescript_parity_legal_choice_and_actor_only_export(self):
        network = ppo.ActorCritic(learn.OBSERVATION_SIZE, learn.ACTION_SIZE)
        artifact = learn.export_model(network)
        self.assertEqual(artifact['formatVersion'], 2)
        self.assertNotIn('valueHead', artifact)
        with learn.Bridge() as bridge, tempfile.TemporaryDirectory() as directory:
            first = bridge.call('reset', namespace='test-v1', seed=13)
            examples = [dict(observation=first['observation'], actionFeatures=first['actionFeatures'])]
            examples.extend(bridge.call('trainingScenarios')['examples'])
            for example in examples:
                obs, actions = example['observation'], example['actionFeatures']
                with torch.no_grad():
                    expected = network.logits(obs, actions)
                    torch.testing.assert_close(network(learn.inputs(obs, actions)), expected)
                actual = bridge.call('score', model=artifact, observation=obs, actions=actions)['scores']
                torch.testing.assert_close(torch.tensor(actual), expected, atol=1e-5, rtol=1e-5)
                self.assertEqual(learn.choose(network, obs, actions), max(range(len(actual)), key=actual.__getitem__))
            model = Path(directory) / 'model.json'
            learn.atomic_json(model, artifact)
            bridge.call('loadModel', path=str(model))
            bridge.call('reset', namespace='test-v1', seed=13)
            recommendation = bridge.call('recommend', policy='model')
            self.assertTrue(0 <= recommendation['index'] < len(first['actions']))
            for key in ['actionEncoder', 'biddingHead', 'playingHead']:
                broken = copy.deepcopy(artifact)
                broken[key][0]['bias'][0] = 'invalid'
                with self.assertRaises(ValueError):
                    bridge.call('score', model=broken, observation=first['observation'], actions=first['actionFeatures'])

    def test_policy_clipping_and_advantage_direction(self):
        old = torch.tensor([0., 0.])
        advantage = torch.tensor([1., -1.])
        logs = torch.tensor([0., 0.], requires_grad=True)
        ppo.policy_loss(logs, old, advantage).backward()
        self.assertLess(float(logs.grad[0]), 0)
        self.assertGreater(float(logs.grad[1]), 0)
        torch.testing.assert_close(ppo.policy_loss(torch.tensor([2., -2.]), old, advantage), torch.tensor(-.2))
        distribution = torch.distributions.Categorical(logits=torch.tensor([1., 3., -1.]))
        torch.testing.assert_close(distribution.probs.sum(), torch.tensor(1.))
        self.assertTrue(torch.all(distribution.probs > 0))

    def test_teacher_does_not_train_value_head_and_value_does_not_train_policy_heads(self):
        network = ppo.ActorCritic(learn.OBSERVATION_SIZE, learn.ACTION_SIZE)
        with learn.Bridge() as bridge:
            obs, actions, index, _ = self.example(bridge)
        ppo.teacher_loss(network, [(obs, actions, [index])]).backward()
        self.assertTrue(all(p.grad is None for p in network.value_head.parameters()))
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for p in network.bidding_head.parameters()))
        network.zero_grad(set_to_none=True)
        network.value(obs).square().backward()
        self.assertTrue(all(p.grad is None for head in [network.bidding_head, network.playing_head, network.action_encoder] for p in head.parameters()))

    def test_match_split_balanced_teacher_batches_and_holdout_isolation(self):
        self.assertEqual([ppo.match_split(i) for i in range(100)], [ppo.match_split(i) for i in range(100)])
        self.assertEqual(set(ppo.match_split(i) for i in range(100)), {'train', 'holdout'})
        with tempfile.TemporaryDirectory() as directory, learn.Bridge() as bridge:
            session = learn.Session(directory, workers=1)
            try:
                bidding = self.example(bridge)
                scenario = bridge.call('trainingScenarios')['examples'][0]
                playing = (torch.tensor(scenario['observation']), torch.tensor(scenario['actionFeatures']), scenario['preferred'][0], 2)
                session.dataset.extend([bidding, playing])
                session.holdout.append((*bidding[:3], 999))
                batch = ppo.teacher_batch(session, ppo.teacher_groups(session.dataset), session.training_scenarios())
                self.assertEqual(sum(bool(obs[36]) for obs, _, _ in batch), 18)
                self.assertEqual(len(batch), 40)
                holdout_before = list(session.holdout)
                session.pretrain(stop_at=1)
                self.assertEqual(session.metrics['pretrainNaturalExamples'], 36)
                self.assertEqual(session.metrics['pretrainScenarioExamples'], 4)
                self.assertIs(session.holdout[0], holdout_before[0])
                self.assertEqual(session.metrics['diagnostics']['holdout']['bidding']['sampled'], 1)
            finally:
                session.close()

    def test_collection_labels_medium_moves_with_hard_teacher_and_persists_whole_match_split(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=2, seed=4)
            original_worker, original_call = session.new_worker, learn.Bridge.call
            recommendations = []
            def medium_worker(bridge):
                worker = original_worker(bridge)
                worker['policies'] = ['medium'] * 4
                return worker
            def call(bridge, command, **kwargs):
                if command == 'recommend':
                    recommendations.append(kwargs['policy'])
                return original_call(bridge, command, **kwargs)
            try:
                with patch.object(session, 'new_worker', side_effect=medium_worker), patch.object(learn.Bridge, 'call', call):
                    session.collect_or_train('collect', stop_at=1, holdout_target=1)
                self.assertEqual(recommendations.count('hard'), 2)
                self.assertEqual(recommendations.count('medium'), 2)
                self.assertEqual(len(session.dataset), 1)
                self.assertEqual(len(session.holdout), 1)
                self.assertTrue({s[3] for s in session.dataset}.isdisjoint({s[3] for s in session.holdout}))
                splits = [(w['matchSeed'], w['split']) for w in session.active]
            finally:
                session.close()
            resumed = learn.Session(directory, workers=2, seed=4)
            try:
                resumed.start('collect')
                self.assertEqual([(w['matchSeed'], w['split']) for w in resumed.active], splits)
                self.assertTrue(all(ppo.match_split(seed) == split for seed, split in splits))
            finally:
                resumed.close()

    def test_checkpoint_without_algorithm_remains_dmc(self):
        with tempfile.TemporaryDirectory() as directory:
            session = learn.Session(directory, workers=1, algorithm='dmc-v1')
            session.save()
            session.close()
            path = Path(directory) / 'checkpoint.pt'
            saved = torch.load(path, weights_only=False)
            saved['config'].pop('algorithm')
            torch.save(saved, path)
            resumed = learn.Session(directory, workers=1)
            try:
                self.assertEqual(resumed.algorithm, 'dmc-v1')
                self.assertIsInstance(resumed.network, learn.Network)
            finally:
                resumed.close()

    def test_partial_optimizer_update_resumes_and_completed_rollout_is_not_reused(self):
        with tempfile.TemporaryDirectory() as directory, learn.Bridge() as bridge:
            session = learn.Session(directory, workers=1)
            try:
                example = self.example(bridge)
                session.dataset.append(example)
                session.save()
                exported_before = (Path(directory) / 'candidate.json').read_bytes()
                session.rollout = [self.sample(example, session.network, result) for result in [1., -1.]]
                scenarios = session.training_scenarios()
                update = session.update
                def interrupt(loss, metric):
                    update(loss, metric)
                    learn.STOP = True
                with patch.object(session, 'update', side_effect=interrupt):
                    self.assertFalse(ppo.optimize(session, scenarios, float('inf')))
                session.save()
                self.assertEqual((Path(directory) / 'candidate.json').read_bytes(), exported_before)
                steps = session.metrics['rlUpdates']
                self.assertGreater(steps, 0)
                self.assertIsNotNone(session.ppo_update)
                expected_rng = session.rng.getstate()
                expected_torch = torch.get_rng_state().clone()
            finally:
                learn.STOP = False
                session.close()
            resumed = learn.Session(directory, workers=1)
            try:
                self.assertEqual(resumed.rng.getstate(), expected_rng)
                torch.testing.assert_close(torch.get_rng_state(), expected_torch, rtol=0, atol=0)
                self.assertTrue(ppo.optimize(resumed, resumed.training_scenarios(), float('inf')))
                self.assertEqual(resumed.metrics['rlUpdates'], 4)
                self.assertEqual(resumed.rollout, [])
                self.assertIsNone(resumed.ppo_update)
                self.assertTrue(ppo.optimize(resumed, [], float('inf')))
                self.assertEqual(resumed.metrics['rlUpdates'], 4)
            finally:
                resumed.close()

    def test_real_rollout_game_budget_partial_matches_and_resume_frozen_actor(self):
        with tempfile.TemporaryDirectory() as directory, learn.Bridge() as bridge, patch.dict(ppo.SETTINGS, rolloutSize=1):
            session = learn.Session(directory, workers=2)
            example = self.example(bridge)
            session.dataset.append(example)
            session.metrics['pretrainUpdates'] = 1
            before = copy.deepcopy(session.network.state_dict())
            original = learn.Session.new_worker
            def fast_worker(owner, actor):
                worker = original(owner, actor)
                worker['policies'] = ['learner' if p == 'learner' else 'medium' for p in worker['policies']]
                return worker
            try:
                budget = GameBudget(1)
                with patch.object(learn.Session, 'new_worker', fast_worker):
                    session.collect_or_train('train', game_budget=budget)
                self.assertEqual(budget.used, 1)
                self.assertEqual(session.metrics['matches'], 1)
                self.assertGreater(len(session.rollout), 0)
                self.assertEqual(session.bridges[1].call('snapshot')['game']['revision'], 0)
                self.assertEqual(session.metrics['rlUpdates'], 0)
                for key, value in before.items():
                    torch.testing.assert_close(session.network.state_dict()[key], value, rtol=0, atol=0)
                snapshot = session.bridges[1].call('snapshot')
            finally:
                session.close()
            resumed = learn.Session(directory, workers=2)
            try:
                budget = GameBudget(1)
                with patch.object(learn.Session, 'new_worker', fast_worker):
                    resumed.collect_or_train('train', game_budget=budget)
                self.assertEqual(budget.used, 1)
                self.assertEqual(resumed.metrics['matches'], 2)
                self.assertEqual(resumed.metrics['lastUpdatedMatch'], 2)
                self.assertEqual(resumed.metrics['rolloutUpdates'], 1)
                self.assertEqual(resumed.rollout, [])
                self.assertTrue(all(w['observation']['done'] for w in resumed.active))
                self.assertGreater(resumed.bridges[1].call('snapshot')['game']['revision'], snapshot['game']['revision'])
            finally:
                resumed.close()

    def test_short_rollout_is_not_optimized_when_budget_ends_at_match_boundary(self):
        with tempfile.TemporaryDirectory() as directory, learn.Bridge() as bridge:
            session = learn.Session(directory, workers=1)
            try:
                example = self.example(bridge)
                session.dataset.append(example)
                session.metrics['pretrainUpdates'] = 1
                session.rollout.append(self.sample(example, session.network))
                snapshot = bridge.call('snapshot')
                snapshot['game'].update(phase='matchEnd', scores=[151, 0])
                session.environments['train'] = [dict(snapshot=snapshot, samples=[], policies=['learner', 'medium', 'medium', 'medium'])]
                budget = GameBudget(1)
                budget.complete()
                session.collect_or_train('train', game_budget=budget)
                self.assertEqual(len(session.rollout), 1)
                self.assertEqual(session.metrics['rlUpdates'], 0)
                self.assertIsNone(session.ppo_update)
            finally:
                session.close()

    def test_cycle_defaults_baseline_and_compatible_transfer_require_new_preparation(self):
        with tempfile.TemporaryDirectory() as root, learn.Bridge() as bridge:
            directory = str(Path(root) / 'ppo')
            args = argparse.Namespace(run=directory, teacher_examples=1, holdout_examples=1, pretrain_steps=1, workers=1)
            controller = Cycle(args)
            try:
                self.assertEqual(controller.config['algorithm'], 'ppo-v2')
                session = learn.Session(directory, workers=1)
                try:
                    example = self.example(bridge)
                    session.dataset.append(example)
                    session.holdout.append((*example[:3], 12))
                    session.metrics.update(collectSteps=2, pretrainUpdates=1, matches=200)
                    session.save()
                finally:
                    session.close()
                controller.state['phase'] = 'pretrain'
                controller.step(None)
                self.assertEqual(controller.state['phase'], 'validation')
                self.assertEqual(controller.state['candidate']['id'], controller.state['baseline']['id'])
                self.assertTrue(Path(controller.state['baseline']['path']).exists())
                self.assertEqual(controller.config['matches_per_candidate'], 100)
                controller.save()
            finally:
                controller.close()
            target = str(Path(root) / 'transferred')
            inherited = Cycle(argparse.Namespace(run=target, from_run=directory))
            try:
                self.assertEqual(inherited.state['phase'], 'collect')
                self.assertEqual(inherited.state['origin']['metrics']['matches'], 200)
                checkpoint = torch.load(Path(target) / 'checkpoint.pt', weights_only=False)
                self.assertEqual(checkpoint['metrics']['pretrainUpdates'], 0)
                self.assertEqual(len(checkpoint['dataset']), 0)
                self.assertEqual(len(checkpoint['optimizer']['state']), 0)
            finally:
                inherited.close()
            with self.assertRaisesRegex(ValueError, 'algorithm'):
                Cycle(argparse.Namespace(run=str(Path(root) / 'wrong'), from_run=directory, algorithm='dmc-v1'))
            with self.assertRaisesRegex(ValueError, 'algorithm'):
                learn.Session(directory, workers=1, algorithm='dmc-v1')

    def test_contract_results_are_attributed_to_declaring_team(self):
        buckets = {}
        learn.record_contracts(buckets, [dict(contract='H', declarer=1, added=[0, 30], outcome='made'),
                                         dict(contract='H', declarer=2, added=[0, 30], outcome='failed')], 0)
        self.assertEqual(buckets['H']['opponent']['made'], 1)
        self.assertEqual(buckets['H']['own']['failed'], 1)
        self.assertEqual(buckets['H']['scoreDifference'], -60)


if __name__ == '__main__':
    unittest.main()
