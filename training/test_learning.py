import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import torch

from learn import (Bridge, Network, Session, atomic_json, bootstrap_confidence, choose,
                   evaluate, export_model, inputs, match_targets, preference_loss, ENCODING_VERSION, evaluation_progress)


class LearningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_python_and_typescript_scores_agree(self):
        torch.manual_seed(13)
        network = Network()
        with Bridge() as bridge:
            obs = bridge.call("reset", namespace="test-v1", seed=11)
            for _ in range(2):
                with torch.no_grad():
                    expected = network(inputs(obs["observation"], obs["actionFeatures"])).tolist()
                actual = bridge.call("score", model=export_model(network), observation=obs["observation"], actions=obs["actionFeatures"])["scores"]
                torch.testing.assert_close(torch.tensor(actual), torch.tensor(expected), rtol=1e-5, atol=1e-5)
                self.assertEqual(choose(network, obs["observation"], obs["actionFeatures"]), max(range(len(actual)), key=lambda i: actual[i]))
                while obs["phase"] == "bidding":
                    obs = bridge.call("act", policy="medium")

    def test_preference_set_loss_and_scenario_mixture_resume(self):
        logits = torch.tensor([1., 2., 3.], requires_grad=True)
        torch.testing.assert_close(preference_loss(logits, [1]), torch.nn.functional.cross_entropy(logits.unsqueeze(0), torch.tensor([1])))
        self.assertLess(preference_loss(logits, [1, 2]), preference_loss(logits, [1]))
        torch.testing.assert_close(preference_loss(logits, [0, 1, 2]), torch.tensor(0.))
        with self.assertRaises(ValueError):
            preference_loss(logits, [])
        with tempfile.TemporaryDirectory() as directory:
            session = Session(directory, algorithm="dmc-v1", workers=1)
            try:
                with Bridge() as bridge:
                    obs = bridge.call("reset", namespace="test-v1", seed=7)
                    examples = bridge.call("trainingScenarios")["examples"]
                    self.assertEqual(len(examples), 6)
                    self.assertTrue(all(e["id"].endswith("-train") for e in examples))
                session.dataset.append((torch.tensor(obs["observation"]), torch.tensor(obs["actionFeatures"]), 0))
                session.pretrain(.1, stop_at=1)
                self.assertEqual(session.metrics["pretrainNaturalExamples"], 36)
                self.assertEqual(session.metrics["pretrainScenarioExamples"], 4)
            finally:
                session.close()
            resumed = Session(directory, algorithm="dmc-v1", workers=1)
            try:
                resumed.pretrain(.1, stop_at=2)
                self.assertEqual(resumed.config["encodingVersion"], ENCODING_VERSION)
                self.assertEqual(resumed.metrics["pretrainNaturalExamples"], 72)
                self.assertEqual(resumed.metrics["pretrainScenarioExamples"], 8)
            finally:
                resumed.close()

    def test_v2_scenario_score_parity_and_diagnostics(self):
        network = Network()
        with tempfile.TemporaryDirectory() as directory, Bridge() as bridge:
            path = Path(directory) / "v2.json"
            atomic_json(path, export_model(network))
            bridge.call("loadModel", path=str(path))
            for example in bridge.call("trainingScenarios")["examples"]:
                with torch.no_grad():
                    expected = network(inputs(example["observation"], example["actionFeatures"])).tolist()
                actual = bridge.call("score", model=export_model(network), observation=example["observation"], actions=example["actionFeatures"])["scores"]
                torch.testing.assert_close(torch.tensor(actual), torch.tensor(expected), rtol=1e-5, atol=1e-5)
            report = bridge.call("scenarioReport")
            self.assertTrue(report["diagnosticOnly"])
            self.assertEqual(report["split"], "control")
            self.assertEqual(len(report["topics"]), 6)
            for case in report["cases"]:
                self.assertTrue(case["id"].endswith("-control"))
                self.assertTrue(case["heuristicSuccess"])
                if not case["success"]:
                    self.assertIn("publicFacts", case)
                    self.assertIn("candidates", case)
                    self.assertNotIn("hands", case["publicFacts"])

    def test_cycle_evaluation_progress_is_visible_and_counts_partial_seed_games(self):
        args = argparse.Namespace(progress=True, progress_phase="primary", split="final", seeds=1000)
        state = {"groups": [[1, 0, 1, 0]], "current": [1, 0], "config": {"modelSha256": "a" * 64}}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            evaluation_progress(args, state, "evaluation-progress")
        event = json.loads(output.getvalue())
        self.assertEqual(event["phase"], "primary")
        self.assertEqual(event["games"], 6)
        self.assertEqual(event["gamesRequested"], 4000)
        self.assertEqual(event["wins"], 3)
        self.assertEqual(event["completedSeeds"], 1)
        args.progress = False
        with contextlib.redirect_stdout(io.StringIO()) as quiet:
            evaluation_progress(args, state, "evaluation-progress")
        self.assertEqual(quiet.getvalue(), "")

    def test_only_terminal_matches_produce_targets(self):
        samples = [(torch.tensor([1.]), 0), (torch.tensor([2.]), 1)]
        with self.assertRaises(ValueError):
            match_targets(samples, {"done": False})
        targets = match_targets(samples, {"done": True, "rewards": [-1, 1]})
        self.assertEqual([value for _, value in targets], [-1., 1.])

    def test_confidence_resamples_seeds_not_individual_games(self):
        ci = bootstrap_confidence([[1, 0, 1, 0]] * 20)
        self.assertEqual(ci, {"mean": .5, "lower": .5, "upper": .5})
        self.assertEqual(bootstrap_confidence([])["lower"], 0)

    def test_checkpoint_restores_network_optimizer_rng_and_partial_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            session = Session(directory, algorithm="dmc-v1", workers=1, threads=2, seed=3)
            try:
                session.start("train")
                worker = session.active[0]
                obs = worker["observation"]
                x = inputs(obs["observation"], obs["actionFeatures"])[0]
                worker["samples"].append((x, obs["team"]))
                index = choose(session.network, obs["observation"], obs["actionFeatures"])
                worker["observation"] = session.bridges[0].call("step", index=index)
                session.dataset.append((torch.tensor(obs["observation"]), torch.tensor(obs["actionFeatures"]), index))
                loss = session.network(x.unsqueeze(0)).square().mean()
                session.update(loss, "pretrainUpdates")
                session.save()
                expected = {key: value.clone() for key, value in session.network.state_dict().items()}
                random_value = session.rng.random()
                torch_value = torch.rand(1)
                snapshot = session.bridges[0].call("snapshot")
                optimizer = session.optimizer.state_dict()
            finally:
                session.close()
            resumed = Session(directory, algorithm="dmc-v1", workers=1, threads=2, seed=3)
            try:
                self.assertEqual(resumed.rng.random(), random_value)
                torch.testing.assert_close(torch.rand(1), torch_value)
                for key, value in resumed.network.state_dict().items():
                    torch.testing.assert_close(value, expected[key], rtol=0, atol=0)
                self.assertEqual(resumed.optimizer.state_dict()["param_groups"], optimizer["param_groups"])
                for parameter, state in optimizer["state"].items():
                    for key, value in state.items():
                        torch.testing.assert_close(resumed.optimizer.state_dict()["state"][parameter][key], value, rtol=0, atol=0)
                resumed.start("train")
                self.assertEqual(resumed.bridges[0].call("snapshot"), snapshot)
                self.assertEqual(len(resumed.active[0]["samples"]), 1)
                self.assertEqual(len(resumed.replay), 0)
            finally:
                resumed.close()

    def test_supervised_and_monte_carlo_updates_change_weights(self):
        with tempfile.TemporaryDirectory() as directory, Bridge() as bridge:
            session = Session(directory, algorithm="dmc-v1", workers=1)
            try:
                obs = bridge.call("reset", namespace="test-v1", seed=7)
                x = inputs(obs["observation"], obs["actionFeatures"])
                before = session.network.layers[0].weight.detach().clone()
                session.update(torch.nn.functional.cross_entropy(session.network(x).unsqueeze(0), torch.tensor([0])), "pretrainUpdates")
                self.assertFalse(torch.equal(before, session.network.layers[0].weight))
                before = session.network.layers[0].weight.detach().clone()
                session.update(torch.nn.functional.mse_loss(session.network(x[:1]), torch.tensor([1.])), "rlUpdates")
                self.assertFalse(torch.equal(before, session.network.layers[0].weight))
            finally:
                session.close()

    def test_evaluation_is_bounded_resumable_and_not_a_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            model, report = path / "model.json", path / "report.json"
            atomic_json(model, export_model(Network()))
            args = argparse.Namespace(model=str(model), report=str(report), split="validation", partner="hard", seeds=1, minutes=.001)
            args.quiet, args.progress = True, True
            with contextlib.redirect_stdout(io.StringIO()) as output:
                evaluate(args)
                evaluate(args)
            events = [json.loads(line)["event"] for line in output.getvalue().splitlines()]
            self.assertEqual(events, ["evaluation-start", "evaluation-paused"] * 2)
            saved = json.loads(report.read_text())
            self.assertEqual(saved["scenarios"]["split"], "control")
            self.assertFalse(saved["complete"])
            self.assertEqual(saved["completedSeeds"], 0)
            progress = torch.load(str(report) + ".progress.pt", weights_only=False)
            self.assertIsNotNone(progress["snapshot"])
            self.assertFalse(Path(str(model) + ".approval.json").exists())
            args.seeds = 2
            with self.assertRaises(ValueError):
                evaluate(args)


if __name__ == "__main__":
    unittest.main()
