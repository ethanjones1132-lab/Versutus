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
    this._tail = '';
    mkdirSync(dir, { recursive: true });
  }

  get path() {
    return join(this.dir, this.name);
  }

  /** Append a chunk from `source` ('gate' or 'supervisor') as timestamped lines. */
  write(source, chunk) {
    const lines = String(chunk ?? '').split(/\r?\n/);
    // A chunk that does not end in a newline is half a line: hold it back
    // until the rest arrives so the prefix lands on whole lines only.
    if (!String(chunk ?? '').endsWith('\n')) {
      this._tail += lines.pop() ?? '';
    }
    const stamp = new Date().toISOString();
    for (const line of lines) {
      const text = `${this._tail}${line}`;
      this._tail = '';
      if (text === '') continue;
      this._rotate();
      appendFileSync(this.path, `${stamp} [${source}] ${redact(text)}\n`, 'utf8');
    }
  }

  /** Flush a held partial line (shutdown path). */
  close() {
    if (this._tail === '') return;
    this._rotate();
    appendFileSync(this.path, `${new Date().toISOString()} [supervisor] ${redact(this._tail)}\n`, 'utf8');
    this._tail = '';
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

function redact(line) {
  return line.replace(/^Token: .*$/, 'Token: [redacted]');
}
