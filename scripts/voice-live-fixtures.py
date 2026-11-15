"""Speech fixtures for scripts/voice-live.mjs, synthesised on this host.

Run with the Gate's voice venv python. Each utterance in the manifest is spoken
by Kokoro in a voice other than the reply's, resampled to the phone's capture
format (16 kHz mono PCM16) and written as raw PCM, one file per segment. Nothing
is recorded from a microphone and nothing is added to the repo: the output
directory is a cache the harness can always rebuild.

Usage: python voice-live-fixtures.py <models-dir> <manifest.json> <out-dir>
"""

import json
import os
import sys

import numpy as np


def main(models_dir, manifest_path, out_dir):
    from kokoro_onnx import Kokoro

    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    os.makedirs(out_dir, exist_ok=True)
    kokoro = Kokoro(
        os.path.join(models_dir, "kokoro-v1.0.onnx"),
        os.path.join(models_dir, "voices-v1.0.bin"),
    )
    voice = manifest.get("voice", "am_michael")
    written = []
    for utterance in manifest["utterances"]:
        for index, segment in enumerate(utterance["segments"]):
            name = f"{utterance['id']}-{index}.pcm"
            path = os.path.join(out_dir, name)
            if not os.path.exists(path):
                samples, rate = kokoro.create(segment["text"], voice=voice, speed=1.0, lang="en-us")
                samples = np.asarray(samples, dtype=np.float32)
                # Linear resample to the capture rate; speech band, test audio.
                target = int(round(len(samples) * 16000 / rate))
                grid = np.linspace(0, len(samples) - 1, target)
                resampled = np.interp(grid, np.arange(len(samples)), samples)
                # Kokoro pads its clips with silence. Trimmed, so "the moment
                # the person stopped" in the harness is the last audible sample.
                audible = np.flatnonzero(np.abs(resampled) > 0.01)
                if audible.size:
                    resampled = resampled[audible[0] : audible[-1] + 1]
                pcm = np.clip(resampled * 32767.0, -32768, 32767).astype("<i2")
                pcm.tofile(path)
            written.append(name)
    print(json.dumps({"dir": out_dir, "files": written}))


if __name__ == "__main__":
    main(*sys.argv[1:4])
