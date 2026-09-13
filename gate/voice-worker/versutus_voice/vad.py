"""Silero-VAD-shaped segmentation as a pure state machine.

The ONNX scorer is injected, so tests run on synthetic audio and the module
never imports a model. §4.6 fixes the 32 ms window and the pipeline's
thresholds; M6 tunes them from S2 data.
"""

from dataclasses import dataclass

from .audio import INPUT_SAMPLE_RATE, VAD_WINDOW_SAMPLES


@dataclass(frozen=True)
class VadEvent:
    kind: str  # 'speech_start' | 'speech_end'
    at_ms: int


class VadSegmenter:
    def __init__(
        self,
        sample_rate=INPUT_SAMPLE_RATE,
        window_samples=VAD_WINDOW_SAMPLES,
        start_ms=96,
        silence_ms=200,
        threshold=0.5,
        is_speech=None,
    ):
        self.sample_rate = sample_rate
        self.window_samples = window_samples
        self.window_ms = window_samples * 1000.0 / sample_rate
        self.start_ms = start_ms
        self.silence_ms = silence_ms
        self.threshold = threshold
        self.is_speech = is_speech
        self.in_speech = False
        self.reset()

    def reset(self):
        self._now_ms = 0.0
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self.in_speech = False

    def push(self, probability):
        """Feed one window's speech probability; return any boundary events."""
        events = []
        self._now_ms += self.window_ms
        if not self.in_speech:
            if probability >= self.threshold:
                self._speech_ms += self.window_ms
                self._silence_ms = 0.0
                if self._speech_ms >= self.start_ms:
                    self.in_speech = True
                    events.append(VadEvent("speech_start", round(self._now_ms - self._speech_ms)))
            else:
                self._speech_ms = 0.0
        elif probability < self.threshold:
            self._silence_ms += self.window_ms
            if self._silence_ms >= self.silence_ms:
                self.in_speech = False
                self._speech_ms = 0.0
                events.append(VadEvent("speech_end", round(self._now_ms - self._silence_ms)))
        else:
            self._silence_ms = 0.0
        return events

    def stream(self, pcm):
        """Split PCM16 into windows, score each, and return the boundary events."""
        if self.is_speech is None:
            raise ValueError("VadSegmenter.stream needs an is_speech scorer")
        events = []
        size = self.window_samples * 2
        for offset in range(0, len(pcm) - size + 1, size):
            window = pcm[offset : offset + size]
            try:
                probability = float(self.is_speech(window))
            except Exception:  # noqa: BLE001 - a bad window reads as silence
                probability = 0.0
            events.extend(self.push(probability))
        return events
