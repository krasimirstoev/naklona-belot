import contextlib
import io
import json
import unittest
from reporting import event_output, next_step, print_status


def state(phase="validation"):
    return {"run": "/tmp/a run", "phase": phase, "metrics": {"matches": 100},
            "thresholds": {"teacher_examples": 10000, "pretrain_steps": 1000, "registry": "/tmp/model registry"},
            "candidate": {"id": "b" * 64, "path": "/tmp/a run/model.json"},
            "active": {"current": None}, "readyForActivation": False, "nextTrainingMatch": 200,
            "reports": {"validation": {"games": 33, "seedsRequested": 20, "completedSeeds": 8,
                "wins": 1, "complete": False, "confidence": {"mean": .03125, "lower": 0, "upper": .09375}}}}


class ReportingTests(unittest.TestCase):
    def output(self, fn, *args):
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            fn(*args)
        return stream.getvalue()

    def test_partial_session_is_distinct_from_completed_evaluation(self):
        s = state()
        text = self.output(print_status, s)
        self.assertIn("33/80", text)
        self.assertIn("НЕЗАВЪРШЕНА", text)
        self.assertIn("1/33 (3.0%)", text)
        self.assertIn("Готов за активиране: НЕ", text)
        self.assertIn("теглата не се обучават", text)
        self.assertIn("--run '/tmp/a run' --games 20", text)
        event = {"event": "evaluation-paused", "phase": "validation", "games": 33, "wins": 1,
                 "gamesRequested": 80, "completedSeeds": 8, "seedsRequested": 20, "model": "bbbb"}
        text = self.output(event_output, event)
        self.assertIn("записана за продължаване", text)
        event["event"] = "evaluation-complete"
        self.assertIn("Проверката е завършена", self.output(event_output, event))

    def test_rejected_candidate_remains_visible_after_training_resumes(self):
        s = state("train")
        s.update(candidate=None, reports={}, lastOutcome={"id": "b" * 64, "reason": "validation-no-advantage",
            "reports": {"validation": {"games": 80, "confidence": {"mean": .05}}}})
        text = self.output(print_status, s)
        self.assertIn("Последен отхвърлен кандидат", text)
        self.assertIn("не надвишават 50%", text)
        self.assertIn("5.0%", text)
        self.assertIn("200 завършени тренировъчни мача", text)
        self.assertIn("--games 20", next_step(s)["command"])

    def test_early_rejection_displays_actual_wins_not_cluster_average(self):
        s = state("train")
        s.update(candidate=None, reports={}, lastOutcome={"id": "b" * 64, "reason": "validation-no-possible-advantage",
            "reports": {"validation": {"games": 42, "wins": 1, "confidence": {"mean": .025},
                                      "earlyRejection": {"maxPossibleWinRate": 39/80}}}})
        text = self.output(print_status, s)
        self.assertIn("1/42 (2.4%)", text)
        self.assertIn("48.8%", text)
        self.assertNotIn("2.5%", text)

    def test_activation_command_is_only_suggested_for_qualified_candidate(self):
        s = state("ready")
        self.assertNotIn(" activate ", next_step(s)["command"])
        s["readyForActivation"] = True
        command = next_step(s)["command"]
        self.assertIn("activate --model '/tmp/a run/model.json'", command)
        self.assertIn("--registry '/tmp/model registry'", command)
        self.assertIn("Готов за активиране: ДА", self.output(print_status, s))

    def test_json_option_preserves_structured_status_and_events(self):
        s = state()
        self.assertEqual(json.loads(self.output(print_status, s, True)), s)
        event = {"event": "candidate-rejected", "model": "b" * 64, "reason": "final-no-proven-advantage"}
        self.assertEqual(json.loads(self.output(event_output, event, True)), event)
        text = self.output(event_output, event)
        self.assertIn("отхвърлен", text)
        self.assertIn("независимата проверка", text)


if __name__ == "__main__":
    unittest.main()
