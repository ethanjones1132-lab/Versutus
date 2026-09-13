"""Partial windows are bounded and finals ask for a wider beam."""

from versutus_voice.stt import PartialTranscriber


class FakeModel:
    def __init__(self):
        self.calls = []

    def __call__(self, pcm, beam_size):
        self.calls.append((len(pcm), beam_size))
        return "text"


def test_partials_use_beam_one_and_finals_use_beam_five():
    model = FakeModel()
    stt = PartialTranscriber(model)
    assert stt.partial(b"\x00\x00" * 100) == "text"
    assert stt.final(b"\x00\x00" * 100) == "text"
    assert model.calls[0][1] == 1
    assert model.calls[1][1] == 5


def test_a_partial_window_is_bounded_to_the_last_seconds():
    model = FakeModel()
    stt = PartialTranscriber(model, max_seconds=15)
    stt.partial(b"\x00\x00" * (16000 * 20))
    assert model.calls[0][0] == 16000 * 15 * 2
