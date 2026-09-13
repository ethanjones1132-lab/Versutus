"""The Smart Turn threshold wrapper, scored by a fake."""

from versutus_voice.turn import TurnJudge


def test_a_confident_score_completes_after_the_rejudge_window():
    judge = TurnJudge(is_complete=lambda window: 0.9)
    assert judge.decide(b"", silence_ms=100) == "waiting"
    assert judge.decide(b"", silence_ms=700) == "complete"


def test_a_thinking_pause_is_incomplete_then_forced():
    judge = TurnJudge(is_complete=lambda window: 0.1)
    assert judge.decide(b"", silence_ms=700) == "incomplete"
    assert judge.decide(b"", silence_ms=1700) == "complete"


def test_a_scorer_that_throws_reads_as_incomplete():
    def boom(_window):
        raise RuntimeError("no model")

    judge = TurnJudge(is_complete=boom)
    assert judge.decide(b"", silence_ms=700) == "incomplete"
