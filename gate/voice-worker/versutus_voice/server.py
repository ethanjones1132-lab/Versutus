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

_METHODS = ("open", "pushAudio", "speak", "cancelSpeech", "setMuted", "setPlayback", "close")
_PARTIAL_WINDOW_MS = 600
# How often an undecodable chunk is named on the wire; a bad stream sends
# hundreds of chunks a minute and stdout is the Gate's only channel.
_BAD_CHUNK_ERROR_SECONDS = 1.0
# Speech the VAD must hear before an utterance opens.
SPEECH_START_MS = 250
# How much audio past a final's end the worker must have scored before its
# "not hearing any more" is trustworthy. The Gate's own settle is measured in
# this audio, not in wall clock (VS-179): on a loaded PC the audio loop can be
# behind the resumed speech, and a hearing flag read before it catches up sent
# half an utterance.
HEARING_SETTLE_MS = 200
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
# Past this, Whisper is sure it heard no speech, and no confidence in the words
# buys the segment back: a television line transcribed word for word is still
# not the operator talking (VS-145). Above NO_SPEECH_PROB_MAX but below this,
# the words decide, because soft speech scores high no-speech while the model
# remains sure of them.
NO_SPEECH_PROB_DECISIVE = 0.8


def _is_non_speech(segment):
    """Whether Whisper's own scores say this segment is not the operator."""
    no_speech = getattr(segment, "no_speech_prob", 0.0) or 0.0
    logprob = getattr(segment, "avg_logprob", 0.0) or 0.0
    if no_speech > NO_SPEECH_PROB_DECISIVE:
        return True
    return no_speech > NO_SPEECH_PROB_MAX and logprob < AVG_LOGPROB_MIN


def join_spoken_segments(segments):
    """The text of the segments Whisper is confident were speech."""
    kept = [segment.text for segment in segments if not _is_non_speech(segment)]
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
        tts_config=None,
        record_tts=None,
    ):
        self._vad = vad
        self._min_utterance_bytes = int(INPUT_SAMPLE_RATE * 2 * min_utterance_ms / 1000)
        self._max_utterance_bytes = int(INPUT_SAMPLE_RATE * 2 * MAX_UTTERANCE_SECONDS)
        self._transcriber = transcriber
        self._turn = turn_judge
        self._synth = synthesizer
        self._tts_config = tts_config
        self._record_tts = record_tts
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
        self._warm_pending = False
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
        # The VAD's echo-gate count already reported to the Gate, so each new
        # refusal is named once rather than every audio chunk.
        self._echo_gated_reported = 0
        # The generation currently being synthesized, so VAD speech during it
        # is a barge-in rather than a new turn (§4.6 step 5).
        self._synth_speaking = False
        self._speech_gen = None
        # Whether the phone is still playing a reply, as the Gate's pacer says.
        # Synthesis can finish before the loudspeaker is quiet: the echo gate
        # and barge-in window follow playback, not the worker's queue.
        self._playout = False
        # Whether synthesis itself wants the VAD's playback gate up.
        self._synth_gate = False
        # A pause the turn judge was not sure about. Held rather than sent, so
        # it can be re-judged / forced / merged with resumed speech (§4.6 step 3).
        self._pending = None
        # "The operator is mid-utterance": speech is open, a pause is being
        # judged, or a final is still being decoded. The Gate commits a turn
        # only once this is false, instead of waiting out a fixed hold.
        self._finals_in_flight = 0
        self._hearing = False
        self._hearing_lock = threading.Lock()
        # The audio position the loop has actually scored, in ms from the call's
        # first frame. It travels with `voice.final`/`voice.hearing` so a settle
        # can be measured in audio rather than wall clock (VS-179).
        self._audio_ms = 0.0
        # The position past which the last final's silence is trustworthy, and
        # the position last announced to the Gate: a false `hearing` that the
        # Gate received before this point is repeated once it is reached.
        self._settle_target_ms = None
        self._hearing_announced_ms = 0.0
        # What voice.ready names: the device Whisper really ran on, so a silent
        # CUDA→CPU fallback is visible to the Gate and not only on stderr.
        self.whisper_device = "cpu"
        # Set again by open(); a pipeline driven without open() (tests, a warm
        # restart) still has a clock to stamp eosMs against.
        self._call_started_ms = time.time() * 1000.0

    def open(self, params):
        self._reset()
        self._session = (params or {}).get("voiceSessionId")
        self._call_started_ms = time.time() * 1000.0
        if self._tts_config is not None:
            if self._tts_is_idle():
                with self._synth_lock:
                    self._warm_pending = True
                    idle = self._synth_worker is None
                if idle:
                    # Do not hold the open acknowledgment or microphone for
                    # this. Reuse the synthesis lane; never run two inferences.
                    self._spawn(self._drain_speech)
            return {"ok": True, "ttsChunkWords": self._synth.chunk_words}
        return {"ok": True}

    def _tts_is_idle(self):
        return self._tts_config is not None and self._tts_config.should_prime_after_idle(self._synth)

    def close(self, params):
        # The process stays warm across calls, so ending one ends all of its
        # work: nothing may keep speaking or transcribing into the next call.
        self._reset()
        self._session = None
        return {"ok": True}

    def _reset(self):
        """Leave no trace of the last call behind (VOW-6).

        The Gate restarts generations at 0 for every call, so a cancellation
        the synthesizer still remembers would silence the whole next one. What
        the judge and the transcriber were given lives here, in ``_pending``,
        the buffers and the queues; only the judge's sure streak is its own, and
        it is reset with them.
        """
        self._epoch += 1
        self._cancel_speech_jobs()
        with self._stt_lock:
            self._stt_jobs.clear()
        self._muted = False
        self._speaking = False
        self._last_partial = 0
        self._last_bad_chunk = float("-inf")
        self._echo_gated_reported = 0
        self._utterance = 0
        self._synth_speaking = False
        self._speech_gen = None
        self._playout = False
        self._synth_gate = False
        self._pending = None
        with self._hearing_lock:
            # A new call starts quiet; nothing is announced for the old one.
            self._finals_in_flight = 0
            self._hearing = False
            self._audio_ms = 0.0
            self._settle_target_ms = None
            self._hearing_announced_ms = 0.0
        reset_turn = getattr(self._turn, "reset", None)
        if callable(reset_turn):
            reset_turn()
        self._buffer.clear()
        self._preroll = bytearray()
        self._synth.reset()
        self._vad.reset()

    def _set_playback_gate(self):
        """Raise the VAD's echo gate while the PC is generating or the phone is
        still playing a reply; lower it only when both have stopped."""
        set_playback = getattr(self._vad, "set_playback", None)
        if callable(set_playback):
            set_playback(self._synth_gate or self._playout)

    def _sync_hearing(self):
        """Tell the Gate when "the operator is mid-utterance" changes.

        Called after anything that can change it. The lock makes the announced
        value the state at the time of the announcement, so the last word the
        Gate hears is the true one whichever thread spoke last. Every word
        carries the audio position it was decided at: the Gate measures its
        settle in audio, so a false read from before the resumed speech was
        scored cannot commit half an utterance (VS-179).
        """
        with self._hearing_lock:
            # An onset the VAD is still counting is included: it takes 250 ms
            # of speech to open an utterance, and a turn committed inside that
            # quarter second is the first half of a sentence. Not while the
            # phone is playing a reply — what the VAD is weighing then is
            # mostly the loudspeaker, and nothing is waiting to be committed.
            starting = not self._playout and (getattr(self._vad, "onset_ms", 0) or 0) > 0
            active = bool(
                self._speaking
                or self._pending is not None
                or self._finals_in_flight > 0
                or starting
            )
            position = self._call_started_ms + self._audio_ms
            if active == self._hearing:
                # The flag did not change, but a final may have raised the
                # audio position its silence must reach. Repeat the same false
                # exactly once, when the loop has caught up to it, so the Gate
                # can let the held turn go without guessing with a clock.
                if (
                    not active
                    and self._settle_target_ms is not None
                    and self._hearing_announced_ms < self._settle_target_ms <= position
                ):
                    self._hearing_announced_ms = position
                    self._emit("voice.hearing", {"active": False, "positionMs": position})
                return
            self._hearing = active
            self._hearing_announced_ms = position
            self._emit("voice.hearing", {"active": active, "positionMs": position})

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
        # What has actually been scored, not merely received: the Gate measures
        # its settle against this (VS-179).
        with self._hearing_lock:
            self._audio_ms += chunk_ms
        if self._pending is not None and not self._speaking:
            self._pending["silence_ms"] += chunk_ms

        events = self._vad.stream(pcm)
        # Echo the playback gate refused is an endpointing outcome the Gate
        # audits. The VAD counts episodes; send only the new ones, so one
        # loudspeaker passage is one line on the call.
        echo_gated = getattr(self._vad, "echo_gated", 0)
        if echo_gated > self._echo_gated_reported:
            self._emit(
                "voice.echoGated",
                {"gen": self._speech_gen, "count": echo_gated - self._echo_gated_reported},
            )
        self._echo_gated_reported = echo_gated
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
                at_ms = getattr(event, "at_ms", None)
                eos_ms = self._call_started_ms + at_ms if at_ms is not None else None
                self._end_speech(eos_ms)

        # An utterance the VAD never closes would grow for the whole call and
        # be re-decoded from the start on every partial. Past the cap it ends
        # exactly as a speech-end would, and the audio that keeps arriving opens
        # the next one.
        if self._speaking and len(self._buffer) > self._max_utterance_bytes:
            self._end_speech(time.time() * 1000.0, force=True)
            self._utterance += 1
            self._speaking = True
            self._last_partial = 0

        if self._pending is not None and not self._speaking:
            pending = self._pending
            # Speech the VAD is in the middle of opening is the person carrying
            # on: it takes 250 ms to count as an onset, and a pause judged over
            # in that window would send the first half of one sentence.
            resuming = (getattr(self._vad, "onset_ms", 0) or 0) > 0
            if pending["silence_ms"] >= pending["next_judge_ms"] and not resuming:
                if self._turn.decide(pending["pcm"], pending["silence_ms"]) == "complete":
                    held = pending["pcm"]
                    self._pending = None
                    self._finalize(held, pending["eos_ms"])
                else:
                    # Look again a step later, but never past the force point —
                    # decide() forces completion once silence passes it.
                    step = getattr(self._turn, "rejudge_step_ms", None) or self._turn.rejudge_ms
                    pending["next_judge_ms"] = min(
                        pending["silence_ms"] + step,
                        self._turn.force_ms,
                    )

        if self._speaking:
            window_bytes = int(INPUT_SAMPLE_RATE * _PARTIAL_WINDOW_MS / 1000) * 2
            if len(self._buffer) - self._last_partial >= window_bytes:
                self._last_partial = len(self._buffer)
                self._queue_recognition(("partial", self._utterance, self._partial_pcm(), False, None))
        self._sync_hearing()
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
        if self._synth_speaking or self._playout:
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
        # The pause this streak belonged to is over; the new one starts at zero.
        reset_turn = getattr(self._turn, "reset", None)
        if callable(reset_turn):
            reset_turn()
        self._speaking = True
        self._last_partial = 0
        self._utterance += 1
        self._buffer = bytearray(held) + (b"" if held else before) + pcm
        self._preroll = bytearray()
        # The person is talking, whatever the PC is doing. While a reply is
        # audible that is the barge-in above; while a turn is still being
        # thought about, it is the Gate's cue to take that turn back and wait
        # for the rest of the sentence.
        self._emit("voice.utteranceOpen", {})

    def _end_speech(self, eos_ms, force=False):
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
            self._finalize(held["pcm"], held["eos_ms"])
        self._speaking = False
        if not self._buffer:
            return
        utterance = bytes(self._buffer)
        self._buffer.clear()
        self._last_partial = 0
        if force:
            self._finalize(utterance, eos_ms)
        elif self._turn is None:
            # No Smart Turn installed: a pause ends the turn.
            self._finalize(utterance, eos_ms)
        elif len(utterance) < self._min_utterance_bytes:
            # A blip is not a turn, however confident the judge.
            return
        elif self._turn.confident(utterance, silence_ms=self._vad.silence_ms):
            # A confident verdict at the first pause is an early end: the Gate
            # may start the Bot turn before the final.
            self._finalize(utterance, eos_ms, early_end=True)
        else:
            # An unsure verdict is a thinking pause. Hold it and
            # re-judge at 600 ms of silence, forcing at 1.6 s. A pause is a new
            # verdict, so it starts without the last one's sure streak.
            reset_turn = getattr(self._turn, "reset", None)
            if callable(reset_turn):
                reset_turn()
            self._pending = {
                "pcm": utterance,
                "eos_ms": eos_ms,
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

    def _finalize(self, pcm, eos_ms=None, early_end=False):
        # Too short to be a sentence: a cough or a door is not a turn, and
        # sending it is what made calls "send prematurely".
        if len(pcm) < self._min_utterance_bytes:
            return
        self._queue_recognition(("final", self._utterance, pcm, early_end, eos_ms))

    def speak(self, params):
        params = params or {}
        gen = int(params.get("gen", 0))
        text = str(params.get("text", ""))
        tts_id = params.get("ttsId")
        split_opening = params.get("splitOpening", True) is True
        opening_words = params.get("openingPrefixWords")
        if type(opening_words) is not int or not 6 <= opening_words <= 10:
            opening_words = 0
        # While the PC speaks, the mic hears the loudspeaker too: the phone's
        # AEC eats most of it, but what leaks through must not open speech, or
        # the Bot would barge in on itself. The VAD gates harder until the
        # generation ends; a real operator talking still opens (and cancels).
        # Raised inside the queue's lock, so it cannot be undone by a worker
        # that decided the queue was empty a moment earlier.
        with self._synth_lock:
            self._synth_speaking = True
            self._speech_gen = gen
            self._synth_gate = True
            self._set_playback_gate()
            self._synth_jobs.append((gen, text, time.monotonic(), tts_id, self._epoch, split_opening, opening_words))
            idle = self._synth_worker is None
        # The lane renders in order but never waits for phone playback: it can
        # start the next sentence while the pacer is still sending the last one.
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
                    if self._synth_jobs:
                        job = self._synth_jobs.pop(0)
                        self._running_gen = job[0]
                        self._warm_pending = False  # real speech takes priority
                    elif self._warm_pending:
                        self._warm_pending = False
                        job = None
                    else:
                        self._synth_worker = None
                        return
                if job is None:
                    if self._session is not None and self._tts_is_idle():
                        _warm_tts(self._synth, "idle")
                    continue
                gen = job[0]
                try:
                    self._speak_one(*job)
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

    def _speak_one(self, gen, text, queued_at, tts_id, epoch, split_opening, opening_words):
        def stale():
            return epoch != self._epoch

        queue_ms = round((time.monotonic() - queued_at) * 1000)
        job = {"ttsId": tts_id} if tts_id is not None else {}
        last_synth_ms = None
        try:
            audio = self._synth.timed_audio(
                text, gen, stale=stale, split_opening=split_opening, opening_prefix_words=opening_words,
            )
            for pcm, sentence, synth_ms in audio:
                if stale():
                    # open()/close() while this sentence was being generated:
                    # its audio is not the audio of the call that is running.
                    return
                params = {"gen": gen, "chunk": encode_chunk(pcm, OUTPUT_SAMPLE_RATE)}
                if synth_ms is not None:
                    # A speak can batch multiple completed sentences. For the
                    # later ones, the worker wait includes earlier sentences.
                    params.update(job, sentence=sentence, synthMs=synth_ms, queueMs=(
                        queue_ms if sentence == 1 else
                        max(0, round((self._synth.last_used - queued_at) * 1000) - synth_ms)
                    ))
                    last_synth_ms = synth_ms
                self._emit("voice.speechAudio", params)
            if not stale() and not self._synth.is_cancelled(gen):
                self._emit("voice.speechDone", {"gen": gen, **job})
        except Exception as error:  # noqa: BLE001 - a failed sentence is reported, not fatal
            if stale():
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
            self._emit("voice.speechDone", {"gen": gen, **job})
        finally:
            if last_synth_ms is not None and self._record_tts is not None and not stale():
                self._record_tts(last_synth_ms)

    def _release(self, gen):
        """Drop the playback gate once the last sentence of a reply is done.

        Called under ``_synth_lock``, between jobs with the queue empty: a
        sentence about to be synthesised would hear its own loudspeaker.
        """
        # A newer generation owns the flags now; do not clear its state.
        if self._speech_gen == gen:
            self._synth_speaking = False
            self._speech_gen = None
        self._synth_gate = False
        self._set_playback_gate()

    def _cancel_speech_jobs(self):
        """Stop every sentence still owed: queued ones are dropped, the running
        one is cancelled and stops at its next chunk."""
        with self._synth_lock:
            gens = {job[0] for job in self._synth_jobs}
            self._synth_jobs.clear()
            self._warm_pending = False
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
                self._synth_gate = False
                self._set_playback_gate()
        return {"ok": True}

    def setMuted(self, params):
        muted = bool((params or {}).get("muted"))
        if muted and not self._muted:
            # Mute ends what was being heard: the phone stops sending, so an
            # utterance left open here would never close, and its first half
            # would be glued onto whatever is said after unmute.
            self._speaking = False
            self._pending = None
            self._buffer.clear()
            self._preroll = bytearray()
            self._last_partial = 0
            self._vad.reset()
            self._set_playback_gate()
        self._muted = muted
        self._sync_hearing()
        return {"ok": True}

    def setPlayback(self, params):
        """The Gate's word on whether the phone is playing a reply right now."""
        self._playout = bool((params or {}).get("on"))
        with self._synth_lock:
            self._set_playback_gate()
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
                if job[0] == "final":
                    # A partial still queued is an older read of audio the final
                    # is about to decode in full: decoding it first only delays
                    # the turn by one more Whisper pass.
                    self._stt_jobs = [queued for queued in self._stt_jobs if queued[0] != "partial"]
                    with self._hearing_lock:
                        self._finals_in_flight += 1
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
        epoch = self._epoch
        try:
            self._recognise_job(job)
        finally:
            if job[0] == "final" and epoch == self._epoch:
                with self._hearing_lock:
                    self._finals_in_flight = max(0, self._finals_in_flight - 1)
                # After the final itself, so the Gate hears the words before it
                # hears that the operator has stopped.
                self._sync_hearing()

    def _recognise_job(self, job):
        kind, _utterance, pcm, early_end, eos_ms = job
        epoch = self._epoch
        decode_started = time.perf_counter()
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
            if kind == "final":
                # Whisper found no speech it trusts in a final utterance. The
                # call did not hear a turn, but the drop is counted so a noisy
                # line reads differently from a quiet one (O2).
                self._emit("voice.noSpeechDrop", {"gen": None})
            return
        if kind == "partial":
            self._emit("voice.partial", {"text": text})
        else:
            decode_ms = (time.perf_counter() - decode_started) * 1000.0
            if early_end:
                self._emit("voice.earlyEnd", {"text": text})
            payload = {"text": text, "decodeMs": decode_ms}
            with self._hearing_lock:
                # The Gate waits for its settle past `eosMs` in this audio, not
                # in wall clock: a loop behind the resumed speech must not let a
                # half-utterance go (VS-179).
                payload["positionMs"] = self._call_started_ms + self._audio_ms
                if eos_ms is not None:
                    self._settle_target_ms = eos_ms + HEARING_SETTLE_MS
            if eos_ms is not None:
                payload["eosMs"] = eos_ms
            self._emit("voice.final", payload)


class LazyPipeline:
    """The worker's RPC target, with the models loaded by the first call.

    Whisper, Silero, Kokoro and Smart Turn together hold about 4.7 GB. Loaded
    at start, they sat in memory from the moment anything asked whether voice
    was available until the Gate went down, on a PC that had no call. Here the
    process is up and answering at once, and the first ``voice.open`` pays the
    load: its acknowledgment is held until the pipeline can hear, which is the
    signal the Gate already waits on before it tells the phone "listening".
    """

    def __init__(self, build):
        self._build = build
        self._pipeline = None
        self._lock = threading.Lock()
        self.whisper_device = None
        self.load_ms = None

    @property
    def loaded(self):
        return self._pipeline is not None

    def load(self):
        with self._lock:
            if self._pipeline is None:
                started = time.monotonic()
                pipeline = self._build()
                self.load_ms = int((time.monotonic() - started) * 1000)
                self.whisper_device = pipeline.whisper_device
                self._pipeline = pipeline
                print(
                    f"[versutus-voice] models loaded for first call loadMs={self.load_ms} device={self.whisper_device}",
                    file=sys.stderr,
                )
        return self._pipeline

    def open(self, params):
        return self.load().open(params)

    def close(self, params):
        if self._pipeline is None:
            return {"ok": True}
        return self._pipeline.close(params)

    def _delegate(self, name, params):
        if self._pipeline is None:
            # Only reachable out of order: the Gate sends nothing but open
            # before open is acknowledged. Answered, never a model load.
            return {"ok": False, "error": "voice models are not loaded; voice.open first"}
        return getattr(self._pipeline, name)(params)

    def pushAudio(self, params):
        return self._delegate("pushAudio", params)

    def speak(self, params):
        return self._delegate("speak", params)

    def cancelSpeech(self, params):
        return self._delegate("cancelSpeech", params)

    def setMuted(self, params):
        return self._delegate("setMuted", params)

    def setPlayback(self, params):
        return self._delegate("setPlayback", params)


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

    def announce_ready(self, device, load_ms, deferred=False):
        """Say the worker is up and will answer.

        Written once, before the loop reads a line. Eager, it also means the
        pipeline is loaded and can hear. Deferred (``models: "deferred"``), the
        models load inside the first ``voice.open``, whose acknowledgment is
        held until they can hear — a Gate told "listening" before the load
        hears nothing at all (VOW-1).
        """
        params = {"sampleRate": dict(self.sample_rate), "device": device, "loadMs": int(load_ms)}
        if deferred:
            params["models"] = "deferred"
        self.emit("voice.ready", params)

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


def force_cpu(models_dir):
    return (Path(models_dir).parent / "force-cpu").is_file()


def build_default_pipeline(emit, models_dir, cpu=False):
    """The real pipeline. Smart Turn falls back to 'a pause is a turn' when absent."""
    from contextlib import redirect_stdout
    from dataclasses import replace

    from .kokoro import load_kokoro_speech, read_tts_config, record_tts_latency, record_tts_profile
    from .stt import PartialTranscriber
    from .vad import VadSegmenter

    cpu = cpu or force_cpu(models_dir)
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

    config = read_tts_config(models_dir)
    if cpu:
        config = replace(config, provider="cpu")

    def report_profile(profile):
        record_tts_profile(models_dir, profile)

    def load_speech():
        return load_kokoro_speech(models_dir, config, on_profile_change=report_profile)

    # ORT may print to stdout when it cannot initialize a provider. Stdout on
    # the worker is reserved for RPC, even before voice.ready.
    with redirect_stdout(sys.stderr):
        speech = _warm_models(transcribe, load_speech, config)
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
        synthesizer=speech,
        emit=emit,
        min_utterance_ms=MIN_UTTERANCE_MS,
        tts_config=config,
        record_tts=lambda synth_ms: record_tts_latency(models_dir, speech.synthesize.profile(), synth_ms),
    )
    pipeline.whisper_device = whisper_device()
    profile = speech.synthesize.profile()
    report_profile(profile)
    print(f"[versutus-voice] kokoro profile={json.dumps(profile)}", file=sys.stderr)
    return pipeline


def _warm_models(transcribe, load_speech, config):
    """Pay each model's first-inference cost before a call can.

    A model's first run allocates and compiles: measured on this host the
    first Whisper decode took about a second longer than the ones after it and
    the first Kokoro sentence twice as long, and both landed on the first turn
    of the first call after the worker loaded. The worker is not announced
    ready until this is done, so nobody is listening to that delay. A warm-up
    that fails is not a reason not to start: the call would have paid the same
    cost, and a model that is really broken says so on its first real use.
    """
    # Warm Whisper before auto Kokoro validates CUDA, so Whisper allocates its
    # working memory first. A failed CUDA validation then leaves Kokoro on CPU.
    try:
        transcribe(b"\x00\x00" * INPUT_SAMPLE_RATE, 1)
    except Exception as error:  # noqa: BLE001 - warm-up is best effort
        print(f"[versutus-voice] whisper warm-up skipped ({error})", file=sys.stderr)
    speech = load_speech()
    if config.warmup != "off":
        if speech.startup_warmup_ms is None:
            _warm_tts(speech, "startup")
        else:
            print(f"[versutus-voice] kokoro warm-up stage=startup ms={speech.startup_warmup_ms}", file=sys.stderr)
    return speech


def _warm_tts(speech, stage):
    try:
        print(f"[versutus-voice] kokoro warm-up stage={stage} ms={speech.prime()}", file=sys.stderr)
    except Exception as error:  # noqa: BLE001 - warm-up is best effort
        print(f"[versutus-voice] kokoro warm-up stage={stage} failed ({type(error).__name__})", file=sys.stderr)


def main(argv=None):
    import argparse

    started = time.monotonic()
    parser = argparse.ArgumentParser(description="Versutus local voice worker")
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument(
        "--eager",
        action="store_true",
        help="load every model before announcing ready, instead of on the first voice.open",
    )
    args = parser.parse_args(argv)

    server = None

    def build():
        return build_default_pipeline(
            emit=lambda method, params: server.emit(method, params),
            models_dir=args.models_dir,
            cpu=args.cpu,
        )

    if args.eager:
        pipeline = build()
        server = RpcServer(pipeline, out=sys.stdout, record=False)
        # The first thing written, before a line of stdin is read: until this
        # arrives the worker is loading models and cannot hear anything.
        server.announce_ready(pipeline.whisper_device, (time.monotonic() - started) * 1000)
    else:
        pipeline = LazyPipeline(build)
        server = RpcServer(pipeline, out=sys.stdout, record=False)
        server.announce_ready(None, (time.monotonic() - started) * 1000, deferred=True)
    server.serve(stdin=sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main())
