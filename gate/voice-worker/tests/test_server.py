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

    def reset(self):
        self._streams = 0

    def stream(self, _pcm):
        self._streams += 1
        if self._streams == 1:
            self.in_speech = False
            return [type("Event", (), {"kind": "speech_start"})(), type("Event", (), {"kind": "speech_end"})()]
        return []


def _pipeline(events, emit=None):
    vad = FakeVad()
    transcriber = PartialTranscriber(lambda pcm, beam_size: "hello there")
    tts = SpeechSynthesizer(lambda text: [text.encode("ascii")])
    return VoicePipeline(
        vad=vad,
        transcriber=transcriber,
        turn_judge=None,
        synthesizer=tts,
        emit=emit or (lambda method, params: events.append((method, params))),
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


def test_a_production_server_keeps_no_copy_of_the_audio_it_writes():
    # `written` is a test assertion hook. In production it retained every
    # synthesised sentence of the call as a base64 PCM blob, for a reply that is
    # over in seconds, and the same frames were copied again on every respawn.
    class Sink:
        def __init__(self):
            self.lines = []

        def write(self, text):
            self.lines.append(text)

        def flush(self):
            pass

    sink = Sink()
    # Wired the way `main` wires it: the pipeline's notifications are the
    # server's frames, so they must come out of `out`.
    server = None
    pipeline = _pipeline([], emit=lambda method, params: server.emit(method, params))
    server = RpcServer(pipeline, out=sink, record=False)

    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 7, "method": "voice.speak", "params": {"gen": 1, "text": "One. Two."}}))
    assert server.written == []
    frames = [json.loads(line) for line in sink.lines]
    assert [frame.get("method") for frame in frames] == [
        "voice.speechAudio",
        "voice.speechAudio",
        "voice.speechDone",
        None,  # the response to the request, which carries no method
    ]
    assert frames[-1]["id"] == 7

    # The reply that ended the call still leaves nothing behind.
    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 8, "method": "voice.close", "params": {}}))
    assert server.written == []
    assert json.loads(sink.lines[-1])["result"] == {"ok": True}


def test_the_default_server_still_records_what_it_writes():
    class Sink:
        def write(self, _text):
            pass

        def flush(self):
            pass

    server = RpcServer(_pipeline([]), out=Sink())
    server.handle_message(json.dumps({"jsonrpc": "2.0", "id": 9, "method": "voice.describe", "params": {}}))
    assert len(server.written) == 1
    assert json.loads(server.written[0])["result"]["sampleRate"] == {"input": 16000, "output": 24000}


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


# ─── Round 4: the readiness and failure signals the Gate depends on ─────────


def test_ready_is_the_first_frame_a_cold_worker_writes(monkeypatch):
    """Loading Whisper, Silero, Kokoro and Smart Turn takes tens of seconds,
    and nothing said when it was done, so the Gate told the phone "listening"
    while the worker could not hear: the first sentence was recognised 17.9 s
    after the stream opened (GV-7)."""
    import io

    from versutus_voice import server as server_module

    monkeypatch.setattr(
        server_module,
        "build_default_pipeline",
        lambda emit, models_dir, cpu=False: _pipeline([], emit=emit),
    )
    out = io.StringIO()
    monkeypatch.setattr(server_module.sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(server_module.sys, "stdout", out)

    assert server_module.main(["--models-dir", "models"]) == 0
    frames = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    assert [frame.get("method") for frame in frames] == ["voice.ready"]
    assert frames[0]["params"]["sampleRate"] == {"input": 16000, "output": 24000}
    assert frames[0]["params"]["device"] == "cpu"
    assert isinstance(frames[0]["params"]["loadMs"], int)


def test_the_ready_frame_names_the_device_whisper_loaded_on():
    server = RpcServer(_pipeline([]))
    server.announce_ready("cuda", 4321)
    frame = json.loads(server.written[0])
    assert frame["method"] == "voice.ready"
    assert frame["params"] == {
        "sampleRate": {"input": 16000, "output": 24000},
        "device": "cuda",
        "loadMs": 4321,
    }


def test_a_failing_notification_is_reported_instead_of_an_id_less_error():
    events = []
    pipeline = _pipeline(events)

    def explode(_params):
        raise RuntimeError("the decoder died")

    pipeline.pushAudio = explode
    server = RpcServer(pipeline)
    server.handle_message(json.dumps({"jsonrpc": "2.0", "method": "voice.pushAudio", "params": {}}))

    # `{"id": null, "error": ...}` is discarded by the transport, so a failure
    # inside a handler vanished and the call went deaf with nothing to show.
    assert len(server.written) == 1
    frame = json.loads(server.written[0])
    assert "id" not in frame
    assert frame["method"] == "voice.error"
    assert frame["params"] == {
        "code": "handler_failed",
        "message": "the decoder died",
        "fatal": False,
        "gen": None,
    }


def test_an_undecodable_chunk_is_reported_on_the_wire_and_rate_limited():
    # Wired the way `main` wires it: the pipeline's notifications are the
    # server's frames, so they must come out of it.
    server = None
    pipeline = _pipeline([], emit=lambda method, params: server.emit(method, params))
    server = RpcServer(pipeline)
    chunk = {"data": "!!!not base64!!!", "sampleRate": 16000, "numChannels": 1}

    for _ in range(3):
        server.handle_message(
            json.dumps({"jsonrpc": "2.0", "method": "voice.pushAudio", "params": {"chunk": chunk}})
        )

    # `voice.pushAudio` is a notification, so the `{"ok": false, ...}` it
    # answered with was written nowhere and a broken stream read as a silent
    # microphone. Once a second: a bad stream sends hundreds of chunks a minute.
    assert [json.loads(line).get("method") for line in server.written] == ["voice.error"]
    params = json.loads(server.written[0])["params"]
    assert params["code"] == "bad_audio_chunk"
    assert params["fatal"] is False
    assert params["gen"] is None
    assert "base64" in params["message"]

    # A request still gets its answer; only the notification was invisible.
    server.handle_message(
        json.dumps({"jsonrpc": "2.0", "id": 12, "method": "voice.pushAudio", "params": {"chunk": chunk}})
    )
    assert json.loads(server.written[-1])["result"]["ok"] is False


def test_a_failing_request_still_answers_with_a_json_rpc_error():
    events = []
    pipeline = _pipeline(events)

    def explode(_params):
        raise RuntimeError("the decoder died")

    pipeline.pushAudio = explode
    server = RpcServer(pipeline)
    server.handle_message(
        json.dumps({"jsonrpc": "2.0", "id": 11, "method": "voice.pushAudio", "params": {}})
    )

    frame = json.loads(server.written[0])
    assert frame["id"] == 11
    assert frame["error"] == {"code": -32000, "message": "the decoder died"}
    assert "method" not in frame


