"""faster-whisper-shaped transcription.

A partial pass is a fast beam-1 read over a bounded window (§4.6 step 2); a
final pass is beam 5. The model call is injected and never imported here.
"""

from .audio import INPUT_SAMPLE_RATE


class PartialTranscriber:
    def __init__(
        self,
        transcribe,
        sample_rate=INPUT_SAMPLE_RATE,
        max_seconds=15,
        partial_beam=1,
        final_beam=5,
    ):
        self.transcribe = transcribe
        self.sample_rate = sample_rate
        self.max_bytes = sample_rate * max_seconds * 2
        self.partial_beam = partial_beam
        self.final_beam = final_beam

    def window(self, pcm):
        """Bound an utterance to the last ``max_seconds`` of audio."""
        if len(pcm) <= self.max_bytes:
            return pcm
        return pcm[-self.max_bytes :]

    def partial(self, pcm):
        return self.transcribe(self.window(pcm), self.partial_beam)

    def final(self, pcm):
        return self.transcribe(self.window(pcm), self.final_beam)
