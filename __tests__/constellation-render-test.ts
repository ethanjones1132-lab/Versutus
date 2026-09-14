declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const fleetComponents = (...parts: string[]) =>
  readSource('src', 'components', 'fleet', ...parts);
const nativeCanvas = () => fleetComponents('constellation-canvas.native.tsx');
const webCanvas = () => fleetComponents('constellation-canvas.web.tsx');
const defaultCanvas = () => fleetComponents('constellation-canvas.tsx');
const fallbackCanvas = () => fleetComponents('constellation-canvas-fallback.tsx');
const constellationView = () => fleetComponents('constellation-view.tsx');

// D2's render: one pure layout, painted in Skia on native and in plain views
// (SVG) on web and whenever the Skia mount fails. The view is only the
// interaction and label layer over that canvas — it never re-derives the
// graph the model already emitted.
describe('the constellation is painted from one layout', () => {
  test('both painters consume the shared pure layout helper', () => {
    for (const src of [nativeCanvas(), fallbackCanvas()]) {
      expect(src).toContain('constellationLayout(');
      expect(src).toContain("from '@/lib/fleet/constellation-model'");
      expect(src).not.toContain('constellationModel(');
    }
  });

  test('the view draws the model it is handed and never re-derives it', () => {
    const src = constellationView();
    expect(src).toContain('<ConstellationCanvas');
    expect(src).toContain('constellationEmptyCopy()');
    expect(src).not.toContain('constellationModel(');
    expect(src).not.toContain('fleetConstellationInput(');
  });

  test('the view derives its paint geometry from the shared layout, not ad-hoc math', () => {
    const src = constellationView();
    expect(src).toContain('constellationLayout(model, box)');
    expect(src).toContain('useWindowDimensions()');
    expect(src).not.toContain('DEFAULT_SIZE');
  });

  test('map and labels share one envelope, so no profile bleeds off the edge', () => {
    const src = constellationView();
    // The node press targets are positioned INSIDE the same box the canvas is
    // handed (box, not a second size), and the map clips to that envelope.
    expect(src).toContain('styles.mapWrap');
    expect(src).toContain("width: box, height: box");
    expect(src).toContain('<ConstellationCanvas model={model} size={box} />');
    expect(src).toContain('left: node.x - NODE_BOX_WIDTH / 2');
  });

  test('the HUD reads the model summary, not its own arithmetic', () => {
    const src = constellationView();
    expect(src).toContain('constellationSummaryCopy(model.summary)');
    expect(src).toContain('model.summary.approvals');
    expect(src).not.toContain("badges.filter((b");
  });
});

describe('native paints in Skia, every other path paints plain views', () => {
  test('the native canvas paints edges and nodes in one Skia Canvas', () => {
    const src = nativeCanvas();
    expect(src).toContain("from '@shopify/react-native-skia'");
    expect(src).toContain('<Canvas');
    expect(src).toContain('<Line');
    expect(src).toContain('<Circle');
    expect(src).toContain('constellationLayout(');
  });

  test('a Skia mount that throws falls back to the plain canvas', () => {
    const src = nativeCanvas();
    expect(src).toContain('getDerivedStateFromError');
    expect(src).toContain('<ConstellationCanvasFallback {...props} />');
  });

  test('the fallback draws the same layout in SVG', () => {
    const src = fallbackCanvas();
    expect(src).toContain("from 'react-native-svg'");
    expect(src).toContain('constellationLayout(');
  });

  test('web and the default resolution both re-export the plain canvas', () => {
    expect(webCanvas()).toBe(
      "export { ConstellationCanvasFallback as ConstellationCanvas } from './constellation-canvas-fallback';\n",
    );
    expect(defaultCanvas()).toContain('ConstellationCanvasFallback as ConstellationCanvas');
  });

  test('no Skia import reaches web, the default resolution, or the fallback', () => {
    for (const src of [webCanvas(), defaultCanvas(), fallbackCanvas()]) {
      expect(src).not.toContain('@shopify/react-native-skia');
    }
  });
});

describe('the view is tappable and honest', () => {
  test('every node is a press target announced by the shared honesty label', () => {
    const src = constellationView();
    expect(src).toContain('constellationNodeAccessibilityLabel(node)');
    expect(src).toContain('onPressNode');
    expect(src).toContain('onPressApproval');
    expect(src).toContain('<Badge');
  });

  test('a saved gateway is dated with the shared relative copy, never left undated', () => {
    const src = constellationView();
    expect(src).toContain('relativeLastSeenCopy(node.lastSeenAt, now)');
  });

  test('an empty fleet renders the dignified empty copy, not a blank square', () => {
    const src = constellationView();
    expect(src).toContain('if (model.empty)');
    expect(src).toContain('<EmptyState');
    expect(src).toContain('constellationEmptyCopy()');
  });

  test('the view adds no fetch and no provider of its own', () => {
    const src = constellationView();
    expect(src).not.toContain('gatewayRequest(');
    expect(src).not.toContain('useGateway(');
  });
});
