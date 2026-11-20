"""Kokoro-shaped synthesis: sentence order, generations and cancel."""

import pytest

from versutus_voice.tts import SpeechSynthesizer, phrase_chunks, remainder_chunks


def _synth(text):
    return [text.encode("ascii")]


def test_sentences_are_emitted_in_order_with_their_generation():
    tts = SpeechSynthesizer(_synth)
    out = list(tts.speak("One. Two! Three?", gen=7))
    assert [pcm.decode() for _gen, pcm in out] == ["One. ", "Two! ", "Three?"]
    assert {gen for gen, _pcm in out} == {7}


def test_cancel_mid_sentence_stops_the_rest():
    tts = SpeechSynthesizer(_synth)
    chunks = []
    for _gen, pcm in tts.speak("One. Two. Three.", gen=3):
        chunks.append(pcm.decode())
        if len(chunks) == 1:
            tts.cancel(3)
    assert chunks == ["One. "]
    assert tts.is_cancelled(3)


def test_a_cancelled_generation_speaks_nothing():
    tts = SpeechSynthesizer(_synth)
    tts.cancel(9)
    assert list(tts.speak("Hello.", gen=9)) == []


def test_phrase_chunks_are_bounded_exact_slices_and_keep_whole_words():
    text = "  I'll keep version 2.1 online,   then re-check results with José before handing it off.  "
    chunks = list(phrase_chunks(text, 8))
    assert chunks[0] == "  I'll keep version 2.1 online,   "
    assert "".join(chunks) == text
    assert all(len(chunk.split()) <= 8 for chunk in chunks)
    assert [word for chunk in chunks for word in chunk.split()] == text.split()


def test_unpunctuated_opening_yields_before_remainder_runs_and_cancel_stops_it():
    calls = []

    def synth(text):
        calls.append(text)
        return _synth(text)

    text = "One two three four five six seven eight nine ten eleven."
    tts = SpeechSynthesizer(synth, chunk_words=8)
    audio = tts.speak(text, gen=1)
    assert next(audio) == (1, b"One two three four five six seven eight ")
    assert calls == ["One two three four five six seven eight "]
    tts.cancel(1)
    assert list(audio) == []
    assert len(calls) == 1


def test_timings_mark_each_sentence_once_even_with_multiple_phrases():
    tts = SpeechSynthesizer(_synth, chunk_words=6)
    text = "Use version 2.1 as a reference for this release. Next sentence."
    audio = list(tts.timed_audio(text, gen=1))
    assert b"".join(pcm for pcm, _, _ in audio) == text.encode()
    assert [sentence for _, sentence, _ in audio] == [1, 1, 2]
    assert [ms is not None for _, _, ms in audio] == [True, False, True]


def test_round_two_only_splits_the_first_sentence_once_at_its_earliest_natural_word_boundary():
    opening = "Start by checking the new version, "
    remainder = "then, if the result matches what you expect, keep it in place for another day. "
    later = "On the next day check the result again, before deciding whether to keep it."
    text = opening + remainder + later
    tts = SpeechSynthesizer(_synth, chunk_words=8, chunk_remainder=False)
    pieces = [pcm.decode() for _, pcm in tts.speak(text, gen=1)]
    assert pieces == [opening, remainder, later]
    assert "".join(pieces) == text
    assert [word for piece in pieces for word in piece.split()] == text.split()


def test_a_short_first_sentence_does_not_move_the_split_to_the_second_sentence():
    pieces = ["That works. ", "You can use exactly the same approach again for the other options."]
    tts = SpeechSynthesizer(_synth, chunk_words=8)
    assert [pcm.decode() for _, pcm in tts.speak("".join(pieces), gen=1)] == pieces


@pytest.mark.parametrize("mark", [",   ", "; ", ": ", "—", " — "])
def test_remainder_prefers_punctuation_and_preserves_exact_text(mark):
    clause = f"  Re-check José's setup{mark}"
    rest = "use the 12:30 report to compare everything with yesterday's known state."
    chunks = list(remainder_chunks(clause + rest, 8, opening_words=8))
    assert chunks[0] == clause
    assert "".join(chunks) == clause + rest
    assert all(len(chunk.split()) >= 3 for chunk in chunks)
    assert sum(chunk.count("12:30") for chunk in chunks) == 1


def test_remainder_can_cut_before_a_conjunction_and_falls_back_on_whole_words():
    clause = "Then check the old settings "
    rest = "before changing any hard-coded values from the original installation.  "
    chunks = list(remainder_chunks(clause + rest, 8, opening_words=8))
    assert chunks[0] == clause
    assert "".join(chunks) == clause + rest
    assert [word for chunk in chunks for word in chunk.split()] == (clause + rest).split()
    assert all(len(chunk.split()) >= 3 for chunk in chunks)


@pytest.mark.parametrize("rtf", [0.75, 0.9])
@pytest.mark.parametrize("words_per_second", [2.5, 3.2, 4.0])
@pytest.mark.parametrize("opening_words", [6, 8])
def test_remainder_schedule_stays_ahead_of_cumulative_playback(rtf, words_per_second, opening_words):
    text = " ".join(["word"] * 83)
    chunks = list(remainder_chunks(text, 8, opening_words=opening_words,
                                   rtf=rtf, words_per_second=words_per_second))
    assert "".join(chunks) == text
    assert len(chunks[-1].split()) >= 3
    assert all(len(chunk.split()) <= 16 for chunk in chunks)
    assert max(len(chunk.split()) for chunk in chunks[1:]) > len(chunks[0].split())
    playback_end = opening_words / words_per_second
    ready_at = 0
    for chunk in chunks:
        seconds = len(chunk.split()) / words_per_second
        ready_at += rtf * seconds + 0.05
        assert ready_at < playback_end
        playback_end += seconds


def test_default_keeps_opening_and_splits_a_long_later_sentence_without_retiming_it():
    opening = "Start by checking the new version, "
    remainder = "then carefully check whether it works before you go any further. "
    later = "Take a look at all the original settings and check which ones differ from the defaults before changing them."
    text = opening + remainder + later
    tts = SpeechSynthesizer(_synth, chunk_words=8)
    audio = list(tts.timed_audio(text, gen=1))
    assert audio[0][0].decode() == opening
    assert b"".join(pcm for pcm, _, _ in audio).decode() == text
    assert sum(sentence == 1 for _, sentence, _ in audio) > 2
    assert sum(sentence == 2 for _, sentence, _ in audio) > 1
    assert [sentence for _, sentence, ms in audio if ms is not None] == [1, 2]


def test_zero_word_budget_leaves_long_sentences_whole():
    sentence = "We can look at all the original settings and check which ones differ from the defaults without changing them."
    tts = SpeechSynthesizer(_synth, chunk_words=0)
    assert list(tts.speak(sentence, gen=1)) == [(1, sentence.encode())]
