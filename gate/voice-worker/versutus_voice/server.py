"""The worker's stdio JSON-RPC loop, and the pipeline that wires the stages.

Only this module knows about model libraries, and only inside its loader
functions, so importing the package never loads a model. The RPC surface is
fixed in ``docs/plans/2026-09-12-voice-m5.md`` §Task 5.1: one JSON object per
line, notifications for partial/final/speech/error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .audio import (
    INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
    decode_chunk,
    encode_chunk,
)

_METHODS = ("open", "pushAudio", "speak", "cancelSpeech", "setMuted", "close")
_PARTIAL_WINDOW_MS = 600


def _error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class VoicePipeline:
    """One call's pipeline. Every model call is injected, so tests never load one."""

    def __init__(self, vad, transcriber, turn_judge, synthesizer, emit):
        self._vad = vad
        self._transcriber = transcriber
        self._turn = turn_judge
        self._synth = synthesizer
        self._emit = emit
        self._buffer = bytearray()
        self._session = None
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        # The generation currently being synthesized, so VAD speech during it
        # is a barge-in rather than a new turn (§4.6 step 5).
        self._synth_speaking = False
        self._speech_gen = None

    def open(self, params):
        self._session = (params or {}).get("voiceSessionId")
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        self._synth_speaking = False
        self._speech_gen = None
        self._buffer.clear()
        self._vad.reset()
        return {"ok": True}

    def pushAudio(self, params):
        chunk = (params or {}).get("chunk") or {}
        try:
            pcm, _rate, _channels = decode_chunk(chunk)
        except Exception as error:  # noqa: BLE001 - a bad chunk is answered, not fatal
            return {"ok": False, "error": str(error)}
        if self._muted:
            return {"ok": True}

        events = self._vad.stream(pcm)
        if events or self._speaking:
            self._buffer.extend(pcm)
        for event in events:
            if event.kind == "speech_start":
                if self._synth_speaking:
                    # Starting to talk interrupts the PC's speech and returns
                    # to listening; the generation stops at the next chunk.
                    self._emit("voice.userSpeechStart", {"gen": self._speech_gen})
                    if self._speech_gen is not None:
                        self._synth.cancel(self._speech_gen)
                    self._synth_speaking = False
                self._speaking = True
                self._last_partial = 0
                self._buffer = bytearray(pcm)
            elif event.kind == "speech_end":
                self._speaking = False
                if self._buffer:
                    text = self._transcriber.final(bytes(self._buffer))
                    if text:
                        self._emit("voice.final", {"text": text})
                self._buffer.clear()
                self._last_partial = 0

        if self._speaking:
            window_bytes = int(INPUT_SAMPLE_RATE * _PARTIAL_WINDOW_MS / 1000) * 2
            if len(self._buffer) - self._last_partial >= window_bytes:
                self._last_partial = len(self._buffer)
                text = self._transcriber.partial(bytes(self._buffer))
                if text:
                    self._emit("voice.partial", {"text": text})
        return {"ok": True}

    def speak(self, params):
        params = params or {}
        gen = int(params.get("gen", 0))
        text = str(params.get("text", ""))
        self._synth_speaking = True
        self._speech_gen = gen
        try:
            for chunk_gen, pcm in self._synth.speak(text, gen):
                self._emit(
                    "voice.speechAudio",
                    {"gen": chunk_gen, "chunk": encode_chunk(pcm, OUTPUT_SAMPLE_RATE)},
                )
            if not self._synth.is_cancelled(gen):
                self._emit("voice.speechDone", {"gen": gen})
        finally:
            self._synth_speaking = False
            self._speech_gen = None
        return {"ok": True}

    def cancelSpeech(self, params):
        gen = int((params or {}).get("gen", 0))
        self._synth.cancel(gen)
        if self._speech_gen == gen:
            self._synth_speaking = False
            self._speech_gen = None
        return {"ok": True}

    def setMuted(self, params):
        self._muted = bool((params or {}).get("muted"))
        return {"ok": True}

    def close(self, params):
        self._buffer.clear()
        self._session = None
        return {"ok": True}


class RpcServer:
    """A newline-delimited JSON-RPC 2.0 loop over the pipeline."""

    def __init__(self, pipeline, sample_rate=None, out=None):
        self.pipeline = pipeline
        self.sample_rate = sample_rate or {
            "input": INPUT_SAMPLE_RATE,
            "output": OUTPUT_SAMPLE_RATE,
        }
        self.written = []
        self._out = out

    def _write(self, payload):
        line = json.dumps(payload)
        self.written.append(line)
        if self._out is not None:
            self._out.write(line + "\n")
            self._out.flush()

    def emit(self, method, params):
        """A notification the pipeline sends to the Gate."""
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond(self, request_id, result):
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def handle_message(self, line):
        try:
            message = json.loads(line)
        except (TypeError, ValueError):
            self._write(_error(None, -32700, "parse error"))
            return
        if not isinstance(message, dict) or "method" not in message:
            request_id = message.get("id") if isinstance(message, dict) else None
            self._write(_error(request_id, -32600, "invalid request"))
            return

        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}
        if method == "voice.describe":
            self._respond(request_id, {"ok": True, "sampleRate": dict(self.sample_rate)})
            return

        name = method.split(".", 1)[1] if isinstance(method, str) and "." in method else method
        handler = getattr(self.pipeline, name, None)
        if name not in _METHODS or not callable(handler):
            self._write(_error(request_id, -32601, f"unknown method {method}"))
            return
        try:
            result = handler(params)
        except Exception as error:  # noqa: BLE001 - a stage failure is reported, not fatal
            self._write(_error(request_id, -32000, str(error)))
            return
        if request_id is not None:
            self._respond(request_id, result if result is not None else {"ok": True})

    def serve(self, stdin=None, out=None):
        if out is not None:
            self._out = out
        stream = stdin if stdin is not None else sys.stdin
        for line in stream:
            if line.strip():
                self.handle_message(line)


# ─── Real model loaders (lazy; never imported by tests) ─────────────────────


def _register_cuda_dlls():
    """ctranslate2 loads cuBLAS/cuDNN eagerly on Windows (S2 spike, lines 34-41)."""
    import os

    if os.name != "nt":
        return
    nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not nvidia.exists():
        return
    for sub in nvidia.iterdir():
        binary = sub / "bin"
        if binary.exists():
            os.add_dll_directory(str(binary))
            os.environ["PATH"] = f"{binary}{os.pathsep}{os.environ.get('PATH', '')}"


def load_whisper(models_dir, cpu=False):
    _register_cuda_dlls()
    from faster_whisper import WhisperModel

    cache = str(Path(models_dir) / "whisper")
    if cpu:
        return WhisperModel("small.en", device="cpu", compute_type="int8", download_root=cache)
    try:
        return WhisperModel(
            "large-v3-turbo", device="cuda", compute_type="int8_float16", download_root=cache
        )
    except Exception:  # noqa: BLE001 - the documented CPU fallback
        return WhisperModel("small.en", device="cpu", compute_type="int8", download_root=cache)


class SileroScorer:
    """Wraps the Silero VAD ONNX that ships inside faster-whisper."""

    def __init__(self):
        import numpy as np
        import onnxruntime as ort

        import faster_whisper

        asset = Path(faster_whisper.__file__).parent / "assets" / "silero_vad_v6.onnx"
        self.session = ort.InferenceSession(str(asset), providers=["CPUExecutionProvider"])
        self._np = np
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._names = {item.name for item in self.session.get_inputs()}

    def __call__(self, window):
        np = self._np
        from .audio import pcm16_to_float32

        samples = pcm16_to_float32(window).reshape(1, -1)
        feed = {"input": samples, "sr": 16000}
        if "state" in self._names:
            feed["state"] = self._state
        outputs = self.session.run(None, feed)
        if len(outputs) > 1:
            self._state = outputs[1]
        return float(np.asarray(outputs[0]).reshape(-1)[0])


def load_kokoro(models_dir):
    from kokoro_onnx import Kokoro

    model_path = Path(models_dir) / "kokoro-v1.0.onnx"
    voices_path = Path(models_dir) / "voices-v1.0.bin"
    if not model_path.exists() or not voices_path.exists():
        raise FileNotFoundError(f"Kokoro model/voices not found under {models_dir}")
    return Kokoro(str(model_path), str(voices_path))


class KokoroSynthesizer:
    """Adapts ``Kokoro.create`` to the synthesizer callable the stage expects."""

    def __init__(self, kokoro, voice="af_sarah"):
        self._kokoro = kokoro
        self._voice = voice
        self.sample_rate = OUTPUT_SAMPLE_RATE

    def __call__(self, sentence):
        from .audio import float32_to_pcm16

        samples, rate = self._kokoro.create(sentence, voice=self._voice, speed=1.0, lang="en-us")
        if int(rate) != OUTPUT_SAMPLE_RATE:
            from .audio import resample_linear

            samples = resample_linear(samples, int(rate), OUTPUT_SAMPLE_RATE)
        return [float32_to_pcm16(samples)]


SMART_TURN_MODEL = "smart-turn-v3.2-cpu.onnx"


def load_smart_turn(models_dir):
    """Return a completeness scorer, or None when Smart Turn is not installed."""
    model_path = Path(models_dir) / SMART_TURN_MODEL
    if not model_path.exists():
        candidates = sorted(Path(models_dir).glob("smart-turn*.onnx"))
        if not candidates:
            return None
        model_path = candidates[0]
    import numpy as np
    import onnxruntime as ort

    from .audio import pcm16_to_float32
    from .turn import TurnJudge

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])

    def is_complete(window):
        samples = pcm16_to_float32(window).reshape(1, -1).astype(np.float32)
        outputs = session.run(None, {session.get_inputs()[0].name: samples})
        return float(np.asarray(outputs[0]).reshape(-1)[0])

    return TurnJudge(is_complete=is_complete)


def build_default_pipeline(emit, models_dir, cpu=False):
    """The real pipeline. Smart Turn falls back to 'a pause is a turn' when absent."""
    from .stt import PartialTranscriber
    from .tts import SpeechSynthesizer
    from .vad import VadSegmenter

    whisper = load_whisper(models_dir, cpu=cpu)

    def transcribe(pcm, beam_size):
        from .audio import pcm16_to_float32

        segments, _info = whisper.transcribe(pcm16_to_float32(pcm), beam_size=beam_size)
        return "".join(segment.text for segment in segments).strip()

    kokoro = load_kokoro(models_dir)
    turn = load_smart_turn(models_dir)
    if turn is None:
        # Degraded: without Smart Turn a silence ends the turn. `voice doctor`
        # names the missing model; this keeps a call usable until it is installed.
        from .turn import TurnJudge

        turn = TurnJudge(is_complete=lambda _window: 1.0)
    return VoicePipeline(
        vad=VadSegmenter(is_speech=SileroScorer()),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=turn,
        synthesizer=SpeechSynthesizer(KokoroSynthesizer(kokoro)),
        emit=emit,
    )


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Versutus local voice worker")
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args(argv)

    server = None
    pipeline = build_default_pipeline(
        emit=lambda method, params: server.emit(method, params),
        models_dir=args.models_dir,
        cpu=args.cpu,
    )
    server = RpcServer(pipeline, out=sys.stdout)
    server.serve(stdin=sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main())
