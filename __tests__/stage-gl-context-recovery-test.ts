/**
 * The web stage runs on one app-wide WebGL context. Browsers (mobile GPU
 * resets, tab pressure) can take that context away and hand it back a moment
 * later. That is a pause, not a browser without GPU support: the mounted
 * canvas and StageHandle must survive, no `onUnavailable` may fire, and the
 * restored context must rebuild the GPU state and redraw the current scene —
 * even when the air had already gone still.
 *
 * These exercise the real public `stageGpuAvailable`/`mountStage` against
 * controlled canvas/GL/RAF/document stubs. No browser is involved, so this
 * proves the renderer's recovery logic, not a real device's GPU recovery.
 */

import { stageLightsFor, type StageLights } from '@/lib/stage/lamp';

type StageGl = typeof import('@/components/layout/stage-gl');
type RafCallback = (time: number) => void;
type CanvasListener = (event: { preventDefault(): void }) => void;

const LIGHTS: StageLights = stageLightsFor(undefined);

class FakeRaf {
  private queue: { id: number; callback: RafCallback }[] = [];
  private nextId = 1;

  get pending(): number {
    return this.queue.length;
  }

  request = (callback: RafCallback): number => {
    const id = this.nextId++;
    this.queue.push({ id, callback });
    return id;
  };

  cancel = (id: number): void => {
    this.queue = this.queue.filter((item) => item.id !== id);
  };

  /** Run exactly the frames already queued, at one supplied clock reading. */
  flush(time: number): void {
    const batch = this.queue;
    this.queue = [];
    for (const item of batch) item.callback(time);
  }

  /** Run frames (advancing a fake clock) until the loop sleeps. Never real-waits. */
  settle(start: number, step: number, limit: number): number {
    let time = start;
    let frames = 0;
    while (this.queue.length > 0) {
      frames += 1;
      if (frames > limit) throw new Error(`frame loop did not settle within ${limit} frames`);
      this.flush(time);
      time += step;
    }
    return time;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly drawImage = jest.fn();
  private readonly listeners = new Map<string, Set<CanvasListener>>();

  constructor(private readonly glFactory: () => WebGLRenderingContext | null) {}

  getContext(kind: string): unknown {
    if (kind === 'webgl') return this.glFactory();
    if (kind === '2d') return { drawImage: this.drawImage };
    return null;
  }

  addEventListener(type: string, listener: CanvasListener): void {
    const listeners = this.listeners.get(type) ?? new Set<CanvasListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: CanvasListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: { preventDefault(): void }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  getBoundingClientRect(): DOMRect {
    return { width: 320, height: 200 } as unknown as DOMRect;
  }
}

class FakeWindow {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener = (type: string, listener: () => void): void => {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  };

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeDocument {
  hidden = false;
  readonly created: FakeCanvas[] = [];

  constructor(private readonly makeGl: () => WebGLRenderingContext | null) {}

  createElement = (): FakeCanvas => {
    const canvas = new FakeCanvas(this.makeGl);
    this.created.push(canvas);
    return canvas;
  };

  addEventListener = jest.fn();
  removeEventListener = jest.fn();
}

type GlState = {
  lost: boolean;
  failShader: boolean;
  drawCalls: number;
  compileCalls: number;
  linkCalls: number;
  loseOnNextLink: boolean;
};

function createGl(): { gl: WebGLRenderingContext; state: GlState } {
  const state: GlState = {
    lost: false,
    failShader: false,
    drawCalls: 0,
    compileCalls: 0,
    linkCalls: 0,
    loseOnNextLink: false,
  };

  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    isContextLost: () => state.lost,
    createShader: () => ({ kind: 'shader' }),
    shaderSource: jest.fn(),
    compileShader: () => {
      state.compileCalls += 1;
    },
    getShaderParameter: () => !state.lost && !state.failShader,
    getShaderInfoLog: () => '',
    deleteShader: jest.fn(),
    createProgram: () => ({ kind: 'program' }),
    attachShader: jest.fn(),
    linkProgram: () => {
      state.linkCalls += 1;
      if (state.loseOnNextLink) {
        state.loseOnNextLink = false;
        state.lost = true;
      }
    },
    getProgramParameter: () => !state.lost,
    getProgramInfoLog: () => '',
    useProgram: jest.fn(),
    createBuffer: () => ({ kind: 'buffer' }),
    bindBuffer: jest.fn(),
    bufferData: jest.fn(),
    getAttribLocation: () => 0,
    enableVertexAttribArray: jest.fn(),
    vertexAttribPointer: jest.fn(),
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    viewport: jest.fn(),
    uniform1f: jest.fn(),
    uniform2fv: jest.fn(),
    uniform3fv: jest.fn(),
    uniform4fv: jest.fn(),
    drawArrays: () => {
      state.drawCalls += 1;
    },
  };

  return { gl: gl as unknown as WebGLRenderingContext, state };
}

type Harness = {
  base: number;
  raf: FakeRaf;
  state: GlState;
  window: FakeWindow;
  document: FakeDocument;
  glCanvas(): FakeCanvas;
  canvas(): FakeCanvas;
  install(): void;
};

function createHarness(options: { webgl?: boolean } = {}): Harness {
  const { gl, state } = createGl();
  const makeGl = () => (options.webgl === false ? null : gl);
  const fakeDocument = new FakeDocument(makeGl);
  const fakeWindow = new FakeWindow();
  const raf = new FakeRaf();

  return {
    base: performance.now() + 1000,
    raf,
    state,
    window: fakeWindow,
    document: fakeDocument,
    glCanvas: () => fakeDocument.created[0],
    canvas: () => new FakeCanvas(makeGl),
    install() {
      (globalThis as any).window = fakeWindow;
      (globalThis as any).document = fakeDocument;
      (globalThis as any).requestAnimationFrame = raf.request;
      (globalThis as any).cancelAnimationFrame = raf.cancel;
    },
  };
}

const originalWindow = (globalThis as any).window;
const originalDocument = (globalThis as any).document;
const originalRequestAnimationFrame = (globalThis as any).requestAnimationFrame;
const originalCancelAnimationFrame = (globalThis as any).cancelAnimationFrame;

let stageGl: StageGl;

function load(options: { webgl?: boolean } = {}): Harness {
  const harness = createHarness(options);
  harness.install();
  stageGl = jest.requireActual<StageGl>('@/components/layout/stage-gl');
  return harness;
}

function mount(canvas: FakeCanvas, onUnavailable: () => void) {
  return stageGl.mountStage(canvas as unknown as HTMLCanvasElement, LIGHTS, onUnavailable);
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
  (globalThis as any).requestAnimationFrame = originalRequestAnimationFrame;
  (globalThis as any).cancelAnimationFrame = originalCancelAnimationFrame;
  jest.resetModules();
});

describe('a transient WebGL context loss', () => {
  test('pauses without falling back and redraws when the context is restored', () => {
    const h = load();
    expect(stageGl.stageGpuAvailable()).toBe(true);

    const canvas = h.canvas();
    const onUnavailable = jest.fn();
    const handle = mount(canvas, onUnavailable);
    expect(handle).not.toBeNull();

    const glCanvas = h.glCanvas();
    expect(glCanvas.listenerCount('webglcontextlost')).toBe(1);
    expect(glCanvas.listenerCount('webglcontextrestored')).toBe(1);

    h.raf.flush(h.base);
    expect(h.state.drawCalls).toBeGreaterThan(0);
    expect(canvas.drawImage).toHaveBeenCalled();
    const drawsBeforeLoss = h.state.drawCalls;
    const imagesBeforeLoss = canvas.drawImage.mock.calls.length;

    h.state.lost = true;
    const preventDefault = jest.fn();
    glCanvas.dispatch('webglcontextlost', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    // Losing the context is not the same as the browser lacking WebGL.
    expect(stageGl.stageGpuAvailable()).toBe(true);

    // The handle and canvas stay live while the context is away.
    expect(() => handle!.setRoom(LIGHTS)).not.toThrow();
    expect(() => handle!.setScroll(0.25)).not.toThrow();
    h.raf.settle(h.base + 1000, 1000, 5);
    expect(h.raf.pending).toBe(0);
    expect(h.state.drawCalls).toBe(drawsBeforeLoss);
    expect(canvas.drawImage).toHaveBeenCalledTimes(imagesBeforeLoss);
    expect(onUnavailable).not.toHaveBeenCalled();

    h.state.lost = false;
    const compilesBeforeRestore = h.state.compileCalls;
    glCanvas.dispatch('webglcontextrestored', { preventDefault: jest.fn() });

    // Restoration is the wake signal: one frame, not a poll.
    expect(h.raf.pending).toBe(1);
    h.raf.flush(h.base + 2000);
    expect(h.state.compileCalls).toBeGreaterThan(compilesBeforeRestore);
    expect(h.state.drawCalls).toBe(drawsBeforeLoss + 1);
    expect(canvas.drawImage).toHaveBeenCalledTimes(imagesBeforeLoss + 1);
    expect(onUnavailable).not.toHaveBeenCalled();

    handle!.unmount();
    h.raf.settle(h.base + 3000, 1000, 5);
  });

  test('redraws a scene that had already gone idle before the loss', () => {
    const h = load();
    expect(stageGl.stageGpuAvailable()).toBe(true);

    const canvas = h.canvas();
    const onUnavailable = jest.fn();
    const handle = mount(canvas, onUnavailable);
    expect(handle).not.toBeNull();

    // Settle past idleAfterMs: no drift, no easing, no queued frame.
    h.raf.settle(h.base, 5000, 30);
    expect(h.raf.pending).toBe(0);
    const drawsAtIdle = h.state.drawCalls;
    expect(drawsAtIdle).toBeGreaterThan(0);

    h.state.lost = true;
    h.glCanvas().dispatch('webglcontextlost', { preventDefault: jest.fn() });
    expect(h.raf.pending).toBe(0);

    // An input wake while lost must not schedule a frame or draw: restoration
    // is the only wake signal.
    h.window.dispatch('pointerdown');
    expect(h.raf.pending).toBe(0);
    h.raf.flush(h.base + 60_000);
    expect(h.raf.pending).toBe(0);
    expect(h.state.drawCalls).toBe(drawsAtIdle);
    expect(onUnavailable).not.toHaveBeenCalled();

    h.state.lost = false;
    h.glCanvas().dispatch('webglcontextrestored', { preventDefault: jest.fn() });
    expect(h.raf.pending).toBe(1);
    h.raf.flush(h.base + 61_000);

    // Still idle, so only the dirty flag left by restoration can draw it.
    expect(h.state.drawCalls).toBe(drawsAtIdle + 1);
    expect(canvas.drawImage).toHaveBeenCalledTimes(drawsAtIdle + 1);
    expect(onUnavailable).not.toHaveBeenCalled();

    handle!.unmount();
  });

  test('does not draw an entry unmounted before the context returns', () => {
    const h = load();
    expect(stageGl.stageGpuAvailable()).toBe(true);

    const active = h.canvas();
    const retired = h.canvas();
    const activeHandle = mount(active, jest.fn());
    const retiredHandle = mount(retired, jest.fn());
    expect(activeHandle).not.toBeNull();
    expect(retiredHandle).not.toBeNull();

    h.raf.flush(h.base);
    expect(active.drawImage).toHaveBeenCalled();
    expect(retired.drawImage).toHaveBeenCalled();
    const activeBeforeRestore = active.drawImage.mock.calls.length;
    const retiredBeforeRestore = retired.drawImage.mock.calls.length;

    h.state.lost = true;
    h.glCanvas().dispatch('webglcontextlost', { preventDefault: jest.fn() });
    h.raf.flush(h.base + 500);
    retiredHandle!.unmount();

    h.state.lost = false;
    h.glCanvas().dispatch('webglcontextrestored', { preventDefault: jest.fn() });
    expect(h.raf.pending).toBe(1);
    h.raf.flush(h.base + 1000);

    expect(active.drawImage).toHaveBeenCalledTimes(activeBeforeRestore + 1);
    expect(retired.drawImage).toHaveBeenCalledTimes(retiredBeforeRestore);

    activeHandle!.unmount();
  });

  test('treats a context lost during shader linking as transient, not unsupported', () => {
    const h = load();
    h.state.loseOnNextLink = true;

    // The build loses the context at link time: still available, just paused.
    expect(stageGl.stageGpuAvailable()).toBe(true);
    expect(h.state.lost).toBe(true);

    const canvas = h.canvas();
    const onUnavailable = jest.fn();
    const handle = mount(canvas, onUnavailable);
    expect(handle).not.toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();

    h.raf.flush(h.base);
    expect(h.state.drawCalls).toBe(0);

    h.state.lost = false;
    h.glCanvas().dispatch('webglcontextrestored', { preventDefault: jest.fn() });
    h.raf.flush(h.base + 1000);

    expect(h.state.drawCalls).toBeGreaterThan(0);
    expect(canvas.drawImage).toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();

    handle!.unmount();
  });

  test('a browser with no WebGL at all still returns null for the CSS fallback', () => {
    const h = load({ webgl: false });

    expect(stageGl.stageGpuAvailable()).toBe(false);

    const canvas = h.canvas();
    const onUnavailable = jest.fn();
    const handle = mount(canvas, onUnavailable);

    expect(handle).toBeNull();
    // The component chooses the CSS lamp itself when mountStage returns null.
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(stageGl.stageGpuAvailable()).toBe(false);
    expect(h.raf.pending).toBe(0);
    expect(canvas.drawImage).not.toHaveBeenCalled();
  });

  test('a real shader failure is still permanent unavailability, not a pause', () => {
    const h = load();
    h.state.failShader = true;

    expect(stageGl.stageGpuAvailable()).toBe(false);
    const canvas = h.canvas();
    const onUnavailable = jest.fn();
    const handle = mount(canvas, onUnavailable);

    expect(handle).toBeNull();
    expect(stageGl.stageGpuAvailable()).toBe(false);
    expect(h.raf.pending).toBe(0);
    expect(canvas.drawImage).not.toHaveBeenCalled();
  });
});
