/**
 * The stage shader, written once in the subset GLSL ES 1.00 and SkSL share,
 * then wrapped for WebGL (web) and Skia's runtime effects (native). Both
 * platforms run the same lighting, line for line.
 *
 * The picture, in the order it is built:
 *  1. The air — slow, domain-warped value noise that morphs in place. It is
 *     only ever seen *in* light: it thickens and thins the pools, never
 *     paints the dark.
 *  2. The lamps — the key above the upper left, and up to two guests in a
 *     group room: soft pools with an inverse-square-like falloff, their hue
 *     running from the crest's deep stop at the fringe to its lit stop at the
 *     core. Faint shafts turn through the key's light.
 *  3. The fill — a low pool of the key's deeper tone that the composer rests
 *     in, and the room's colour carried faintly across the whole stage.
 *  4. The swell — a sent message rising from the composer as a band of light.
 *  5. One exposure curve over all of it (1 − e^−x), so the brightest pixel
 *     can never pass the base plus one lamp colour: the AA ceiling in
 *     src/lib/stage/lamp.ts holds by construction.
 *  6. Linear light to sRGB, then a triangular dither of one 8-bit step, so a
 *     dark gradient never bands.
 */

import type { StageUniforms } from './choreography';

type UniformName = keyof StageUniforms;

/** Every uniform the shader declares, with its component count. */
export const STAGE_UNIFORM_LAYOUT: readonly (readonly [UniformName, 1 | 2 | 3 | 4])[] = [
  ['uResolution', 2],
  ['uTime', 1],
  ['uPixelRatio', 1],
  ['uParallax', 3],
  ['uBase', 3],
  ['uKeyCore', 3],
  ['uKeyEdge', 3],
  ['uKeySeat', 4],
  ['uGuestACore', 3],
  ['uGuestAEdge', 3],
  ['uGuestASeat', 4],
  ['uGuestBCore', 3],
  ['uGuestBEdge', 3],
  ['uGuestBSeat', 4],
  ['uFill', 2],
  ['uSwell', 3],
] as const;

const TYPE_FOR_SIZE = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' } as const;

const UNIFORMS = STAGE_UNIFORM_LAYOUT.map(([name, size]) => `uniform ${TYPE_FOR_SIZE[size]} ${name};`).join('\n');

/** Exposure: how quickly light gathers toward the ceiling. */
const EXPOSURE = '2.3';

export const STAGE_SHADER_CORE = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p = vec2(1.6 * p.x - 1.2 * p.y, 1.2 * p.x + 1.6 * p.y) + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return sum / 0.9375;
}

float lamp(vec2 p, vec4 seat) {
  vec2 d = (p - seat.xy) * vec2(1.0, 1.3);
  float q = 1.0 / (1.0 + dot(d, d) / (seat.z * seat.z));
  return seat.w * q * q * q;
}

float shafts(vec2 p, vec2 at, float t) {
  vec2 d = p - at;
  float a = atan(d.x, d.y);
  return vnoise(vec2(a * 4.0 + 3.1, t * 0.045)) * 0.65 + vnoise(vec2(a * 9.0 - 7.3, -t * 0.06)) * 0.35;
}

// Dust in the beam: two sparse layers of soft motes rising slowly on the warm
// air, each wandering a little. They have no light of their own — they are
// only seen where a lamp (or a rising swell) passes through them.
float motes(vec2 p, float t) {
  float sum = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float near = layer == 0 ? 1.0 : 0.0;
    float scale = mix(21.0, 12.0, near);
    vec2 q = p * scale + vec2(0.0, t * mix(0.11, 0.19, near));
    vec2 cell = floor(q);
    float seed = hash12(cell + vec2(float(layer) * 41.0, 7.0));
    float present = step(seed, mix(0.22, 0.16, near));
    vec2 at = vec2(hash12(cell + 11.3), hash12(cell + 27.1)) * 0.56 + 0.22;
    at += 0.1 * vec2(sin(t * 0.31 + seed * 40.0), cos(t * 0.23 + seed * 23.0));
    float r = mix(0.055, 0.088, near);
    vec2 d = (fract(q) - at) / r;
    float twinkle = 0.55 + 0.45 * sin(t * (0.6 + seed) + seed * 50.0);
    sum += present * exp(-dot(d, d)) * twinkle * mix(0.6, 1.0, near);
  }
  return sum;
}

vec3 shade(vec2 frag) {
  float W = uResolution.x;
  vec2 p = frag / W;
  float H = uResolution.y / W;
  float t = uTime;
  vec2 tilt = uParallax.yz;

  vec2 ap = (p + vec2(-tilt.x * 0.03, uParallax.x * 0.07 - tilt.y * 0.02)) * 2.3;
  vec2 warp = vec2(fbm(ap + vec2(0.0, t * 0.013)), fbm(ap + vec2(5.2, 1.3) - vec2(t * 0.011, 0.0)));
  float air = smoothstep(0.25, 0.8, fbm(ap * 1.3 + warp * 1.9 + vec2(-t * 0.004, t * 0.009)));
  // Finer wisps a layer nearer the eye: they drift a little faster and shift
  // further with scroll and tilt than the billows behind them.
  vec2 wp = (p + vec2(-tilt.x * 0.06, uParallax.x * 0.14 - tilt.y * 0.04)) * 5.6;
  float wisps = fbm(wp + warp * 0.8 + vec2(t * 0.012, -t * 0.021));

  vec2 shift = vec2(tilt.x * 0.06, tilt.y * 0.04);
  vec4 keySeat = vec4(uKeySeat.xy + shift, uKeySeat.zw);
  vec4 seatA = vec4(uGuestASeat.xy + shift, uGuestASeat.zw);
  vec4 seatB = vec4(uGuestBSeat.xy + shift, uGuestBSeat.zw);

  float airy = mix(0.72, 1.2, air) * mix(0.9, 1.1, wisps);
  float k = lamp(p, keySeat) * airy * mix(0.72, 1.22, shafts(p, keySeat.xy, t));
  float ga = lamp(p, seatA) * airy;
  float gb = lamp(p, seatB) * airy;

  vec2 bd = (p - vec2(0.5, H + 0.1)) * vec2(0.7, 3.2);
  float bounce = uFill.x / (1.0 + dot(bd, bd) / 0.06) * mix(0.8, 1.15, air);
  float ambient = uFill.y * mix(0.7, 1.3, air);

  float swell = 0.0;
  if (uSwell.y > 0.0) {
    float dy = (p.y - uSwell.x) / uSwell.z;
    float dx = (p.x - 0.5) / 0.8;
    swell = uSwell.y * exp(-dy * dy - dx * dx) * mix(0.7, 1.3, air);
  }

  float dust = motes(p, t) * (k + 0.6 * (ga + gb) + 2.2 * swell) * 2.1;

  float total = k + ga + gb + bounce + ambient + swell + dust;
  vec3 keyHue = mix(uKeyEdge, uKeyCore, smoothstep(0.08, 0.9, k));
  vec3 aHue = mix(uGuestAEdge, uGuestACore, smoothstep(0.08, 0.9, ga));
  vec3 bHue = mix(uGuestBEdge, uGuestBCore, smoothstep(0.08, 0.9, gb));
  vec3 swellHue = mix(uKeyEdge, uKeyCore, 0.4);
  vec3 hue = (keyHue * k + aHue * ga + bHue * gb + uKeyEdge * (bounce + ambient) + swellHue * swell + uKeyCore * dust) / max(total, 0.0001);
  vec3 lit = hue * (1.0 - exp(-total * ${EXPOSURE}));

  vec2 v = (p - vec2(0.5, H * 0.42)) / vec2(0.95, H * 0.85);
  float vignette = 1.0 - 0.3 * smoothstep(0.3, 1.1, dot(v, v));

  return (uBase + lit) * vignette;
}

vec3 toSrgb(vec3 c) {
  vec3 x = max(c, vec3(0.0));
  vec3 lo = x * 12.92;
  vec3 hi = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), x));
}

vec3 finish(vec3 linear, vec2 frag) {
  vec2 px = floor(frag * uPixelRatio);
  float n = hash12(px) + hash12(px + vec2(19.19, 7.31)) - 1.0;
  return toSrgb(linear) + n / 255.0;
}
`;

/** WebGL 1 fragment shader. GL's origin is bottom-left; the stage's is top-left. */
export const STAGE_SHADER_GLSL = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
${UNIFORMS}
${STAGE_SHADER_CORE}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  gl_FragColor = vec4(finish(shade(frag), frag), 1.0);
}
`;

/** Skia runtime effect (SkSL). Local coordinates are already top-left. */
export const STAGE_SHADER_SKSL = `${UNIFORMS}
${STAGE_SHADER_CORE}
vec4 main(vec2 frag) {
  return vec4(finish(shade(frag), frag), 1.0);
}
`;

/** WebGL 1 vertex shader: one triangle that covers the viewport. */
export const STAGE_VERTEX_GLSL = `attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
