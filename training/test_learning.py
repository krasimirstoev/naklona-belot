import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import torch

from learn import (Bridge, Network, Session, atomic_json, bootstrap_confidence, choose,
                   evaluate, export_model, inputs, match_targets)


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
            session = Session(directory, workers=1, threads=2, seed=3)
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
            resumed = Session(directory, workers=1, threads=2, seed=3)
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
            session = Session(directory, workers=1)
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
            with contextlib.redirect_stdout(io.StringIO()):
                evaluate(args)
                evaluate(args)
            saved = json.loads(report.read_text())
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
