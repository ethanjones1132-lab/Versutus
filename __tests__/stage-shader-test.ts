/**
 * The lamp shader, run for real. The native stage is a Skia runtime effect;
 * CanvasKit is Skia compiled to WebAssembly, so these tests compile the exact
 * SkSL the phone runs and render it on the CPU — then judge the pixels it
 * produces, not the code that produces them. The web renders the same core
 * (GLSL wrapper, identical lighting), checked for parity by source below.
 */

import { BOT_CREST_TONES, botCrestFromId } from '@/lib/bot-avatar';
import { STAGE_GAIN, STAGE_TIMING, stageUniforms, type StageFrame } from '@/lib/stage/choreography';
import {
  STAGE_BASE,
  STAGE_TEXT_FLOOR_HEX,
  contrastRatio,
  hexToLinear,
  luminance,
  srgbToLinear,
  stageLightsFor,
  type StageLights,
} from '@/lib/stage/lamp';
import { STAGE_SHADER_CORE, STAGE_SHADER_GLSL, STAGE_SHADER_SKSL, STAGE_UNIFORM_LAYOUT } from '@/lib/stage/shader';

declare const __dirname: string;

type CanvasKitLike = {
  RuntimeEffect: { Make(source: string, onError: (error: string) => void): EffectLike | null };
  MakeSurface(width: number, height: number): SurfaceLike;
  Paint: new () => { setShader(shader: unknown): void; delete(): void };
  ColorType: { RGBA_8888: unknown };
  AlphaType: { Unpremul: unknown };
  ColorSpace: { SRGB: unknown };
};
type EffectLike = {
  makeShader(uniforms: number[]): { delete(): void };
  getUniformCount(): number;
  getUniformFloatCount(): number;
};
type SurfaceLike = {
  getCanvas(): { drawPaint(paint: unknown): void };
  makeImageSnapshot(): {
    readPixels(x: number, y: number, info: Record<string, unknown>): Uint8Array;
    delete(): void;
  };
  delete(): void;
};

const W = 64;
const H = 139; // a phone's proportions (430 × 932) at under a sixth of its points

let ck: CanvasKitLike;
let effect: EffectLike;

beforeAll(async () => {
  // jest-expo installs a TextDecoder polyfill that cannot decode UTF-16,
  // which CanvasKit's loader needs; Node's own decoder can.
  const { TextDecoder } = jest.requireActual('util') as { TextDecoder: unknown };
  (globalThis as { TextDecoder: unknown }).TextDecoder = TextDecoder;
  const path = jest.requireActual('path') as { join(...parts: string[]): string };
  const dir = path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'full');
  const init = jest.requireActual(path.join(dir, 'canvaskit.js')) as (options: {
    locateFile(file: string): string;
  }) => Promise<CanvasKitLike>;
  ck = await init({ locateFile: (file) => path.join(dir, file) });
  const errors: string[] = [];
  const made = ck.RuntimeEffect.Make(STAGE_SHADER_SKSL, (error) => errors.push(error));
  if (!made) throw new Error(`the stage's SkSL did not compile:\n${errors.join('\n')}`);
  effect = made;
}, 60_000);

type Pixels = { rgb: Uint8Array; luminance: Float64Array };

function render(lights: StageLights, frame: Partial<StageFrame> = {}): Pixels {
  const uniforms = stageUniforms({
    width: W,
    height: H,
    pixelRatio: 1,
    timeSec: 41.5,
    lights,
    gain: 1,
    swellElapsedMs: null,
    scroll: 0,
    tiltX: 0,
    tiltY: 0,
    ...frame,
  });
  const flat: number[] = [];
  for (const [name] of STAGE_UNIFORM_LAYOUT) {
    const value = uniforms[name];
    if (typeof value === 'number') flat.push(value);
    else flat.push(...value);
  }
  const shader = effect.makeShader(flat);
  const paint = new ck.Paint();
  paint.setShader(shader);
  const surface = ck.MakeSurface(W, H);
  surface.getCanvas().drawPaint(paint);
  const image = surface.makeImageSnapshot();
  const rgba = image.readPixels(0, 0, {
    width: W,
    height: H,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  image.delete();
  surface.delete();
  paint.delete();
  shader.delete();
  const rgb = new Uint8Array(W * H * 3);
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    rgb.set([r, g, b], i * 3);
    lum[i] = luminance([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]);
  }
  return { rgb, luminance: lum };
}

/**
 * Mean of a horizontal band of rows, given as fractions of the height. `light`
 * is what the lamp adds over the black stage — ratios of raw luminance are
 * capped by the stage's own floor and would hide how dark the dark is.
 */
function band(
  pixels: Pixels,
  top: number,
  bottom: number,
): { luminance: number; light: number; rgb: [number, number, number] } {
  let sum = 0;
  const rgb: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let y = Math.floor(top * H); y < Math.floor(bottom * H); y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      sum += pixels.luminance[i];
      for (let c = 0; c < 3; c += 1) rgb[c] += pixels.rgb[i * 3 + c];
      count += 1;
    }
  }
  const mean = sum / count;
  return {
    luminance: mean,
    light: Math.max(0, mean - luminance(STAGE_BASE)),
    rgb: rgb.map((v) => v / count) as [number, number, number],
  };
}

/** One Bot id per crest tone, so every room colour the app can show is rendered. */
function oneBotPerTone(): string[] {
  const ids: string[] = [];
  for (let n = 0; ids.length < BOT_CREST_TONES.length && n < 5000; n += 1) {
    const id = `bot-${n}`;
    const tone = botCrestFromId(id).tone;
    if (!ids.some((known) => botCrestFromId(known).tone === tone)) ids.push(id);
  }
  return ids;
}

const LOBBY = stageLightsFor({ kind: 'lobby' });
const FLOOR = luminance(hexToLinear(STAGE_TEXT_FLOOR_HEX));

describe('the stage shader', () => {
  test('web and native run one lighting core', () => {
    expect(STAGE_SHADER_GLSL).toContain(STAGE_SHADER_CORE);
    expect(STAGE_SHADER_SKSL).toContain(STAGE_SHADER_CORE);
    for (const [name] of STAGE_UNIFORM_LAYOUT) {
      expect(STAGE_SHADER_GLSL).toContain(` ${name};`);
      expect(STAGE_SHADER_SKSL).toContain(` ${name};`);
    }
    // All light meets the stage through one exposure curve, then a dither.
    expect(STAGE_SHADER_CORE.match(/1\.0 - exp\(-total/g)).toHaveLength(1);
    expect(STAGE_SHADER_CORE).toContain('toSrgb(linear) + n / 255.0');
  });

  test('the native shader compiles in Skia with exactly the declared uniforms', () => {
    expect(effect.getUniformCount()).toBe(STAGE_UNIFORM_LAYOUT.length);
    expect(effect.getUniformFloatCount()).toBe(STAGE_UNIFORM_LAYOUT.reduce((sum, [, size]) => sum + size, 0));
  });

  test('at its very brightest — a Bot speaking, a swell passing — the dimmest words keep AA, in every room', () => {
    const rooms: StageLights[] = [
      LOBBY,
      ...oneBotPerTone().map((botId) => stageLightsFor({ kind: 'bot', botId })),
      stageLightsFor({ kind: 'room', memberIds: oneBotPerTone().slice(0, 3) }),
    ];
    expect(rooms.length).toBe(BOT_CREST_TONES.length + 2);
    for (const lights of rooms) {
      for (const timeSec of [3.1, 41.5]) {
        const { luminance: lum } = render(lights, {
          gain: STAGE_GAIN.speaking,
          swellElapsedMs: STAGE_TIMING.swellMs * 0.35,
          timeSec,
        });
        const brightest = lum.reduce((max, value) => Math.max(max, value), 0);
        expect(contrastRatio(FLOOR, brightest)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('the lamp lights the top of the room and leaves the reading area in the dark', () => {
    const pixels = render(LOBBY);
    expect(band(pixels, 0, 0.25).light).toBeGreaterThan(band(pixels, 0.55, 0.85).light * 8);
  });

  test('a room is lit in its own colour', () => {
    const lobbyTop = band(render(LOBBY), 0, 0.2).rgb;
    expect(lobbyTop[2]).toBeGreaterThan(lobbyTop[0]); // violet: blue leads,
    expect(lobbyTop[0]).toBeGreaterThan(lobbyTop[1]); // red above green
    const lagoon = oneBotPerTone().find((id) => botCrestFromId(id).tone === BOT_CREST_TONES[2]) as string;
    const lagoonTop = band(render(stageLightsFor({ kind: 'bot', botId: lagoon })), 0, 0.2).rgb;
    expect(lagoonTop[1]).toBeGreaterThan(lagoonTop[0] * 1.8); // teal: green and blue far above red
    expect(lagoonTop[2]).toBeGreaterThan(lagoonTop[0] * 1.8);
  });

  test('an offline Gate dims the room', () => {
    const lit = band(render(LOBBY), 0, 0.5).light;
    const dim = band(render(LOBBY, { gain: STAGE_GAIN.offline }), 0, 0.5).light;
    expect(dim).toBeLessThan(lit * 0.5);
  });

  test('a sent message lights the lower room as it rises', () => {
    const quiet = band(render(LOBBY), 0.6, 0.95).light;
    const rising = band(render(LOBBY, { swellElapsedMs: STAGE_TIMING.swellMs * 0.2 }), 0.6, 0.95).light;
    expect(rising).toBeGreaterThan(quiet * 3);
  });
});
