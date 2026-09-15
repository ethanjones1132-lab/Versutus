import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The supervisor's log: synchronous appends to `<dir>/gate.log`, rotated at
 * 10 MB keeping 5 generations (`gate.log.1…5`). Synchronous on purpose — the
 * supervisor writes a few lines per lifecycle event, and an async writer
 * would need its own flush-on-crash story.
 *
 * Every line is prefixed with an ISO timestamp and its source, partial
 * chunks are split into lines, and the Gate bootstrap token never lands on
 * disk (`Token: …` is redacted — `gate start` prints it to stdout and the
 * supervisor captures that stream).
 */
export class RotatingLog {
  constructor(dir, { name = 'gate.log', maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
    this.dir = dir;
    this.name = name;
    this.maxBytes = maxBytes;
    this.keep = keep;
    // Held half lines, one per stream: the child's stdout and stderr and the
    // supervisor's own lines interleave, and a half line from one must never
    // be glued onto another's text — that splice is how `Token:` escaped
    // redaction.
    this._tails = new Map();
    mkdirSync(dir, { recursive: true });
  }

  get path() {
    return join(this.dir, this.name);
  }

  /**
   * Append a chunk from `source` ('gate' or 'supervisor') as timestamped
   * lines. `stream` keys the held half line: pass distinct keys for streams
   * that interleave under one source (the child's stdout and stderr).
   */
  write(source, chunk, stream = source) {
    const key = JSON.stringify([source, stream]);
    // Join first, then split: the held half line belongs in front of this
    // chunk's first line, and whatever follows the chunk's last newline is
    // the new half line.
    const lines = `${this._tails.get(key)?.text ?? ''}${String(chunk ?? '')}`.split(/\r?\n/);
    const tail = lines.pop() ?? '';
    if (tail === '') this._tails.delete(key);
    else this._tails.set(key, { source, text: tail });
    const stamp = new Date().toISOString();
    for (const line of lines) {
      if (line !== '') this._append(stamp, source, line);
    }
  }

  /** Flush every held half line under its own source (shutdown path). */
  close() {
    const stamp = new Date().toISOString();
    for (const { source, text } of this._tails.values()) {
      const line = text.replace(/\r$/, '');
      if (line !== '') this._append(stamp, source, line);
    }
    this._tails.clear();
  }

  _append(stamp, source, line) {
    this._rotate();
    appendFileSync(this.path, `${stamp} [${source}] ${redact(line)}\n`, 'utf8');
  }

  _rotate() {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    rmSync(join(this.dir, `${this.name}.${this.keep}`), { force: true });
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      try {
        renameSync(join(this.dir, `${this.name}.${i}`), join(this.dir, `${this.name}.${i + 1}`));
      } catch {
        // A missing generation is not an error — just a short history.
      }
    }
    renameSync(this.path, join(this.dir, `${this.name}.1`));
  }
}

/** A `Token:` value is redacted wherever it appears in the line, not only at its start. */
function redact(line) {
  return line.replace(/(Token:\s*)\S+/g, '$1[redacted]');
}
