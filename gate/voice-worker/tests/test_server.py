"""The stdio JSON-RPC loop over a pipeline whose models are fakes."""

import json

from versutus_voice.audio import encode_chunk, float32_to_pcm16
from versutus_voice.server import RpcServer, VoicePipeline
from versutus_voice.stt import PartialTranscriber
from versutus_voice.tts import SpeechSynthesizer


def _pcm(ms, rate=16000):
    return float32_to_pcm16([0.0] * int(rate * ms / 1000))


class FakeVad:
    """A scripted segmenter: the first stream ends a turn, later streams do not."""

    def __init__(self):
        self.in_speech = False
        self._streams = 0

    def stream(self, _pcm):
        self._streams += 1
        if self._streams == 1:
            self.in_speech = False
            return [type("Event", (), {"kind": "speech_start"})(), type("Event", (), {"kind": "speech_end"})()]
        return []


def _pipeline(events):
    vad = FakeVad()
    transcriber = PartialTranscriber(lambda pcm, beam_size: "hello there")
    tts = SpeechSynthesizer(lambda text: [text.encode("ascii")])
    return VoicePipeline(
        vad=vad,
        transcriber=transcriber,
        turn_judge=None,
        synthesizer=tts,
        emit=lambda method, params: events.append((method, params)),
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
    )


def test_describe_reports_the_sample_rates():
    events = []
    server = RpcServer(_pipeline(events))
    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "voice.describe", "params": {}}))
    result = json.loads(server.written[-1])["result"]
    assert result["sampleRate"] == {"input": 16000, "output": 24000}


def test_push_audio_ends_a_turn_and_speak_streams_in_order():
    events = []
    server = RpcServer(_pipeline(events))

    server.handle_message(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "voice.pushAudio",
                "params": {"chunk": encode_chunk(_pcm(200), 16000)},
            }
        )
    )
    assert events[0][0] == "voice.final"
    assert events[0][1]["text"] == "hello there"

    server.handle_message(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "voice.speak",
                "params": {"gen": 4, "text": "One. Two.", "final": True},
            }
        )
    )
    kinds = [method for method, _params in events]
    assert kinds[-3:] == ["voice.speechAudio", "voice.speechAudio", "voice.speechDone"]
    assert {params["gen"] for method, params in events if method == "voice.speechAudio"} == {4}


def test_a_malformed_line_is_an_error_and_the_loop_survives():
    events = []
    server = RpcServer(_pipeline(events))
    server.handle_message("not json")
    assert json.loads(server.written[-1])["error"]["code"] == -32700
    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 5, "method": "voice.describe", "params": {}}))
    assert "result" in json.loads(server.written[-1])


def test_an_unknown_method_is_an_error():
    events = []
    server = RpcServer(_pipeline(events))
    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 6, "method": "voice.nope", "params": {}}))
    assert json.loads(server.written[-1])["error"]["code"] == -32601


def test_the_local_whisper_dir_is_used_only_when_every_file_is_present(tmp_path):
    from versutus_voice.server import WHISPER_LOCAL_FILES, whisper_model_dir

    assert whisper_model_dir(tmp_path) is None
    whisper = tmp_path / "whisper"
    whisper.mkdir()
    for name in WHISPER_LOCAL_FILES[:-1]:
        (whisper / name).write_bytes(b"x")
    assert whisper_model_dir(tmp_path) is None

    (whisper / WHISPER_LOCAL_FILES[-1]).write_bytes(b"x")
    assert whisper_model_dir(tmp_path) == whisper


def test_smart_turn_window_pads_the_front_and_keeps_the_end():
    import numpy as np

    from versutus_voice.server import smart_turn_window

    short = smart_turn_window(np.array([1, 2], dtype=np.float32), sample_rate=1, seconds=4)
    assert short.tolist() == [0.0, 0.0, 1.0, 2.0]

    long = smart_turn_window(np.array([1, 2, 3, 4, 5], dtype=np.float32), sample_rate=1, seconds=4)
    assert long.tolist() == [2.0, 3.0, 4.0, 5.0]

    exact = smart_turn_window(np.array([1, 2, 3, 4], dtype=np.float32), sample_rate=1, seconds=4)
    assert exact.tolist() == [1.0, 2.0, 3.0, 4.0]


