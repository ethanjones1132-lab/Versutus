"""Generate a labelled, synthetic release-bar corpus with the Gate voice venv."""

import json
from pathlib import Path
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro


RATE = 16_000


def save_wav(directory, name, samples):
    with wave.open(str(directory / name), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(np.clip(samples * 32767, -32768, 32767).astype("<i2").tobytes())


def synth(voice, text, speaker="am_michael"):
    audio, rate = voice.create(text, voice=speaker, speed=1.0, lang="en-us")
    audio = np.asarray(audio, dtype=np.float32)
    size = int(round(len(audio) * RATE / rate))
    resampled = np.interp(np.arange(size) * rate / RATE, np.arange(len(audio)), audio)
    audible = np.flatnonzero(np.abs(resampled) > 0.01)
    if not audible.size:
        raise ValueError("Kokoro returned no audible speech")
    return resampled[audible[0] : audible[-1] + 1]


def chunks(rng, seconds, kind, tv):
    """Repeatable *proxies* for noise. Use observed rooms to certify F5."""
    samples = rng.normal(0, 0.002, seconds * RATE)
    if kind == "tv":
        for start in range(0, len(samples), len(tv) + RATE // 2):
            part = tv[: len(samples) - start]
            samples[start : start + len(part)] += 0.20 * part
    elif kind == "kitchen":
        times = np.arange(RATE // 3) / RATE
        for start in range(RATE // 3, len(samples), RATE // 2):
            ring = 0.17 * np.sin(2 * np.pi * rng.integers(370, 2200) * times) * np.exp(-22 * times)
            ring = ring[: len(samples) - start]
            samples[start : start + len(ring)] += ring
    elif kind == "cough":
        for start in range(RATE, len(samples), RATE * 3):
            size = min(len(samples) - start, RATE // 3)
            time = np.arange(size) / RATE
            envelope = (np.sin(5 * np.pi * time) ** 2) * np.exp(-7 * time)
            air = rng.normal(0, 1, size)
            throaty = np.sin(2 * np.pi * (115 * time - 30 * time**2))
            samples[start : start + size] += 0.31 * envelope * (0.65 * throaty + 0.35 * air)
    else:
        for start in range(RATE // 5, len(samples), RATE // 3):
            size = min(len(samples) - start, 120)
            samples[start : start + size] += 0.4 * rng.normal(0, 1, size) * np.exp(-np.arange(size) / 14)
    return samples


def main(models_dir, directory, noise_seconds=30):
    models = Path(models_dir)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError("use an empty output directory; the generator will not overwrite a corpus")
    rng = np.random.default_rng(46054)
    voice = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
    clips = []

    def add_speech(name, reference, audio, **labels):
        wav = f"{name}.wav"
        save_wav(directory, wav, audio)
        clip = dict(id=name, wav=wav, kind="speech", reference=reference,
                    source="synthetic", speechEndMs=len(audio) * 1000 / RATE, **labels)
        clips.append(clip)
        return clip

    prompts = [
        "Can you tell me which museum is open after lunch?",
        "Please explain why the other plan did not work.",
        "What would be a good breakfast before a long ride?",
        "Could you compare the first two items on the list?",
        "What are my options if the weather gets worse?",
        "Does the library have a copy that I can borrow?",
        "I think I left the receipt in the blue folder.",
        "Would you read the second sentence again?",
        "Can you help me make this paragraph shorter?",
        "Which train should we take to get there before dark?",
        "How long would it take to walk around the lake?",
        "What did we decide when we talked on Tuesday?",
        "The yellow envelope is the one I was looking for.",
        "What is the difference between these two shades?",
        "I need a quiet place to work for about an hour.",
    ]
    for index, sentence in enumerate(prompts, 1):
        for speaker in ("am_michael", "af_heart"):
            clip = add_speech(f"clean-{index:02d}-{speaker[:2]}", sentence, synth(voice, sentence, speaker))
            if len(clips) < 40 and index <= 10:
                clips.append(dict(clip, id=clip["id"].replace("clean", "echo"), kind="echo"))

    phrases = [
        ("I think the best option is,", "the one you suggested yesterday."),
        ("Can you show me the list of,", "places that are still open?"),
        ("Could you remind me where I left,", "the map with the green markings?"),
        ("The train leaves just after,", "the shop closes for lunch."),
    ]
    for index, (left, right) in enumerate(phrases):
        first, rest = synth(voice, left), synth(voice, right)
        for pause in (500, 1000, 1500, 1750, 2500, 3000):
            audio = np.concatenate([first, np.zeros(pause * RATE // 1000), rest])
            add_speech(f"pause-{index}-{pause}", f"{left} {right}", audio, pauseMs=pause)

    tv = synth(voice, "The next program begins after these messages. We will return in just a moment.", "af_heart")
    for kind in ("tv", "kitchen", "cough", "click"):
        name = f"noise-{kind}.wav"
        save_wav(directory, name, chunks(rng, noise_seconds, kind, tv))
        clips.append(dict(id=f"noise-{kind}", wav=name, kind="noise", noiseKind=kind, source="synthetic"))

    manifest = directory / "corpus.json"
    manifest.write_text(json.dumps(dict(version=1, clips=clips), indent=2) + "\n", encoding="utf-8")
    print(manifest)


if __name__ == "__main__":
    main(*sys.argv[1:3], int(sys.argv[3]) if len(sys.argv) > 3 else 30)
