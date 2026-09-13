"""Kokoro-shaped synthesis: sentence order, generations and cancel.

The synthesizer is injected. Chunks carry the generation that asked for them,
and a cancelled generation stops mid-sentence rather than finishing (§4.5).
"""

from .audio import OUTPUT_SAMPLE_RATE

_TERMINATORS = ".!?"


def split_sentences(text):
    """Split where the app's ``speechChunks`` splits, keeping trailing spaces."""
    out = []
    start = 0
    for index, char in enumerate(text):
        if char in _TERMINATORS:
            end = index + 1
            while end < len(text) and text[end] == " ":
                end += 1
            out.append(text[start:end])
            start = end
    if text[start:].strip():
        out.append(text[start:])
    return out


class SpeechSynthesizer:
    def __init__(self, synthesize, sample_rate=OUTPUT_SAMPLE_RATE):
        self.synthesize = synthesize
        self.sample_rate = sample_rate
        self._cancelled = set()

    def cancel(self, gen):
        self._cancelled.add(gen)

    def is_cancelled(self, gen):
        return gen in self._cancelled

    def speak(self, text, gen):
        """Yield ``(gen, pcm)`` per sentence chunk, stopping on cancel."""
        for sentence in split_sentences(text):
            for pcm in self.synthesize(sentence):
                if self.is_cancelled(gen):
                    return
                yield gen, pcm
