"""Kokoro-shaped synthesis: sentence order, generations and cancel.

The synthesizer is injected. Chunks carry the generation that asked for them,
and a cancelled generation stops mid-sentence rather than finishing (§4.5).
"""

import math
import re
import time

from .audio import OUTPUT_SAMPLE_RATE
from .speakable import speakable

_SENTENCE_END = re.compile(r"""[.!?]+['"”’)\]]*(?=\s|$)\s*""")
_WORDS = re.compile(r"\S+\s*")
_CLAUSE_END = re.compile(r"""[,;:—–]['"”’)\]]*$""")
# An em dash can separate clauses without whitespace. Keep it with the word
# before it; don't split hyphenated words, decimals, times or number ranges.
_REMAINDER_WORDS = re.compile(r"""[^\s—]+(?:\s*—+['"”’)\]]*)?\s*""")
_CONJUNCTIONS = {
    "and", "but", "or", "nor", "yet", "so", "because", "although", "though",
    "if", "unless", "while", "whereas", "when", "until", "before", "after", "whether",
}
_CLAUSE_WORD_LIMIT = 16
_MIN_CLAUSE_WORDS = 3
_INFERENCE_OVERHEAD_SECONDS = 0.05
_HANDOFF_HEADROOM_SECONDS = 0.45
WARMUP_TEXT = "I can help you with that, and here's what I would try first."


def split_sentences(text):
    """Split where the app's ``speechChunks`` splits, keeping trailing spaces."""
    out = []
    start = 0
    for match in _SENTENCE_END.finditer(text):
        end = match.end()
        out.append(text[start:end])
        start = end
    if text[start:].strip():
        out.append(text[start:])
    return out


def phrase_chunks(sentence, max_words):
    """Legacy all-phrase chunking, kept for benchmark comparisons."""
    if max_words <= 0:
        yield sentence
        return
    words = list(_WORDS.finditer(sentence))
    start = index = 0
    while len(words) - index > max_words:
        limit = index + max_words
        cut = next(
            (i for i in range(limit, index + (max_words + 1) // 2 - 1, -1)
             if _CLAUSE_END.search(words[i - 1].group().rstrip())),
            limit,
        )
        end = words[cut - 1].end()
        yield sentence[start:end]
        start, index = end, cut
    yield sentence[start:]


def first_phrase_chunks(sentence, max_words):
    """Cut once, at the first natural boundary from word six to the limit.

    With no pause in that range, cut at the last complete word in the budget.
    Preserve the exact text; do not invent punctuation at a forced boundary.
    """
    if max_words <= 0:
        yield sentence
        return
    words = list(_WORDS.finditer(sentence))
    if len(words) <= max_words:
        yield sentence
        return
    cut = next((word for word in words[5:max_words] if _CLAUSE_END.search(word.group().rstrip())),
               words[max_words - 1])
    yield sentence[:cut.end()]
    yield sentence[cut.end():]


def remainder_chunks(text, max_words, *, opening_words=0, rtf=0.9, words_per_second=3.2):
    """Plan exact clause slices against estimated, unplayed seconds of PCM.

    Charge synthesis time before adding the new chunk's audio. Budget below
    that deadline with headroom for imperfect word-duration estimates and
    handoff. With no known opening, cap the first chunk and start the clock
    when it arrives; don't presume earlier sentences still have queued audio.
    """
    words = list(_REMAINDER_WORDS.finditer(text))
    if max_words <= 0 or opening_words + len(words) <= _CLAUSE_WORD_LIMIT:
        yield text
        return

    queued_seconds = opening_words / words_per_second
    start = index = 0
    while index < len(words):
        has_opening = bool(index or opening_words)
        if has_opening:
            affordable = math.floor(
                (queued_seconds - _HANDOFF_HEADROOM_SECONDS - _INFERENCE_OVERHEAD_SECONDS)
                * words_per_second / rtf
            )
            budget = min(_CLAUSE_WORD_LIMIT, max(_MIN_CLAUSE_WORDS, affordable))
        else:
            budget = max_words
        remaining = len(words) - index
        if remaining <= max(budget, 2 * _MIN_CLAUSE_WORDS - 1):
            yield text[start:]
            return

        limit = min(index + budget, len(words) - _MIN_CLAUSE_WORDS)
        minimum = index + (_MIN_CLAUSE_WORDS if has_opening else max(_MIN_CLAUSE_WORDS, budget - 2))
        cuts = range(limit, minimum - 1, -1)
        cut = next((i for i in cuts if _CLAUSE_END.search(words[i - 1].group().rstrip())), None)
        if cut is None:
            cut = next((i for i in cuts if words[i].group().strip().lower() in _CONJUNCTIONS), limit)

        end = words[cut - 1].end()
        yield text[start:end]
        duration = (cut - index) / words_per_second
        synth_seconds = rtf * duration + _INFERENCE_OVERHEAD_SECONDS if has_opening else 0
        queued_seconds = max(0, queued_seconds - synth_seconds) + duration
        start, index = end, cut


def _sentence_chunks(sentence, max_words, *, split_opening, opening_words, chunk_remainder):
    if split_opening:
        parts = first_phrase_chunks(sentence, max_words)
        first = next(parts)
        yield first
        sentence = next(parts, None)
        if sentence is None:
            return
        opening_words = len(first.split())
    if chunk_remainder and max_words > 0:
        yield from remainder_chunks(sentence, max_words, opening_words=opening_words)
    else:
        yield sentence


class SpeechSynthesizer:
    def __init__(self, synthesize, sample_rate=OUTPUT_SAMPLE_RATE, chunk_words=0, clock=time.monotonic,
                 *, chunk_all=False, chunk_remainder=True):
        self.synthesize = synthesize
        self.sample_rate = sample_rate
        self.chunk_words = chunk_words
        self.chunk_all = chunk_all
        self.chunk_remainder = chunk_remainder
        self.clock = clock
        self.last_used = float("-inf")
        self.startup_warmup_ms = None  # set by loaders that prime during provider selection
        self._cancelled = set()

    def cancel(self, gen):
        self._cancelled.add(gen)

    def is_cancelled(self, gen):
        return gen in self._cancelled

    def reset(self):
        """Forget the last call's cancellations.

        The Gate restarts generations at 0 for every call, so a cancellation
        still remembered here would silence the whole next call.
        """
        self._cancelled.clear()

    def speak(self, text, gen):
        """Yield ``(gen, pcm)`` per sentence chunk, stopping on cancel."""
        for pcm, _, _ in self.timed_audio(text, gen):
            yield gen, pcm

    def prime(self):
        """Exercise exactly the call path, but don't enqueue or emit its PCM."""
        started = self.clock()
        if not any_pcm(self.timed_audio(WARMUP_TEXT, None)):
            raise RuntimeError("Kokoro warm-up returned no PCM")
        return round((self.clock() - started) * 1000)

    def timed_audio(self, text, gen, stale=lambda: False, *, split_opening=True, opening_prefix_words=0):
        """Yield PCM immediately, with the ordinal and first-PCM time per sentence."""
        # Clean before splitting so fences and URLs never reach Kokoro as
        # words, while sentence pauses still match what is spoken (U6).
        for index, sentence in enumerate(split_sentences(speakable(text)), start=1):
            started = self.clock()
            first = True
            if self.chunk_all:
                phrases = phrase_chunks(sentence, self.chunk_words)
            else:
                phrases = _sentence_chunks(
                    sentence, self.chunk_words, split_opening=index == 1 and split_opening,
                    opening_words=opening_prefix_words if index == 1 else 0, chunk_remainder=self.chunk_remainder,
                )
            # PCM is handed off before the next inference; this generator
            # never waits for playout, so later synthesis can run ahead of it.
            for phrase in phrases:
                if stale() or self.is_cancelled(gen):
                    return
                for pcm in self.synthesize(phrase):
                    self.last_used = self.clock()
                    if stale() or self.is_cancelled(gen):
                        return
                    if pcm:
                        yield pcm, index, round((self.last_used - started) * 1000) if first else None
                        first = False


def any_pcm(audio):
    """Drain the entire stream without storing audio or short-circuiting."""
    return sum(len(pcm) for pcm, _, _ in audio) > 0
