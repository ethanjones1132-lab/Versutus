/**
 * Generates assets/images/grain.png — a 256×256 RGBA film-grain tile used by
 * AmbientCanvas at low opacity to give the background a photographic texture.
 *
 * Deterministic (fixed seed) so the asset is reproducible: run
 *   npx tsx scripts/gen-grain.mts
 * Any change to constants below intentionally changes the tile.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SIZE = 256;
const SEED = 'versutus-grain-01';
// Brightness spread — dark noise reads as texture; near-black pixels stay in
// the ambient range instead of speckling the UI with visible dots.
const MAX_LUMA = 42;
const MIN_ALPHA = 14;
const MAX_ALPHA = 34;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(BigInt('0x' + createHash('sha256').update(SEED).digest('hex').slice(0, 8))));

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4)); // 1 filter byte per scanline
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const p = rowStart + 1 + x * 4;
    const luma = Math.floor(rand() * MAX_LUMA);
    const alpha = MIN_ALPHA + Math.floor(rand() * (MAX_ALPHA - MIN_ALPHA));
    raw[p] = 255 - luma;
    raw[p + 1] = 255 - luma;
    raw[p + 2] = 255 - luma;
    raw[p + 3] = alpha;
  }
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
// compression 0, filter 0, interlace 0 — already zeroed

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../assets/images/grain.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes) with seed "${SEED}"`);