import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
import learn
from cycle import Cycle, immutable_copy, status
from budget import GameBudget


def args(directory, **overrides):
    values = dict(run=directory, registry=str(Path(directory) / 'registry'), teacher_examples=2,
                  pretrain_steps=2, matches_per_candidate=1, validation_seeds=2, workers=1, threads=2, seed=7)
    values.update(overrides)
    return argparse.Namespace(**values)


class CycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def session(self, controller, phase, _minutes, target):
        path = controller.directory / 'checkpoint.pt'
        metrics = torch.load(path, weights_only=False)['metrics'] if path.exists() else {
            'collectSteps': 0, 'pretrainUpdates': 0, 'matches': 0, 'rlUpdates': 0}
        metrics[{'collect': 'collectSteps', 'pretrain': 'pretrainUpdates', 'train': 'matches'}[phase]] = target
        metrics['lastLoss'] = 1 / (metrics['matches'] + 1)
        torch.save({'metrics': metrics}, path)
        torch.manual_seed(metrics['matches'])
        learn.atomic_json(controller.directory / 'candidate.json', learn.export_model(learn.Network()))
        return metrics

    def evaluate(self, call, mean=.6, lower=.55, complete=True):
        report = dict(version=1, modelSha256=learn.file_digest(call.model),
                      referenceFingerprint=self.controller.config['referenceFingerprint'], split=call.split,
                      namespace=call.namespace, partner=call.partner, seedsRequested=call.seeds,
                      completedSeeds=call.seeds if complete else 0, games=call.seeds * 4 if complete else 0,
                      complete=complete, confidence={'mean': mean, 'lower': lower, 'upper': .9},
                      latency={'count': 100, 'p95Ms': 10}, contracts={'H': {'rounds': 10, 'scoreDifference': 20}},
                      opponentSha256=learn.file_digest(call.opponent) if call.opponent else None)
        learn.atomic_json(call.report, report)
        return report

    def bootstrap(self, controller):
        with patch.object(controller, 'session_phase', side_effect=lambda *a: self.session(controller, *a)):
            controller.step(1)
            controller.step(1)
            controller.step(1)
        self.assertEqual(controller.state['phase'], 'validation')

    def test_game_processes_do_not_receive_the_terminal_interrupt_before_checkpointing(self):
        with learn.Bridge() as bridge:
            self.assertNotEqual(os.getpgid(bridge.process.pid), os.getpgrp())
            self.assertEqual(bridge.call('info')['encodingVersion'], learn.ENCODING_VERSION)

    def test_resume_keeps_exact_candidate_and_does_not_train_during_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            self.bootstrap(self.controller)
            original = dict(self.controller.state['candidate'])
            checksum = learn.file_digest(original['path'])
            with patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, complete=False)) as evaluate:
                self.controller.step(1)
                first_namespace = evaluate.call_args.args[0].namespace
                self.assertTrue(evaluate.call_args.args[0].progress)
                self.assertEqual(evaluate.call_args.args[0].progress_phase, 'validation')
            # Independent training may change the latest checkpoint; pending evaluation must not follow it.
            learn.atomic_json(Path(directory) / 'candidate.json', learn.export_model(learn.Network()))
            self.controller.close()
            self.controller = Cycle(args(directory, teacher_examples=None, pretrain_steps=None,
                                         matches_per_candidate=None, validation_seeds=None))
            try:
                with patch.object(self.controller, 'session_phase') as train, patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, complete=False)) as evaluate:
                    self.controller.step(1)
                    self.assertFalse(train.called)
                    self.assertEqual(evaluate.call_args.args[0].model, original['path'])
                    self.assertEqual(evaluate.call_args.args[0].namespace, first_namespace)
                self.assertEqual(learn.file_digest(original['path']), checksum)
                other = Path(directory) / 'different.json'
                other.write_text('different')
                with self.assertRaises(ValueError):
                    immutable_copy(other, original['path'])
                self.assertFalse(status(directory)['readyForActivation'])
            finally:
                self.controller.close()

    def test_ready_requires_full_final_and_crossplay_then_waits_for_manual_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            try:
                self.bootstrap(self.controller)
                with patch('learn.evaluate', side_effect=self.evaluate) as evaluate:
                    self.controller.step(1)  # validation
                    self.controller.step(1)  # primary
                    self.controller.step(1)  # crossplay
                    calls = [c.args[0] for c in evaluate.call_args_list]
                self.assertEqual([(c.split, c.seeds, c.partner) for c in calls],
                                 [('validation', 2, 'hard'), ('final', 1000, 'hard'), ('final', 200, 'medium')])
                self.assertEqual(len({c.namespace for c in calls}), 3)
                self.assertEqual(self.controller.state['phase'], 'ready')
                self.assertTrue(status(directory)['readyForActivation'])
                self.assertFalse((Path(directory) / 'registry' / 'active.json').exists())
                self.assertFalse(self.controller.step(1))
                candidate = self.controller.state['candidate']
                with patch.object(self.controller, 'active', return_value={'current': candidate['id']}):
                    self.controller.step(1)
                self.assertEqual(self.controller.state['phase'], 'train')
                self.assertEqual(self.controller.state['nextMatches'], 2)
            finally:
                self.controller.close()

    def test_new_selection_has_fresh_final_namespace_and_shared_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            try:
                self.bootstrap(self.controller)
                with patch('learn.evaluate', side_effect=self.evaluate) as ev:
                    self.controller.step(1)
                    validation_namespace = ev.call_args.args[0].namespace
                with patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, lower=.4)) as ev:
                    self.controller.step(1)
                    first_final = ev.call_args.args[0].namespace
                self.assertEqual(self.controller.state['phase'], 'train')
                with patch.object(self.controller, 'session_phase', side_effect=lambda *a: self.session(self.controller, *a)):
                    self.controller.step(1)
                with patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, mean=.7)) as ev:
                    self.controller.step(1)
                    self.assertEqual(ev.call_args.args[0].namespace, validation_namespace)
                    self.controller.step(1)
                    self.assertNotEqual(ev.call_args.args[0].namespace, first_final)
            finally:
                self.controller.close()

    def test_lower_training_loss_does_not_override_worse_game_results(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            try:
                self.bootstrap(self.controller)
                with patch('learn.evaluate', side_effect=self.evaluate):
                    self.controller.step(1)
                best = dict(self.controller.state['best'])
                with patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, lower=.4)):
                    self.controller.step(1)
                with patch.object(self.controller, 'session_phase', side_effect=lambda *a: self.session(self.controller, *a)):
                    self.controller.step(1)
                with patch('learn.evaluate', side_effect=lambda a: self.evaluate(a, mean=.5, lower=.4)):
                    self.controller.step(1)
                self.assertEqual(self.controller.state['best'], best)
                self.assertEqual(self.controller.state['phase'], 'train')
                self.assertEqual(self.controller.state['history'][-1]['reason'], 'validation-not-better')
                summary = status(directory)
                self.assertEqual(summary['lastOutcome']['reason'], 'validation-not-better')
                self.assertTrue(summary['lastOutcome']['reports']['validation']['complete'])
                self.assertIn('самоиграта', summary['nextStep']['description'])
                self.assertIn('--games 20', summary['nextStep']['command'])
            finally:
                self.controller.close()

    def test_game_budget_spans_early_rejection_training_and_next_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            try:
                self.bootstrap(self.controller)
                calls = []
                def evaluation(call):
                    calls.append(call.game_budget.remaining)
                    call.game_budget.complete()
                    report = self.evaluate(call, complete=False)
                    if len(calls) == 1:
                        report["earlyRejected"] = True
                        learn.atomic_json(call.report, report)
                    return report
                def training(*arguments):
                    self.assertIsNone(arguments[1])  # no hidden minute deadline
                    self.controller.game_budget.complete()
                    return self.session(self.controller, *arguments)
                with patch('learn.evaluate', side_effect=evaluation), patch.object(self.controller, 'session_phase', side_effect=training):
                    result = self.controller.run(games=3)
                self.assertEqual(calls, [3, 1])
                self.assertEqual(result['sessionBudget']['gamesCompleted'], 3)
                self.assertEqual(result['phase'], 'validation')
                self.assertEqual(result['lastOutcome']['reason'], 'validation-no-possible-advantage')
                self.assertIsNone(result['bestValidation'])
                self.assertFalse(result['readyForActivation'])
            finally:
                self.controller.close()

    def test_changed_active_model_requires_new_frozen_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            self.controller = Cycle(args(directory))
            try:
                self.bootstrap(self.controller)
                current = 'a' * 64
                opponent = Path(directory) / 'opponent.json'
                learn.atomic_json(opponent, learn.export_model(learn.Network()))
                current = learn.file_digest(opponent)
                with patch('learn.evaluate', side_effect=self.evaluate), patch.object(self.controller, 'active', return_value={'current': current}):
                    self.controller.step(1)
                    self.controller.step(1)
                    self.controller.step(1)
                    self.assertEqual(self.controller.state['phase'], 'champion')
                    actual_call = self.controller.bridge.call
                    def bridge_call(command, **kwargs):
                        return {'path': str(opponent)} if command == 'registryModel' else actual_call(command, **kwargs)
                    with patch.object(self.controller.bridge, 'call', side_effect=bridge_call):
                        self.controller.step(1)
                self.assertEqual(self.controller.state['phase'], 'ready')
                approval = json.loads(Path(self.controller.state['candidate']['path'] + '.approval.json').read_text())
                self.assertEqual(approval['champion']['opponentSha256'], current)
            finally:
                self.controller.close()


if __name__ == '__main__':
    unittest.main()
