"""End-of-turn judging with Smart Turn v3's shape.

The scorer is injected. §4.6 fixes the windows and round 3 retunes them from a
live call: judge again at 800 ms of silence, force completion at 2.8 s, and
only ever score the last ≤ 8 s of audio. A thinking pause therefore waits for
a second look instead of sending early, and a 2 s mid-sentence pause survives:
the 1.6 s force point is what turned "let me think" into a sent turn
(2026-09-19, "there is no option to continue talking").

Round 5 (2026-11-15) makes the verdict three-way instead of two, because the
Gate no longer waits a fixed 1.8 s behind it. Measured on the installed v3.2
with synthesised speech: finished sentences score 0.90-0.99 at the first pause,
phrases cut mid-thought ("...and", "...because", "um,") 0.01-0.12, and a clause
that merely *could* be the end ("So I was thinking about the release plan,")
0.53 — over the old 0.5 line, and then a different answer at every later look.
So a score is only trusted at once when it is `sure`; a marginal one waits
`marginal_ms` of silence first, which is what keeps a pause of up to a second
and a half inside one turn without making every clear turn wait for it.

VS-179 (2026-11-24): a held pause is re-scored every `rejudge_step_ms` with more
silence, and one look crossing `sure` was enough to send the prefix. A loaded PC
can produce that single crossing while the resumed speech is still queued, so a
held turn now needs `sure_looks` consecutive sure looks. The force point remains
the only completion taken without a score at all.
"""

from .audio import INPUT_SAMPLE_RATE


class TurnJudge:
    def __init__(
        self,
        threshold=0.5,
        sure=0.85,
        rejudge_ms=800,
        rejudge_step_ms=400,
        marginal_ms=1500,
        force_ms=2800,
        max_seconds=8,
        min_pad_ms=300,
        sample_rate=INPUT_SAMPLE_RATE,
        is_complete=None,
        sure_looks=2,
    ):
        self.threshold = threshold
        # At or above this the turn is over the moment the person pauses.
        self.sure = sure
        self.rejudge_ms = rejudge_ms
        # How often a held pause is looked at again after the first re-judge.
        self.rejudge_step_ms = rejudge_step_ms
        # How much silence a score between `threshold` and `sure` needs behind it.
        self.marginal_ms = marginal_ms
        self.force_ms = force_ms
        self.max_bytes = sample_rate * max_seconds * 2
        self.min_pad_ms = min_pad_ms
        self.sample_rate = sample_rate
        self.is_complete = is_complete
        # A held pause is only over when the same audio looks sure twice in a
        # row. One look can flip to 0.9 on a pause that is still mid-thought
        # (measured on a loaded PC, VS-179): the prefix is re-scored with more
        # silence each time, and one crossing of `sure` was enough to send it.
        self.sure_looks = max(1, int(sure_looks))
        self._sure_streak = 0

    def reset(self):
        """Forget the last pause's sure streak: a new utterance starts fresh."""
        self._sure_streak = 0

    def window(self, pcm):
        """The scorer only ever sees the last ``max_seconds`` of audio."""
        if len(pcm) <= self.max_bytes:
            return pcm
        return pcm[-self.max_bytes :]

    def _scored(self, window, silence_ms):
        """Judge the utterance as the model expects: the window must run up to
        the decision point, so the silence since speech ended is part of it.

        Judging the bare utterance made every score land ≈0.98 — complete —
        because the model never saw the pause it was meant to weigh (measured
        on the installed v3.2: silence alone 0.987, a half-sentence with a
        2 s pause 0.403 once the pause is inside the window)."""
        pad_ms = max(int(silence_ms or 0), self.min_pad_ms)
        pad = int(self.sample_rate * 2 * pad_ms / 1000)
        return self.window(bytes(window) + b"\x00" * pad)

    def confident(self, window, silence_ms=None):
        """True when the scorer is sure this utterance ended on its own."""
        try:
            scored = float(self.is_complete(self._scored(window, silence_ms)))
            return scored >= self.sure
        except Exception:  # noqa: BLE001 - a scorer that cannot answer is not confident
            return False

    def decide(self, window, silence_ms):
        """Return 'waiting', 'complete' or 'incomplete' for the current silence."""
        if silence_ms >= self.force_ms:
            self._sure_streak = 0
            return "complete"
        if silence_ms < self.rejudge_ms:
            return "waiting"
        try:
            score = float(self.is_complete(self._scored(window, silence_ms)))
        except Exception:  # noqa: BLE001 - a scorer that cannot answer is not a completion
            self._sure_streak = 0
            return "incomplete"
        if score >= self.sure:
            self._sure_streak += 1
            if self._sure_streak >= self.sure_looks:
                self._sure_streak = 0
                return "complete"
            # One sure look is not a stable verdict: the next look must agree,
            # unless the force point ends the pause without a score at all.
            return "incomplete"
        self._sure_streak = 0
        if score >= self.threshold and silence_ms >= self.marginal_ms:
            return "complete"
        return "incomplete"
