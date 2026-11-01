/**
 * The web stage's GPU side: ONE WebGL context for the whole app, drawing into
 * an offscreen canvas that is copied onto whichever stage is on screen.
 * Every Screen mounts its own stage and the navigator keeps screens mounted,
 * so a context per stage would run into the browser's cap on live WebGL
 * contexts and start losing the oldest.
 *
 * The frame loop sleeps whenever it can: when the tab is hidden, when no
 * stage is on screen, and when the operator has not touched anything for a
 * while and nothing is changing (the air stills; input wakes it). The air
 * itself draws at 24 fps — it moves too slowly for more frames to show — and
 * only a room change, a swell or a level easing gets every frame.
 *
 * Imported only by AmbientCanvas.web.tsx; nothing here runs on native.
 */

import { STAGE_TIMING, type StageUniforms } from '@/lib/stage/choreography';
import type { StageLights } from '@/lib/stage/lamp';
import { StageMotion } from '@/lib/stage/motion';
import { STAGE_SHADER_GLSL, STAGE_UNIFORM_LAYOUT, STAGE_VERTEX_GLSL } from '@/lib/stage/shader';
import { getStageSignals, subscribeStageSignals } from '@/lib/stage/signals';

type Gpu = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  locations: Map<string, WebGLUniformLocation | null>;
};

/** The stage never renders more pixels than this; a soft light loses nothing to upscaling. */
const MAX_PIXELS = 1_300_000;

let glCanvas: HTMLCanvasElement | null = null;
let gpu: Gpu | null = null;
let unavailable = false;
/** The browser took the context away; it is a pause, not an unsupported browser. */
let contextLost = false;
/** A context that worked once is transiently lost when it vanishes, never unsupported. */
let hadContext = false;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    if (!gl.isContextLost()) console.warn('[stage] shader failed to compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function build(): Gpu | null {
  if (unavailable || contextLost || typeof document === 'undefined') return null;
  if (!glCanvas) {
    glCanvas = document.createElement('canvas');
    glCanvas.addEventListener('webglcontextlost', (event) => {
      // Keep the canvas and the StageHandle: a lost context pauses the air
      // until the browser hands it back, it does not make the GPU unsupported.
      event.preventDefault();
      contextLost = true;
      gpu = null;
      lastTick = 0;
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      gpu = null;
      lastTick = 0;
      // A still scene has no animation to make it draw again, so mark every
      // entry dirty: the restoration is the wake signal.
      for (const entry of entries) entry.dirty = true;
      wake();
    });
  }
  const gl = glCanvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  }) as WebGLRenderingContext | null;
  if (!gl) {
    // A browser that never gave us a context is unsupported; one that took a
    // working context away is only paused.
    if (hadContext) contextLost = true;
    else unavailable = true;
    return null;
  }
  hadContext = true;
  if (gl.isContextLost()) {
    contextLost = true;
    return null;
  }
  const vertex = compile(gl, gl.VERTEX_SHADER, STAGE_VERTEX_GLSL);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, STAGE_SHADER_GLSL);
  // Compilation reports failure when the context vanishes mid-build; that is
  // the same transient pause as a lost event, not a broken shader.
  if (gl.isContextLost()) {
    contextLost = true;
    return null;
  }
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) {
    if (gl.isContextLost()) {
      contextLost = true;
      return null;
    }
    unavailable = true;
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (gl.isContextLost()) {
      contextLost = true;
      return null;
    }
    console.warn('[stage] shader failed to link:', gl.getProgramInfoLog(program));
    unavailable = true;
    return null;
  }
  gl.useProgram(program);
  // One triangle larger than the viewport covers every pixel with no seam.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const locations = new Map<string, WebGLUniformLocation | null>();
  for (const [name] of STAGE_UNIFORM_LAYOUT) locations.set(name, gl.getUniformLocation(program, name));
  return { gl, program, locations };
}

/** Whether this browser can light the stage at all (compiles the shader on first ask). */
export function stageGpuAvailable(): boolean {
  if (!gpu) gpu = build();
  return gpu !== null || (!unavailable && glCanvas !== null);
}

type DrawOutcome = 'drawn' | 'paused' | 'unavailable';

function draw(uniforms: StageUniforms, width: number, height: number, target: CanvasRenderingContext2D): DrawOutcome {
  if (!gpu) gpu = build();
  if (!gpu || !glCanvas) {
    if (unavailable) return 'unavailable';
    // No GPU state right now: pause and leave the entry dirty for restoration.
    contextLost = true;
    lastTick = 0;
    return 'paused';
  }
  const { gl, locations } = gpu;
  if (gl.isContextLost()) {
    contextLost = true;
    gpu = null;
    lastTick = 0;
    return 'paused';
  }
  if (glCanvas.width !== width || glCanvas.height !== height) {
    glCanvas.width = width;
    glCanvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  for (const [name, size] of STAGE_UNIFORM_LAYOUT) {
    const location = locations.get(name);
    if (!location) continue;
    const value = uniforms[name];
    if (size === 1) gl.uniform1f(location, value as number);
    else if (size === 2) gl.uniform2fv(location, value as number[]);
    else if (size === 3) gl.uniform3fv(location, value as number[]);
    else gl.uniform4fv(location, value as number[]);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Same task as the draw, so the drawing buffer is still intact to copy.
  target.drawImage(glCanvas, 0, 0, width, height);
  return 'drawn';
}

// ── The frame loop ───────────────────────────────────────────────────────

type Entry = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  motion: StageMotion;
  visible: boolean;
  width: number;
  height: number;
  lastDraw: number;
  dirty: boolean;
  onUnavailable: () => void;
};

const entries = new Set<Entry>();
let frame = 0;
let lastTick = 0;
let lastInput = typeof performance !== 'undefined' ? performance.now() : 0;
let reducedMotion = false;
let firstLightDone = false;
let wired = false;

function wake(): void {
  if (contextLost) return;
  if (!frame && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  frame = 0;
  if (typeof document !== 'undefined' && document.hidden) {
    lastTick = 0;
    return;
  }
  // While the context is lost there is nothing to draw and nothing to poll:
  // webglcontextrestored wakes the loop.
  if (contextLost) {
    lastTick = 0;
    return;
  }
  const dt = lastTick ? Math.min(100, now - lastTick) : 1000 / 60;
  lastTick = now;
  const idle = now - lastInput > STAGE_TIMING.idleAfterMs;
  const signals = getStageSignals();
  let again = false;
  for (const entry of entries) {
    if (!entry.visible || entry.width === 0 || entry.height === 0) continue;
    const step = entry.motion.step(now, dt, signals, { width: entry.width, height: entry.height, pixelRatio: 1 }, idle);
    const due = entry.dirty || step.animating || (step.drifting && now - entry.lastDraw >= STAGE_TIMING.driftFrameMs - 1);
    if (due) {
      const outcome = draw(step.uniforms, entry.width, entry.height, entry.context);
      if (outcome === 'paused') {
        // Keep `dirty` set: the restored context must redraw this frame even if
        // the air had already gone still.
        continue;
      }
      if (outcome === 'unavailable') {
        entry.onUnavailable();
        continue;
      }
      entry.lastDraw = now;
      entry.dirty = false;
    }
    again = again || step.animating || step.drifting;
  }
  if (again && !contextLost) wake();
  else lastTick = 0;
}

function wireGlobals(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  reducedMotion = query?.matches ?? false;
  query?.addEventListener?.('change', (event) => {
    reducedMotion = event.matches;
    for (const entry of entries) {
      entry.motion.setReducedMotion(reducedMotion);
      entry.dirty = true;
    }
    wake();
  });
  const onInput = () => {
    lastInput = performance.now();
    wake();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(type, onInput, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastTick = 0;
      wake();
    }
  });
  subscribeStageSignals(() => {
    lastInput = performance.now();
    wake();
  });
}

export type StageHandle = {
  setRoom(lights: StageLights): void;
  setScroll(value: number): void;
  unmount(): void;
};

/**
 * Light a canvas. Returns null when this browser cannot run the shader — the
 * caller then paints its CSS lamp instead.
 */
export function mountStage(canvas: HTMLCanvasElement, lights: StageLights, onUnavailable: () => void): StageHandle | null {
  wireGlobals();
  if (!stageGpuAvailable()) return null;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  const now = performance.now();
  const entry: Entry = {
    canvas,
    context,
    motion: new StageMotion({ lights, now, firstLight: !firstLightDone, reducedMotion }),
    visible: true,
    width: 0,
    height: 0,
    lastDraw: 0,
    dirty: true,
    onUnavailable,
  };
  firstLightDone = true;
  entries.add(entry);

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, rect.width * rect.height)));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (width === entry.width && height === entry.height) return;
    entry.width = width;
    entry.height = height;
    canvas.width = width;
    canvas.height = height;
    entry.dirty = true;
    wake();
  };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  resize();

  // A screen the navigator keeps mounted but hides stops drawing; when it
  // comes back it picks up the signals as they are now, so a message sent
  // on another screen does not rise again here.
  const visibility =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((records) => {
          const visible = records[records.length - 1]?.isIntersecting ?? true;
          if (visible && !entry.visible) {
            entry.motion.resync(getStageSignals());
            entry.dirty = true;
            wake();
          }
          entry.visible = visible;
        })
      : null;
  visibility?.observe(canvas);
  wake();

  return {
    setRoom(next) {
      entry.motion.setRoom(next, performance.now());
      wake();
    },
    setScroll(value) {
      entry.motion.setScroll(value);
      wake();
    },
    unmount() {
      resizeObserver?.disconnect();
      visibility?.disconnect();
      entries.delete(entry);
    },
  };
}
