"""The Smart Turn threshold wrapper, scored by a fake."""

from versutus_voice.turn import TurnJudge


def test_the_thresholds_are_exact_at_the_boundaries():
    confident = TurnJudge(is_complete=lambda window: 0.9)
    assert confident.decide(b"", silence_ms=799) == "waiting"
    assert confident.decide(b"", silence_ms=800) == "complete"

    unsure = TurnJudge(is_complete=lambda window: 0.1)
    assert unsure.decide(b"", silence_ms=2799) == "incomplete"
    assert unsure.decide(b"", silence_ms=2800) == "complete"


def test_the_scorer_only_sees_the_last_eight_seconds():
    seen = []

    def scorer(window):
        seen.append(len(window))
        return 0.9

    judge = TurnJudge(is_complete=scorer)
    nine_seconds = b"\x00" * (9 * 16000 * 2)
    assert judge.decide(nine_seconds, silence_ms=900) == "complete"
    assert seen == [8 * 16000 * 2]
    # The silence since speech ended is part of the judged window: 0.9 s of
    # padding rides along with the utterance bytes.
    assert judge.decide(b"\x01\x02", silence_ms=900) == "complete"
    assert seen[-1] == 2 + 900 * 32


def test_the_judged_window_includes_the_silence_since_speech_ended():
    """Round-3 fix: judging the bare utterance made every score land ≈0.98.

    The model only discriminates when the window runs up to the decision
    point, silence included (measured on the installed v3.2: a half-sentence
    with a 2 s pause scores 0.403 with the pause inside the window, 0.98
    without it).
    """

    def scorer(window):
        return 0.4 if len(window) > 16000 * 2 else 0.9

    judge = TurnJudge(is_complete=scorer)
    # A short utterance judged with 0.9 s of silence is a long window → the
    # mid-sentence score; confident() with almost no silence sees the short
    # window → the bare-utterance score.
    assert judge.decide(b"\x01\x02" * 8000, silence_ms=900) == "incomplete"
    assert judge.confident(b"\x01\x02" * 8000, silence_ms=100) is True


def test_a_confident_score_completes_after_the_rejudge_window():
    judge = TurnJudge(is_complete=lambda window: 0.9)
    assert judge.decide(b"", silence_ms=100) == "waiting"
    assert judge.decide(b"", silence_ms=900) == "complete"


def test_a_thinking_pause_is_incomplete_then_forced():
    judge = TurnJudge(is_complete=lambda window: 0.1)
    assert judge.decide(b"", silence_ms=900) == "incomplete"
    assert judge.decide(b"", silence_ms=2900) == "complete"


def test_confident_pads_short_silence_to_a_minimal_window():
    """At speech_end only ~200 ms of silence exists; the model needs more
    context than that, so a minimum pad stands in for the unheard future."""
    seen = []

    def scorer(window):
        seen.append(len(window))
        return 0.9

    judge = TurnJudge(is_complete=scorer)
    assert judge.confident(b"\x01\x02", silence_ms=200) is True
    assert seen == [2 + 300 * 32]
    # With no silence reported at all, the same minimum pad applies.
    assert judge.confident(b"\x01\x02") is True
    assert seen[-1] == 2 + 300 * 32


def test_a_scorer_that_throws_reads_as_incomplete():
    def boom(_window):
        raise RuntimeError("no model")

    judge = TurnJudge(is_complete=boom)
    assert judge.decide(b"", silence_ms=900) == "incomplete"
    assert judge.confident(b"") is False
