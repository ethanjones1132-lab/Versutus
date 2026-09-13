"""End-of-turn judging with Smart Turn v3's shape.

The scorer is injected. §4.6 fixes the windows: judge again at 600 ms of
silence, force completion at 1.6 s. A thinking pause therefore waits for a
second look instead of sending early.
"""


class TurnJudge:
    def __init__(self, threshold=0.5, rejudge_ms=600, force_ms=1600, is_complete=None):
        self.threshold = threshold
        self.rejudge_ms = rejudge_ms
        self.force_ms = force_ms
        self.is_complete = is_complete

    def decide(self, window, silence_ms):
        """Return 'waiting', 'complete' or 'incomplete' for the current silence."""
        if silence_ms >= self.force_ms:
            return "complete"
        if silence_ms < self.rejudge_ms:
            return "waiting"
        try:
            score = float(self.is_complete(window))
        except Exception:  # noqa: BLE001 - a scorer that cannot answer is not a completion
            return "incomplete"
        return "complete" if score >= self.threshold else "incomplete"
