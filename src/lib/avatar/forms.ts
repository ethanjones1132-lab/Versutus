/**
 * The Versutus figure's forms, as geometry: every silhouette a Bot can be cut
 * as, in one 100-unit box, with where its face sits and where the lamp's
 * sheen pools on it. Pure data and pure maths — drawn by
 * src/components/avatar/bot-figure.tsx, tested without a renderer.
 *
 * The forms are cut stones, not stickers: each keeps a generous flat middle
 * for a face, stays inside the box, and reads as its own silhouette at 22pt.
 */

export const AVATAR_FORMS = [
  'orb',
  'pebble',
  'gem',
  'drop',
  'petal',
  'spark',
  'shield',
  'bloom',
  'diamond',
  'arch',
] as const;

export type AvatarForm = (typeof AVATAR_FORMS)[number];

/** What each form is called where an operator picks it. */
export const AVATAR_FORM_NAMES: Record<AvatarForm, string> = {
  orb: 'Orb',
  pebble: 'Pebble',
  gem: 'Gem',
  drop: 'Drop',
  petal: 'Petal',
  spark: 'Spark',
  shield: 'Shield',
  bloom: 'Bloom',
  diamond: 'Diamond',
  arch: 'Arch',
};

export type FormGeometry = {
  /** The silhouette, a closed path in the 100-unit box. */
  body: string;
  /** Cut lines where the stone has facets; drawn as light hairlines. */
  facets?: string;
  /** A flat table facet, drawn a shade lighter than the body. */
  table?: string;
  /** Where the face sits: the eye line's centre and the face's width, in units. */
  face: { x: number; y: number; w: number };
  /** Where the lamp's sheen pools, as a fraction of the box. */
  sheen: { x: number; y: number };
};

type Pt = readonly [number, number];

function n(value: number): string {
  // Two decimals keep paths short and stable across engines.
  return String(Math.round(value * 100) / 100);
}

/**
 * A smooth closed curve through the points (uniform Catmull-Rom, drawn as
 * cubic Béziers), so sampled outlines have no corners.
 */
export function smoothClosedPath(points: readonly Pt[]): string {
  const count = points.length;
  const at = (i: number) => points[(i + count) % count];
  let d = `M${n(at(0)[0])} ${n(at(0)[1])}`;
  for (let i = 0; i < count; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p2[0])} ${n(p2[1])}`;
  }
  return `${d}Z`;
}

/** A polygon with each corner eased into a curve of the given reach. */
export function roundedPolygonPath(points: readonly Pt[], radius: number): string {
  const count = points.length;
  let d = '';
  for (let i = 0; i < count; i += 1) {
    const prev = points[(i - 1 + count) % count];
    const cur = points[i];
    const next = points[(i + 1) % count];
    const toPrev = Math.hypot(prev[0] - cur[0], prev[1] - cur[1]);
    const toNext = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r = Math.min(radius, toPrev / 2, toNext / 2);
    const a: Pt = [cur[0] + ((prev[0] - cur[0]) / toPrev) * r, cur[1] + ((prev[1] - cur[1]) / toPrev) * r];
    const b: Pt = [cur[0] + ((next[0] - cur[0]) / toNext) * r, cur[1] + ((next[1] - cur[1]) / toNext) * r];
    d += `${i === 0 ? 'M' : 'L'}${n(a[0])} ${n(a[1])}Q${n(cur[0])} ${n(cur[1])} ${n(b[0])} ${n(b[1])}`;
  }
  return `${d}Z`;
}

/** Sample a closed polar outline around the box's centre. */
function polar(radius: (theta: number) => number, samples = 96): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i < samples; i += 1) {
    const theta = (i / samples) * Math.PI * 2 - Math.PI / 2;
    const r = radius(theta);
    points.push([50 + r * Math.cos(theta), 50 + r * Math.sin(theta)]);
  }
  return points;
}

/** A superellipse |x|^e + |y|^e = 1 at the given half-extent. */
function superellipse(exponent: number, half: number, samples = 96): Pt[] {
  return polar((theta) => {
    const c = Math.abs(Math.cos(theta));
    const s = Math.abs(Math.sin(theta));
    return half / Math.pow(Math.pow(c, exponent) + Math.pow(s, exponent), 1 / exponent);
  }, samples);
}

function regular(sides: number, radius: number, rotation: number, cx = 50, cy = 50): Pt[] {
  return Array.from({ length: sides }, (_, i) => {
    const theta = rotation + (i / sides) * Math.PI * 2;
    return [cx + radius * Math.cos(theta), cy + radius * Math.sin(theta)] as Pt;
  });
}

function linesBetween(outer: readonly Pt[], inner: readonly Pt[]): string {
  return outer.map((p, i) => `M${n(p[0])} ${n(p[1])}L${n(inner[i][0])} ${n(inner[i][1])}`).join('');
}

function polygonPath(points: readonly Pt[]): string {
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p[0])} ${n(p[1])}`).join('')}Z`;
}

function buildForms(): Record<AvatarForm, FormGeometry> {
  // The gem: a flat-sided hexagon with a hexagonal table and a crown of cuts.
  const gemOuter = regular(6, 50, -Math.PI / 2);
  const gemTable = regular(6, 29, -Math.PI / 2, 50, 48);
  // The diamond: a rhombus cut with a kite-shaped table.
  const diamondOuter: Pt[] = [
    [50, 1],
    [99, 50],
    [50, 99],
    [1, 50],
  ];
  const diamondTable: Pt[] = [
    [50, 24],
    [74, 48],
    [50, 76],
    [26, 48],
  ];

  // The drop: a disc with a point drawn up out of it, the tip softened.
  const dropCentre: Pt = [50, 60];
  const dropR = 39;
  const dropReach = Math.acos(dropR / (dropCentre[1] - 1));
  const tipLeft: Pt = [dropCentre[0] - dropR * Math.sin(dropReach), dropCentre[1] - dropR * Math.cos(dropReach)];
  const tipRight: Pt = [dropCentre[0] + dropR * Math.sin(dropReach), dropCentre[1] - dropR * Math.cos(dropReach)];
  // The point is eased over its last tenth, so the tip is a soft point.
  const toTip = (from: Pt): Pt => [from[0] + (50 - from[0]) * 0.88, from[1] + (1 - from[1]) * 0.88];
  const nearTipLeft = toTip(tipLeft);
  const nearTipRight = toTip(tipRight);

  return {
    orb: {
      body: 'M0 50A50 50 0 1 0 100 50A50 50 0 1 0 0 50Z',
      face: { x: 50, y: 50, w: 64 },
      sheen: { x: 0.32, y: 0.2 },
    },
    pebble: {
      body: smoothClosedPath(superellipse(4.2, 49.5)),
      face: { x: 50, y: 50, w: 68 },
      sheen: { x: 0.28, y: 0.16 },
    },
    gem: {
      body: roundedPolygonPath(gemOuter, 7),
      table: polygonPath(gemTable),
      facets: linesBetween(gemOuter, gemTable),
      face: { x: 50, y: 50, w: 50 },
      sheen: { x: 0.34, y: 0.22 },
    },
    drop: {
      body: `M${n(tipLeft[0])} ${n(tipLeft[1])}L${n(nearTipLeft[0])} ${n(nearTipLeft[1])}Q50 1 ${n(nearTipRight[0])} ${n(
        nearTipRight[1],
      )}L${n(tipRight[0])} ${n(tipRight[1])}A${dropR} ${dropR} 0 1 1 ${n(tipLeft[0])} ${n(tipLeft[1])}Z`,
      face: { x: 50, y: 63, w: 56 },
      sheen: { x: 0.36, y: 0.4 },
    },
    petal: {
      // Four lobes on the diagonals: a rounded square pinched at its sides.
      body: smoothClosedPath(polar((t) => 43 + 7 * Math.cos(4 * (t - Math.PI / 4)), 128)),
      face: { x: 50, y: 50, w: 60 },
      sheen: { x: 0.26, y: 0.2 },
    },
    spark: {
      // A four-point star with full shoulders: concave sides, softened tips.
      body: smoothClosedPath(superellipse(0.86, 50, 128).map(([x, y]) => [50 + (x - 50) * 0.99, 50 + (y - 50) * 0.99] as Pt)),
      face: { x: 50, y: 50, w: 44 },
      sheen: { x: 0.4, y: 0.3 },
    },
    shield: {
      body: 'M7 15Q7 5 17 5L83 5Q93 5 93 15L93 47C93 72 72 89 50 98C28 89 7 72 7 47Z',
      face: { x: 50, y: 44, w: 62 },
      sheen: { x: 0.3, y: 0.14 },
    },
    bloom: {
      // Eight scallops round a full disc: a seal, a cut flower.
      body: smoothClosedPath(polar((t) => 46 + 4 * Math.cos(8 * t), 128)),
      face: { x: 50, y: 50, w: 60 },
      sheen: { x: 0.3, y: 0.2 },
    },
    diamond: {
      body: roundedPolygonPath(diamondOuter, 11),
      table: polygonPath(diamondTable),
      facets: linesBetween(diamondOuter, diamondTable),
      face: { x: 50, y: 50, w: 44 },
      sheen: { x: 0.4, y: 0.26 },
    },
    arch: {
      body: 'M6 50A44 44 0 0 1 94 50L94 88Q94 98 84 98L16 98Q6 98 6 88Z',
      face: { x: 50, y: 54, w: 62 },
      sheen: { x: 0.3, y: 0.16 },
    },
  };
}

export const FORM_GEOMETRY: Record<AvatarForm, FormGeometry> = buildForms();

export function isAvatarForm(value: unknown): value is AvatarForm {
  return typeof value === 'string' && (AVATAR_FORMS as readonly string[]).includes(value);
}
