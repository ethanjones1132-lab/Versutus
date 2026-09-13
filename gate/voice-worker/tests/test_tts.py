"""Kokoro-shaped synthesis: sentence order, generations and cancel."""

from versutus_voice.tts import SpeechSynthesizer


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
