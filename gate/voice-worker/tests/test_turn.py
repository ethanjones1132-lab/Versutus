"""The Smart Turn threshold wrapper, scored by a fake."""

from versutus_voice.turn import TurnJudge


def test_the_thresholds_are_exact_at_the_boundaries():
    confident = TurnJudge(is_complete=lambda window: 0.9)
    assert confident.decide(b"", silence_ms=599) == "waiting"
    assert confident.decide(b"", silence_ms=600) == "complete"

    unsure = TurnJudge(is_complete=lambda window: 0.1)
    assert unsure.decide(b"", silence_ms=1599) == "incomplete"
    assert unsure.decide(b"", silence_ms=1600) == "complete"


def test_the_scorer_only_sees_the_last_eight_seconds():
    seen = []

    def scorer(window):
        seen.append(len(window))
        return 0.9

    judge = TurnJudge(is_complete=scorer)
    nine_seconds = b"\x00" * (9 * 16000 * 2)
    assert judge.decide(nine_seconds, silence_ms=700) == "complete"
    assert seen == [8 * 16000 * 2]
    assert judge.decide(b"\x01\x02", silence_ms=700) == "complete"
    assert seen[-1] == 2


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
