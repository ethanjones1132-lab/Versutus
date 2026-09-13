"""End-of-turn judging with Smart Turn v3's shape.

The scorer is injected. §4.6 fixes the windows: judge again at 600 ms of
silence, force completion at 1.6 s, and only ever score the last ≤ 8 s of
audio. A thinking pause therefore waits for a second look instead of sending
early.
"""

from .audio import INPUT_SAMPLE_RATE


class TurnJudge:
    def __init__(
        self,
        threshold=0.5,
        rejudge_ms=600,
        force_ms=1600,
        max_seconds=8,
        sample_rate=INPUT_SAMPLE_RATE,
        is_complete=None,
    ):
        self.threshold = threshold
        self.rejudge_ms = rejudge_ms
        self.force_ms = force_ms
        self.max_bytes = sample_rate * max_seconds * 2
        self.is_complete = is_complete

    def window(self, pcm):
        """The scorer only ever sees the last ``max_seconds`` of audio."""
        if len(pcm) <= self.max_bytes:
            return pcm
        return pcm[-self.max_bytes :]

    def confident(self, window):
        """True when the scorer is sure this utterance ended on its own."""
        try:
            return float(self.is_complete(self.window(window))) >= self.threshold
        except Exception:  # noqa: BLE001 - a scorer that cannot answer is not confident
            return False

    def decide(self, window, silence_ms):
        """Return 'waiting', 'complete' or 'incomplete' for the current silence."""
        if silence_ms >= self.force_ms:
            return "complete"
        if silence_ms < self.rejudge_ms:
            return "waiting"
        try:
            score = float(self.is_complete(self.window(window)))
        except Exception:  # noqa: BLE001 - a scorer that cannot answer is not a completion
            return "incomplete"
        return "complete" if score >= self.threshold else "incomplete"
