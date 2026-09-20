"""Silero-VAD-shaped segmentation as a pure state machine.

The ONNX scorer is injected, so tests run on synthetic audio and the module
never imports a model. §4.6 fixes the 32 ms window and the pipeline's
thresholds; M6 tunes them from S2 data.

Audio arrives in arbitrary chunk sizes (the phone sends 20 ms frames of 320
samples). Two silent killers lived here before M6 tuning: a scorer that needed
576-sample windows while chunks were 320 (every chunk was discarded before a
window ever filled), and remainder samples lost between calls. ``stream`` now
carries the unscored tail against the next call, so no sample is scored twice
and none is dropped.
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
        # The room's own noise level, tracked below, raises the gate by this
        # much: a TV at a steady 0.55 probability must not open utterances.
        gate_margin=0.25,
        # …but never above this, or quiet real speech in a loud room dies too.
        gate_max=0.85,
        # The floor never tracks above this: at 0.65 + the margin the gate
        # reaches 0.9, which is where playback-echo rejection needs it.
        floor_cap=0.65,
        # While the PC is speaking through the loudspeaker, residual echo that
        # leaks past the phone's AEC sits high in Silero's range; the gate may
        # rise further so echo alone cannot trigger a barge-in.
        playback_gate_max=0.9,
        # Call-open calibration: for this long no utterance may open while the
        # floor learns the room. Without it, loud room tone from the very
        # first frame is above the initial gate and opens speech before the
        # floor can ever rise (the bootstrap problem).
        warmup_ms=500,
        # Calibration folds a window into the floor only below this level:
        # speech-plausible windows are left alone, so an operator who starts
        # talking immediately does not raise the gate against their own
        # voice (a TTS sentence dips mid-clip; those dips must not read as
        # silence and split the utterance).
        warmup_speech_floor=0.8,
        # Calibration windows fold into the floor only up to here, below
        # speech-like levels, so loud room tone lifts the gate while speech
        # (handled above) never contributes.
        warmup_cap=0.55,
        is_speech=None,
    ):
        self.sample_rate = sample_rate
        self.window_samples = window_samples
        self.window_ms = window_samples * 1000.0 / sample_rate
        self.start_ms = start_ms
        self.silence_ms = silence_ms
        self.threshold = threshold
        self.gate_margin = gate_margin
        self.gate_max = gate_max
        self.floor_cap = floor_cap
        self.playback_gate_max = playback_gate_max
        self.warmup_ms = warmup_ms
        self.warmup_speech_floor = warmup_speech_floor
        self.warmup_cap = warmup_cap
        self.is_speech = is_speech
        self._playback = False
        self.in_speech = False
        self._carry = bytearray()
        self.reset()

    def reset(self):
        self._now_ms = 0.0
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self.in_speech = False
        self._carry = bytearray()
        # The floor starts noise-suspicious, not quiet-trusting: with a low
        # seed, eight consecutive above-threshold noise windows (250 ms) open
        # an utterance before the floor can ever rise — the bootstrap problem.
        # Silence pulls the estimate down within about a second, so a quiet
        # room quickly returns to the fixed threshold, while a loud room is
        # protected from the very first window.
        self._floor = 0.25
        self._warmup_left = int(self.warmup_ms / self.window_ms)

    def set_playback(self, on):
        """Gate harder while the PC speaks, so leaked echo cannot open speech."""
        self._playback = bool(on)

    def _gate(self):
        cap = self.playback_gate_max if self._playback else self.gate_max
        return max(self.threshold, min(cap, self._floor + self.gate_margin))

    def push(self, probability):
        """Feed one window's speech probability; return any boundary events."""
        events = []
        self._now_ms += self.window_ms
        if self._warmup_left > 0:
            self._warmup_left -= 1
            # Call-open calibration: room tone lifts the gate instead of
            # becoming the first turn. Speech-plausible windows are neither
            # folded in nor held back — calibrating on the operator's own
            # voice raised the gate against it, so a natural mid-sentence dip
            # read as silence and one sentence arrived as two, while an
            # operator who spoke immediately lost their opening words.
            if probability < self.warmup_speech_floor:
                self._floor += (min(probability, self.warmup_cap) - self._floor) * 0.1
                self._floor = min(max(self._floor, 0.0), self.floor_cap)
                return events
        gate = self._gate()
        if not self.in_speech:
            if probability >= gate:
                self._speech_ms += self.window_ms
                self._silence_ms = 0.0
                if self._speech_ms >= self.start_ms:
                    self.in_speech = True
                    events.append(VadEvent("speech_start", round(self._now_ms - self._speech_ms)))
            else:
                self._speech_ms = 0.0
                # A window that did not open speech is a noise sample: fold it
                # into the room floor so the gate follows the room. α=0.05 per
                # 32 ms window tracks a rising room in about a second. The
                # clamp keeps the floor below the gate, so real speech always
                # has headroom no matter how loud the room gets.
                alpha = 0.05
                self._floor += (min(probability, self.floor_cap) - self._floor) * alpha
                self._floor = min(max(self._floor, 0.0), self.floor_cap)
        elif probability < gate:
            self._silence_ms += self.window_ms
            if self._silence_ms >= self.silence_ms:
                self.in_speech = False
                self._speech_ms = 0.0
                events.append(VadEvent("speech_end", round(self._now_ms - self._silence_ms)))
        else:
            self._silence_ms = 0.0
        return events

    def stream(self, pcm):
        """Score every complete window across calls, carrying the tail.

        A chunk is usually smaller than a window, so nearly every call scores
        nothing; instead of dropping what it holds, the tail joins the next
        call. Samples already inside a carried window are consumed, so audio
        is scored exactly once.
        """
        if self.is_speech is None:
            raise ValueError("VadSegmenter.stream needs an is_speech scorer")
        events = []
        size = self.window_samples * 2
        self._carry.extend(pcm)
        offset = 0
        while offset + size <= len(self._carry):
            window = bytes(self._carry[offset : offset + size])
            try:
                probability = float(self.is_speech(window))
            except Exception:  # noqa: BLE001 - a bad window reads as silence
                probability = 0.0
            events.extend(self.push(probability))
            offset += size
        if offset:
            del self._carry[:offset]
        return events
