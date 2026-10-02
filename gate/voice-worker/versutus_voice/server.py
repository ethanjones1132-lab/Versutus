"""The worker's stdio JSON-RPC loop, and the pipeline that wires the stages.

Only this module knows about model libraries, and only inside its loader
functions, so importing the package never loads a model. The RPC surface is
fixed in ``docs/plans/2026-09-12-voice-m5.md`` §Task 5.1: one JSON object per
line, notifications for partial/final/speech/error.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

from .audio import (
    INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
    decode_chunk,
    encode_chunk,
)

_METHODS = ("open", "pushAudio", "speak", "cancelSpeech", "setMuted", "close")
_PARTIAL_WINDOW_MS = 600
# How often an undecodable chunk is named on the wire; a bad stream sends
# hundreds of chunks a minute and stdout is the Gate's only channel.
_BAD_CHUNK_ERROR_SECONDS = 1.0
# Speech the VAD must hear before an utterance opens.
SPEECH_START_MS = 250
# The shortest held utterance that is transcribed as a turn at all.
MIN_UTTERANCE_MS = 400
# Audio kept from before an utterance opens, prepended when it does.
PREROLL_MS = 400
# The longest one utterance may grow to. A VAD that never hears silence (steady
# noise above the gate) would otherwise buffer for the whole call and re-decode
# the whole thing on every partial.
MAX_UTTERANCE_SECONDS = 30
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

    def __init__(
        self,
        vad,
        transcriber,
        turn_judge,
        synthesizer,
        emit,
        min_utterance_ms=0,
        spawn=None,
    ):
        self._vad = vad
        self._min_utterance_bytes = int(INPUT_SAMPLE_RATE * 2 * min_utterance_ms / 1000)
        self._max_utterance_bytes = int(INPUT_SAMPLE_RATE * 2 * MAX_UTTERANCE_SECONDS)
        self._transcriber = transcriber
        self._turn = turn_judge
        self._synth = synthesizer
        self._emit = emit
        # Synthesis runs on its own thread so the mic keeps streaming while
        # the PC speaks: barge-in hears the operator mid-sentence, and the
        # echo of the loudspeaker is gated as playback instead of queueing up
        # to be transcribed after the generation ends. Tests inject a
        # synchronous runner so events stay deterministic.
        self._spawn = spawn or (lambda fn: threading.Thread(target=fn, daemon=True).start())
        # Speech jobs, oldest first, and the flag naming the thread currently
        # draining them. One thread for the whole pipeline: a thread per
        # sentence had sentence two in the loudspeaker while sentence one was
        # still being generated, and the reply was heard twice (VOW-3).
        self._synth_jobs = []
        self._synth_worker = None
        self._synth_lock = threading.Lock()
        self._running_gen = None
        # Recognition jobs and their worker flag. Whisper costs hundreds of ms
        # per decode; run inline it stalled the audio loop, so barge-in was
        # unheard and speech boundaries were judged late (VOW-4).
        self._stt_jobs = []
        self._stt_worker = None
        self._stt_lock = threading.Lock()
        # Counts the utterances of this call, so a queued partial is only ever
        # replaced by a newer one of the same utterance.
        self._utterance = 0
        # Bumped by open/close. A decode or sentence still in flight belongs to
        # the call that has already ended and must not emit into the next one.
        self._epoch = 0
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
        self._last_bad_chunk = float("-inf")
        # The generation currently being synthesized, so VAD speech during it
        # is a barge-in rather than a new turn (§4.6 step 5).
        self._synth_speaking = False
        self._speech_gen = None
        # A pause the turn judge was not sure about. Held rather than sent, so
        # it can be re-judged / forced / merged with resumed speech (§4.6 step 3).
        self._pending = None
        # What voice.ready names: the device Whisper really ran on, so a silent
        # CUDA→CPU fallback is visible to the Gate and not only on stderr.
        self.whisper_device = "cpu"

    def open(self, params):
        self._reset()
        self._session = (params or {}).get("voiceSessionId")
        return {"ok": True}

    def close(self, params):
        # The process stays warm across calls, so ending one ends all of its
        # work: nothing may keep speaking or transcribing into the next call.
        self._reset()
        self._session = None
        return {"ok": True}

    def _reset(self):
        """Leave no trace of the last call behind (VOW-6).

        The Gate restarts generations at 0 for every call, so a cancellation
        the synthesizer still remembers would silence the whole next one. The
        turn judge and the transcriber hold no state of their own: what they
        were given lives here, in ``_pending``, the buffers and the queues.
        """
        self._epoch += 1
        self._cancel_speech_jobs()
        with self._stt_lock:
            self._stt_jobs.clear()
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        self._last_bad_chunk = float("-inf")
        self._utterance = 0
        self._synth_speaking = False
        self._speech_gen = None
        self._pending = None
        self._buffer.clear()
        self._preroll = bytearray()
        self._synth.reset()
        self._vad.reset()

    def pushAudio(self, params):
        chunk = (params or {}).get("chunk") or {}
        try:
            pcm, rate, _channels = decode_chunk(chunk)
        except Exception as error:  # noqa: BLE001 - a bad chunk is answered, not fatal
            self._report_bad_chunk(str(error))
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
                self._start_speech(pcm, before)
            elif event.kind == "speech_end":
                self._end_speech()

        # An utterance the VAD never closes would grow for the whole call and
        # be re-decoded from the start on every partial. Past the cap it ends
        # exactly as a speech-end would, and the audio that keeps arriving opens
        # the next one.
        if self._speaking and len(self._buffer) > self._max_utterance_bytes:
            self._end_speech(force=True)
            self._utterance += 1
            self._speaking = True
            self._last_partial = 0

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
                self._queue_recognition(("partial", self._utterance, self._partial_pcm(), False))
        return {"ok": True}

    def _report_bad_chunk(self, message):
        """Name an undecodable chunk, which nobody else can hear about.

        ``voice.pushAudio`` is a notification: the ``{"ok": false}`` it was
        answered with was written nowhere, so a broken stream read as a silent
        microphone. Once a second is enough — a bad stream sends hundreds of
        chunks a minute.
        """
        now = time.monotonic()
        if now - self._last_bad_chunk < _BAD_CHUNK_ERROR_SECONDS:
            return
        self._last_bad_chunk = now
        self._emit(
            "voice.error",
            {"code": "bad_audio_chunk", "message": message, "fatal": False, "gen": None},
        )

    def _start_speech(self, pcm, before):
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
        self._utterance += 1
        self._buffer = bytearray(held) + (b"" if held else before) + pcm
        self._preroll = bytearray()

    def _end_speech(self, force=False):
        """Close the open utterance: the VAD's speech_end, or the length cap.

        Both go through the same finalisation. A capped one is *forced*: a cut
        that lands mid-word is exactly what the judge is unsure about, and held
        it would sit behind the segments that follow it (the finals arrive out
        of order) or be overwritten by them and never be transcribed at all.
        """
        if force and self._pending is not None:
            # Never overwrite a held segment with a newer one: it is earlier
            # audio, so it is sent first.
            held, self._pending = self._pending, None
            self._finalize(held["pcm"])
        self._speaking = False
        if not self._buffer:
            return
        utterance = bytes(self._buffer)
        self._buffer.clear()
        self._last_partial = 0
        if force:
            self._finalize(utterance)
        elif self._turn is None:
            # No Smart Turn installed: a pause ends the turn.
            self._finalize(utterance)
        elif len(utterance) < self._min_utterance_bytes:
            # A blip is not a turn, however confident the judge.
            return
        elif self._turn.confident(utterance, silence_ms=self._vad.silence_ms):
            # A confident verdict at the first pause is an early end: the Gate
            # may start the Bot turn before the final.
            self._finalize(utterance, early_end=True)
        else:
            # An unsure verdict is a thinking pause. Hold it and
            # re-judge at 600 ms of silence, forcing at 1.6 s.
            self._pending = {
                "pcm": utterance,
                "silence_ms": self._vad.silence_ms,
                "next_judge_ms": self._turn.rejudge_ms,
            }

    def _partial_pcm(self):
        """Only the tail the transcriber will read is copied out of the buffer.

        A partial re-reads the utterance every 600 ms; copying all of it each
        time made a long utterance cost more than its own length.
        """
        window = getattr(self._transcriber, "window", None)
        return bytes(window(self._buffer)) if callable(window) else bytes(self._buffer)

    def _finalize(self, pcm, early_end=False):
        # Too short to be a sentence: a cough or a door is not a turn, and
        # sending it is what made calls "send prematurely".
        if len(pcm) < self._min_utterance_bytes:
            return
        self._queue_recognition(("final", self._utterance, pcm, early_end))

    def speak(self, params):
        params = params or {}
        gen = int(params.get("gen", 0))
        text = str(params.get("text", ""))
        # While the PC speaks, the mic hears the loudspeaker too: the phone's
        # AEC eats most of it, but what leaks through must not open speech, or
        # the Bot would barge in on itself. The VAD gates harder until the
        # generation ends; a real operator talking still opens (and cancels).
        # Raised inside the queue's lock, so it cannot be undone by a worker
        # that decided the queue was empty a moment earlier.
        with self._synth_lock:
            self._synth_speaking = True
            self._speech_gen = gen
            set_playback = getattr(self._vad, "set_playback", None)
            if callable(set_playback):
                set_playback(True)
            self._synth_jobs.append((gen, text))
            idle = self._synth_worker is None
        # Only spawned when nobody is serving the queue: the sentences of one
        # reply are spoken one after another, never on top of each other.
        if idle:
            self._spawn(self._drain_speech)
        return {"ok": True}

    def _drain_speech(self):
        """The one synthesis worker: jobs oldest first, until the queue is empty.

        The worker flag is handed back under the lock that found the queue
        empty, so a job appended in the same breath is taken here rather than
        stranded behind a worker that has already given up.
        """
        # Ownership is a token, not a flag: the worker hands the claim back under
        # the lock that found the queue empty, and a NEWER worker may claim it
        # before this one's `finally` runs - which must then leave that claim alone.
        me = object()
        with self._synth_lock:
            if self._synth_worker is not None:
                return
            self._synth_worker = me
        try:
            while True:
                with self._synth_lock:
                    if not self._synth_jobs:
                        self._synth_worker = None
                        return
                    gen, text = self._synth_jobs.pop(0)
                    self._running_gen = gen
                try:
                    self._speak_one(gen, text)
                finally:
                    self._running_gen = None
                with self._synth_lock:
                    if not self._synth_jobs:
                        # Decided and released under the same hold: a sentence
                        # arriving between the two found the gate down, and the
                        # gate is what keeps the echo of the loudspeaker out of
                        # the VAD while it is being generated (VOW-3).
                        self._release(gen)
        finally:
            # A thread that died mid-reply must not leave itself as the worker:
            # nothing would be spoken or transcribed for the rest of the call.
            with self._synth_lock:
                if self._synth_worker is me:
                    self._synth_worker = None

    def _speak_one(self, gen, text):
        epoch = self._epoch
        try:
            for chunk_gen, pcm in self._synth.speak(text, gen):
                if epoch != self._epoch:
                    # open()/close() while this sentence was being generated:
                    # its audio is not the audio of the call that is running.
                    return
                self._emit(
                    "voice.speechAudio",
                    {"gen": chunk_gen, "chunk": encode_chunk(pcm, OUTPUT_SAMPLE_RATE)},
                )
            if not self._synth.is_cancelled(gen):
                self._emit("voice.speechDone", {"gen": gen})
        except Exception as error:  # noqa: BLE001 - a failed sentence is reported, not fatal
            if epoch != self._epoch:
                # The call ended while this sentence was being generated. The
                # Gate restarts `gen` every call, so a speechDone {gen} from a
                # dead call lands in the next one and ends its reply early.
                return
            self._emit(
                "voice.error",
                {"code": "tts_failed", "message": str(error), "fatal": False, "gen": gen},
            )
            # A generation that never announces itself leaves the Gate in
            # "speaking" for the rest of the call, so a failed one still says
            # it is done, and this thread goes on serving later jobs.
            self._emit("voice.speechDone", {"gen": gen})

    def _release(self, gen):
        """Drop the playback gate once the last sentence of a reply is done.

        Called under ``_synth_lock``, between jobs with the queue empty: a
        sentence about to be synthesised would hear its own loudspeaker.
        """
        # A newer generation owns the flags now; do not clear its state.
        if self._speech_gen == gen:
            self._synth_speaking = False
            self._speech_gen = None
        set_playback = getattr(self._vad, "set_playback", None)
        if callable(set_playback):
            set_playback(False)

    def _cancel_speech_jobs(self):
        """Stop every sentence still owed: queued ones are dropped, the running
        one is cancelled and stops at its next chunk."""
        with self._synth_lock:
            gens = {gen for gen, _text in self._synth_jobs}
            self._synth_jobs.clear()
        if self._running_gen is not None:
            gens.add(self._running_gen)
        for gen in gens:
            self._synth.cancel(gen)

    def cancelSpeech(self, params):
        gen = int((params or {}).get("gen", 0))
        self._synth.cancel(gen)
        with self._synth_lock:
            # A queued sentence of this generation is never spoken, so speech
            # for a newer generation does not wait behind it.
            self._synth_jobs = [job for job in self._synth_jobs if job[0] != gen]
            if self._speech_gen == gen:
                self._synth_speaking = False
                self._speech_gen = None
            # Nothing queued and nothing running means nothing is left to
            # protect from its own loudspeaker: the drain that would have lowered
            # the gate finds an empty queue and returns without doing it.
            if not self._synth_jobs and self._running_gen is None:
                set_playback = getattr(self._vad, "set_playback", None)
                if callable(set_playback):
                    set_playback(False)
        return {"ok": True}

    def setMuted(self, params):
        self._muted = bool((params or {}).get("muted"))
        return {"ok": True}

    def _queue_recognition(self, job):
        """Queue a decode for the recognition worker, keeping utterance order.

        A queued partial is replaced rather than stacked: every partial is
        another read of the same growing utterance, so only the newest is worth
        decoding. A final is never replaced — it is the turn itself.
        """
        with self._stt_lock:
            tail = self._stt_jobs[-1] if self._stt_jobs else None
            if job[0] == "partial" and tail is not None and tail[:2] == job[:2]:
                self._stt_jobs[-1] = job
            else:
                self._stt_jobs.append(job)
            idle = self._stt_worker is None
        if idle:
            self._spawn(self._drain_recognition)

    def _drain_recognition(self):
        """The one recognition worker: decodes in queue order until it is empty.

        The audio loop only ever queues here, so barge-in is heard while
        Whisper is still busy, and the queue is what keeps a partial ahead of
        the final of its own utterance.
        """
        me = object()
        with self._stt_lock:
            if self._stt_worker is not None:
                return
            self._stt_worker = me
        try:
            while True:
                with self._stt_lock:
                    if not self._stt_jobs:
                        self._stt_worker = None
                        return
                    job = self._stt_jobs.pop(0)
                self._recognise(job)
        finally:
            # As above: a worker that died must not silence recognition for the
            # rest of the process's life - and must not take a newer worker's
            # claim with it.
            with self._stt_lock:
                if self._stt_worker is me:
                    self._stt_worker = None

    def _recognise(self, job):
        kind, _utterance, pcm, early_end = job
        epoch = self._epoch
        try:
            text = self._transcriber.partial(pcm) if kind == "partial" else self._transcriber.final(pcm)
        except Exception as error:  # noqa: BLE001 - one bad decode is not the end of the call
            text = None
            failure = error
        else:
            failure = None
        if epoch != self._epoch:
            # open()/close() while this decode ran: neither its words nor its
            # failure belong to the call that is running now.
            return
        if failure is not None:
            self._emit(
                "voice.error",
                {"code": "stt_failed", "message": str(failure), "fatal": False, "gen": None},
            )
            return
        if not text:
            return
        if kind == "partial":
            self._emit("voice.partial", {"text": text})
        elif early_end:
            self._emit("voice.earlyEnd", {"text": text})
            self._emit("voice.final", {"text": text})
        else:
            self._emit("voice.final", {"text": text})


class RpcServer:
    """A newline-delimited JSON-RPC 2.0 loop over the pipeline."""

    def __init__(self, pipeline, sample_rate=None, out=None, record=True):
        self.pipeline = pipeline
        self.sample_rate = sample_rate or {
            "input": INPUT_SAMPLE_RATE,
            "output": OUTPUT_SAMPLE_RATE,
        }
        # `written` exists so tests can assert on the frames that went out. In
        # production it would hold a copy of every synthesised sentence of the
        # whole call (one base64 PCM blob each), so the real server records
        # nothing and writes only to `out`.
        self.written = []
        self._record = record
        self._out = out
        # Synthesis runs on its own thread (see VoicePipeline.speak); frames
        # from that thread and the stdin loop must not interleave mid-line.
        self._write_lock = threading.Lock()

    def _write(self, payload):
        line = json.dumps(payload)
        if self._record:
            self.written.append(line)
        if self._out is not None:
            with self._write_lock:
                self._out.write(line + "\n")
                self._out.flush()

    def emit(self, method, params):
        """A notification the pipeline sends to the Gate."""
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def announce_ready(self, device, load_ms):
        """Say the pipeline is loaded and can hear.

        Written once, before the loop reads a line: loading Whisper, Silero,
        Kokoro and Smart Turn takes tens of seconds, and a Gate told "listening"
        before that hears nothing at all — the operator's first sentence was
        recognised 17.9 s after the stream opened (VOW-1).
        """
        self.emit(
            "voice.ready",
            {"sampleRate": dict(self.sample_rate), "device": device, "loadMs": int(load_ms)},
        )

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
            if request_id is None:
                # A notification carries no id to answer. An id-less error frame
                # is discarded by the transport, so an exception in recognition
                # vanished and the call went deaf with nothing to show for it.
                self.emit(
                    "voice.error",
                    {"code": "handler_failed", "message": str(error), "fatal": False, "gen": None},
                )
                return
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


# The device the last `load_whisper` settled on. `voice.ready` names it: a
# silent CUDA→CPU fallback reads on the Gate as a slow call, not as a fallback.
_whisper_device = "cpu"


def whisper_device():
    """The device Whisper actually loaded on, "cpu" after a CUDA fallback."""
    return _whisper_device


def _log_whisper_device(device, error):
    """A silent CUDA→CPU fallback reads as slow voice, so name the device."""
    global _whisper_device
    _whisper_device = device
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
            # English is pinned (the engine speaks English; Kokoro is en-us):
            # auto-detection costs a full encoder pass per call, measured
            # 880 ms -> 580 ms with the loopback sentence still word for
            # word. Timestamps are never read; dropping them trims decode.
            language="en",
            without_timestamps=True,
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
    pipeline = VoicePipeline(
        # 96 ms of "speech" opened an utterance on a click or a breath, and
        # Whisper turned each one into "Thank you." on a live call (2026-09-19).
        vad=VadSegmenter(is_speech=SileroScorer(), start_ms=SPEECH_START_MS),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=turn,
        synthesizer=SpeechSynthesizer(KokoroSynthesizer(kokoro)),
        emit=emit,
        min_utterance_ms=MIN_UTTERANCE_MS,
    )
    pipeline.whisper_device = whisper_device()
    return pipeline


def main(argv=None):
    import argparse

    started = time.monotonic()
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
    server = RpcServer(pipeline, out=sys.stdout, record=False)
    # The first thing written, before a line of stdin is read: until this
    # arrives the worker is loading models and cannot hear anything.
    server.announce_ready(pipeline.whisper_device, (time.monotonic() - started) * 1000)
    server.serve(stdin=sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main())
