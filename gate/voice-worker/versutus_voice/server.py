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
# Speech the VAD must hear before an utterance opens.
SPEECH_START_MS = 250
# The shortest held utterance that is transcribed as a turn at all.
MIN_UTTERANCE_MS = 400
# Audio kept from before an utterance opens, prepended when it does.
PREROLL_MS = 400
# Whisper's own per-segment doubt: a segment it thinks is silence, or one it
# barely believes, is dropped rather than sent as something the operator said.
NO_SPEECH_PROB_MAX = 0.6
AVG_LOGPROB_MIN = -1.0


def join_spoken_segments(segments):
    """The text of the segments Whisper is confident were speech."""
    kept = []
    for segment in segments:
        no_speech = getattr(segment, "no_speech_prob", 0.0) or 0.0
        logprob = getattr(segment, "avg_logprob", 0.0) or 0.0
        if no_speech > NO_SPEECH_PROB_MAX and logprob < AVG_LOGPROB_MIN:
            continue
        if no_speech > 0.9:
            continue
        kept.append(segment.text)
    return "".join(kept).strip()


def _error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class VoicePipeline:
    """One call's pipeline. Every model call is injected, so tests never load one."""

    def __init__(self, vad, transcriber, turn_judge, synthesizer, emit, min_utterance_ms=0):
        self._vad = vad
        self._min_utterance_bytes = int(INPUT_SAMPLE_RATE * 2 * min_utterance_ms / 1000)
        self._transcriber = transcriber
        self._turn = turn_judge
        self._synth = synthesizer
        self._emit = emit
        self._buffer = bytearray()
        # Recent audio from before speech was recognised as speech: the VAD only
        # opens an utterance after SPEECH_START_MS, so the first words would
        # otherwise be cut off ("The host..." became "Host...").
        self._preroll = bytearray()
        self._preroll_bytes = int(INPUT_SAMPLE_RATE * 2 * PREROLL_MS / 1000)
        self._session = None
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        # The generation currently being synthesized, so VAD speech during it
        # is a barge-in rather than a new turn (§4.6 step 5).
        self._synth_speaking = False
        self._speech_gen = None
        # A pause the turn judge was not sure about. Held rather than sent, so
        # it can be re-judged / forced / merged with resumed speech (§4.6 step 3).
        self._pending = None

    def open(self, params):
        self._session = (params or {}).get("voiceSessionId")
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        self._synth_speaking = False
        self._speech_gen = None
        self._pending = None
        self._buffer.clear()
        self._preroll = bytearray()
        self._vad.reset()
        return {"ok": True}

    def pushAudio(self, params):
        chunk = (params or {}).get("chunk") or {}
        try:
            pcm, rate, _channels = decode_chunk(chunk)
        except Exception as error:  # noqa: BLE001 - a bad chunk is answered, not fatal
            return {"ok": False, "error": str(error)}
        if self._muted:
            return {"ok": True}

        # Time is the audio that keeps arriving: the phone sends frames whether
        # or not it is speaking, so a held utterance's silence is measured from
        # the decoded chunk durations (§4.6 step 3).
        chunk_ms = len(pcm) / (2 * rate) * 1000.0 if rate else 0.0
        if self._pending is not None and not self._speaking:
            self._pending["silence_ms"] += chunk_ms

        events = self._vad.stream(pcm)
        before = bytes(self._preroll)
        if not self._speaking:
            self._preroll.extend(pcm)
            overflow = len(self._preroll) - self._preroll_bytes
            if overflow > 0:
                self._preroll = self._preroll[overflow:]
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
                # Speech resuming after a held pause is the same utterance: the
                # held audio joins what follows rather than being sent or lost.
                held = self._pending["pcm"] if self._pending is not None else b""
                self._pending = None
                self._speaking = True
                self._last_partial = 0
                self._buffer = bytearray(held) + (b"" if held else before) + pcm
                self._preroll = bytearray()
            elif event.kind == "speech_end":
                self._speaking = False
                if self._buffer:
                    utterance = bytes(self._buffer)
                    self._buffer.clear()
                    self._last_partial = 0
                    if self._turn is None:
                        # No Smart Turn installed: a pause ends the turn.
                        self._finalize(utterance)
                    elif len(utterance) < self._min_utterance_bytes:
                        # A blip is not a turn, however confident the judge.
                        pass
                    elif self._turn.confident(utterance):
                        # A confident verdict at the first pause is an early
                        # end: the Gate may start the Bot turn before the final.
                        text = self._transcriber.final(utterance)
                        if text:
                            self._emit("voice.earlyEnd", {"text": text})
                            self._emit("voice.final", {"text": text})
                    else:
                        # An unsure verdict is a thinking pause. Hold it and
                        # re-judge at 600 ms of silence, forcing at 1.6 s.
                        self._pending = {
                            "pcm": utterance,
                            "silence_ms": self._vad.silence_ms,
                            "next_judge_ms": self._turn.rejudge_ms,
                        }

        if self._pending is not None and not self._speaking:
            pending = self._pending
            if pending["silence_ms"] >= pending["next_judge_ms"]:
                if self._turn.decide(pending["pcm"], pending["silence_ms"]) == "complete":
                    held = pending["pcm"]
                    self._pending = None
                    self._finalize(held)
                else:
                    # Re-judge a window later, but never past the force point —
                    # decide() forces completion once silence passes it.
                    pending["next_judge_ms"] = min(
                        pending["silence_ms"] + self._turn.rejudge_ms,
                        self._turn.force_ms,
                    )

        if self._speaking:
            window_bytes = int(INPUT_SAMPLE_RATE * _PARTIAL_WINDOW_MS / 1000) * 2
            if len(self._buffer) - self._last_partial >= window_bytes:
                self._last_partial = len(self._buffer)
                text = self._transcriber.partial(bytes(self._buffer))
                if text:
                    self._emit("voice.partial", {"text": text})
        return {"ok": True}

    def _finalize(self, pcm):
        # Too short to be a sentence: a cough or a door is not a turn, and
        # sending it is what made calls "send prematurely".
        if len(pcm) < self._min_utterance_bytes:
            return
        text = self._transcriber.final(pcm)
        if text:
            self._emit("voice.final", {"text": text})

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
        self._pending = None
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


WHISPER_LOCAL_FILES = (
    "config.json",
    "model.bin",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
)


def whisper_model_dir(models_dir):
    """The pre-installed local Whisper weights, or None when they are absent.

    `voice install` fetches these files flat under `<models>/whisper/`, so the
    worker can load them without a HuggingFace call at first use. A partial set
    is not a model: every file has to be there before the directory is used.
    """
    local = Path(models_dir) / "whisper"
    if all((local / name).exists() for name in WHISPER_LOCAL_FILES):
        return local
    return None


def _log_whisper_device(device, error):
    """A silent CUDA→CPU fallback reads as slow voice, so name the device."""
    if error is None:
        print(f"[versutus-voice] whisper loaded on {device}", file=sys.stderr)
    else:
        print(f"[versutus-voice] whisper CUDA load failed ({error}); falling back to CPU", file=sys.stderr)


def load_whisper(models_dir, cpu=False):
    _register_cuda_dlls()
    from faster_whisper import WhisperModel

    local = whisper_model_dir(models_dir)
    if local is not None:
        if cpu:
            model = WhisperModel(str(local), device="cpu", compute_type="int8")
            _log_whisper_device("cpu", None)
            return model
        try:
            model = WhisperModel(str(local), device="cuda", compute_type="int8_float16")
        except Exception as error:  # noqa: BLE001 - the documented CPU fallback
            _log_whisper_device("cpu", error)
            return WhisperModel(str(local), device="cpu", compute_type="int8")
        _log_whisper_device("cuda", None)
        return model

    cache = str(Path(models_dir) / "whisper")
    if cpu:
        model = WhisperModel("small.en", device="cpu", compute_type="int8", download_root=cache)
        _log_whisper_device("cpu", None)
        return model
    try:
        model = WhisperModel(
            "large-v3-turbo", device="cuda", compute_type="int8_float16", download_root=cache
        )
    except Exception as error:  # noqa: BLE001 - the documented CPU fallback
        _log_whisper_device("cpu", error)
        return WhisperModel("small.en", device="cpu", compute_type="int8", download_root=cache)
    _log_whisper_device("cuda", None)
    return model


class SileroScorer:
    """Wraps the Silero VAD ONNX that ships inside faster-whisper.

    The v6 asset is an LSTM model: besides ``input`` it demands recurrent
    state tensors ``h`` and ``c`` and returns the next state (``hn``/``cn``)
    beside the speech probabilities. Feeding only ``input`` and ``sr`` raises
    on every window, and a scorer that never answers should be fatal rather
    than read as permanent silence.
    """

    def __init__(self):
        import numpy as np
        import onnxruntime as ort

        import faster_whisper

        asset = Path(faster_whisper.__file__).parent / "assets" / "silero_vad_v6.onnx"
        self.session = ort.InferenceSession(str(asset), providers=["CPUExecutionProvider"])
        self._np = np
        self._names = {item.name for item in self.session.get_inputs()}
        if not {"input", "h", "c"}.issubset(self._names):
            raise ValueError(f"unsupported Silero VAD graph; wants inputs {sorted(self._names)}")
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)

    def reset(self):
        self._h.fill(0)
        self._c.fill(0)

    def __call__(self, window):
        np = self._np
        from .audio import pcm16_to_float32

        samples = pcm16_to_float32(window).reshape(1, -1)
        feed = {"input": samples, "h": self._h, "c": self._c}
        outputs = self.session.run(None, feed)
        self._h, self._c = outputs[1], outputs[2]
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
SMART_TURN_SECONDS = 8
# Whisper's log-mel has n_fft=400 and hop_length=160, so 8 s is 800 frames.
SMART_TURN_FRAMES = SMART_TURN_SECONDS * 16000 // 160


def smart_turn_window(samples, sample_rate=16000, seconds=SMART_TURN_SECONDS):
    """Pad (at the front) or truncate to the last ``seconds``, per the model card."""
    import numpy as np

    max_samples = seconds * sample_rate
    if samples.shape[0] > max_samples:
        return samples[-max_samples:]
    if samples.shape[0] < max_samples:
        return np.pad(samples, (max_samples - samples.shape[0], 0))
    return samples


def load_smart_turn(models_dir):
    """Return a completeness scorer, or None when Smart Turn is not usable.

    The model is a Whisper-Tiny encoder over an 8 s log-mel window
    (``input_features`` of shape ``[1, 80, 800]``), so raw PCM has to become
    Whisper features first; faster-whisper ships the same extractor the model
    was trained with. A model that cannot run is returned as None, not as a
    scorer that always throws: a throwing judge reads as an endless pause and
    would force every turn to wait for the 1.6 s completion.
    """
    model_path = Path(models_dir) / SMART_TURN_MODEL
    if not model_path.exists():
        candidates = sorted(Path(models_dir).glob("smart-turn*.onnx"))
        if not candidates:
            return None
        model_path = candidates[0]
    import numpy as np
    import onnxruntime as ort

    from faster_whisper.feature_extractor import FeatureExtractor

    from .audio import pcm16_to_float32
    from .turn import TurnJudge

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    extractor = FeatureExtractor(chunk_length=SMART_TURN_SECONDS)

    def is_complete(window):
        audio = smart_turn_window(pcm16_to_float32(window))
        # faster-whisper keeps Whisper's extra STFT frame (801); the model wants
        # the canonical 800, with the batch dimension the ONNX graph expects.
        features = extractor(audio)[:, :SMART_TURN_FRAMES][None].astype(np.float32)
        outputs = session.run(None, {session.get_inputs()[0].name: features})
        return float(np.asarray(outputs[0]).reshape(-1)[0])

    try:
        is_complete(b"\x00\x00" * 16000)
    except Exception:  # noqa: BLE001 - an unusable model is not installed
        return None

    return TurnJudge(is_complete=is_complete)


def build_default_pipeline(emit, models_dir, cpu=False):
    """The real pipeline. Smart Turn falls back to 'a pause is a turn' when absent."""
    from .stt import PartialTranscriber
    from .tts import SpeechSynthesizer
    from .vad import VadSegmenter

    whisper = load_whisper(models_dir, cpu=cpu)

    def transcribe(pcm, beam_size):
        from .audio import pcm16_to_float32

        segments, _info = whisper.transcribe(
            pcm16_to_float32(pcm),
            beam_size=beam_size,
            # Each utterance stands alone; carrying the last one's text in is
            # how Whisper repeats itself on a quiet line.
            condition_on_previous_text=False,
        )
        return join_spoken_segments(segments)

    kokoro = load_kokoro(models_dir)
    turn = load_smart_turn(models_dir)
    if turn is None:
        # Degraded: without Smart Turn a silence ends the turn. `voice doctor`
        # names the missing model; this keeps a call usable until it is installed.
        from .turn import TurnJudge

        turn = TurnJudge(is_complete=lambda _window: 1.0)
    return VoicePipeline(
        # 96 ms of "speech" opened an utterance on a click or a breath, and
        # Whisper turned each one into "Thank you." on a live call (2026-09-19).
        vad=VadSegmenter(is_speech=SileroScorer(), start_ms=SPEECH_START_MS),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=turn,
        synthesizer=SpeechSynthesizer(KokoroSynthesizer(kokoro)),
        emit=emit,
        min_utterance_ms=MIN_UTTERANCE_MS,
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
