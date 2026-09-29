import { BOT_CREST_TONES, botCrestFromId, crestLooksSnapshot, registerCrestFleet, registerCrestLooks } from '@/lib/bot-avatar';
import { AVATAR_FORMS, FORM_GEOMETRY } from '@/lib/avatar/forms';
import {
  AVATAR_FACES,
  FACE_INK_MIN_CONTRAST,
  botLookIn,
  faceInkContrast,
  faceInkIsDark,
  fleetCast,
  naturalShape,
} from '@/lib/avatar/look';
import {
  BOT_LOOKS_KEY,
  ensureBotLooksLoaded,
  parseBotLooks,
  resetBotLooksForTests,
  saveBotLook,
} from '@/lib/avatar/look-store';
import {
  WHEEL_RINGS,
  WHEEL_SEAM,
  WHEEL_SEAMS,
  hueDistance,
  hueOf,
  huesOfTone,
  isSeamHue,
  openHue,
  toneFromHues,
  toneName,
  wheelColour,
} from '@/lib/avatar/wheel';
import { keyValueStorage } from '@/lib/storage/key-value';
import { hexToLinear, linearToOklch, stageLightsFor, lampLight, LAMP_CORE_CHROMA, LAMP_CORE_FLOOR } from '@/lib/stage/lamp';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    getAllKeys: jest.fn(),
    multiRemove: jest.fn(),
  },
}));

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

const TEAM = ['aria', 'forge', 'ledger', 'sentinel', 'muse', 'scout'];
const NONE = new Map();

afterEach(() => {
  registerCrestFleet([]);
  resetBotLooksForTests();
  mockGet.mockReset();
  mockSet.mockReset();
});

/** Every number in a path, so its reach can be checked against the box. */
function coordinates(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe('the forms', () => {
  test.each(AVATAR_FORMS)('%s is a closed silhouette inside the 100-unit box', (form) => {
    const geometry = FORM_GEOMETRY[form];
    expect(geometry.body).toMatch(/^M/);
    expect(geometry.body).toMatch(/Z$/);
    // Only the path commands every renderer draws the same way.
    expect(geometry.body).not.toMatch(/[^MLQCAZ0-9 .\-]/);
    const numbers = coordinates(geometry.body.replace(/A[^A-Z]*?(?=[LZMQC]|$)/g, (arc) => arc.replace(/A\S+ \S+ \S+ \S+ \S+ /, 'A')));
    for (const value of numbers) {
      expect(value).toBeGreaterThanOrEqual(-0.5);
      expect(value).toBeLessThanOrEqual(100.5);
    }
  });

  test.each(AVATAR_FORMS)('%s keeps its face inside the stone', (form) => {
    const { face } = FORM_GEOMETRY[form];
    expect(face.w).toBeGreaterThanOrEqual(40);
    expect(face.x - face.w / 2).toBeGreaterThan(8);
    expect(face.x + face.w / 2).toBeLessThan(92);
    expect(face.y).toBeGreaterThan(30);
    expect(face.y).toBeLessThan(70);
  });

  test('every form is its own silhouette', () => {
    expect(new Set(AVATAR_FORMS.map((form) => FORM_GEOMETRY[form].body)).size).toBe(AVATAR_FORMS.length);
  });

  test('the cut stones carry a table and facet lines; the smooth ones do not', () => {
    expect(FORM_GEOMETRY.gem.table && FORM_GEOMETRY.gem.facets).toBeTruthy();
    expect(FORM_GEOMETRY.diamond.table && FORM_GEOMETRY.diamond.facets).toBeTruthy();
    expect(FORM_GEOMETRY.orb.facets).toBeUndefined();
  });
});

describe('the colour wheel', () => {
  test('the three seams sit on the status hues and the wheel never rests in one', () => {
    for (const seam of WHEEL_SEAMS) {
      expect(isSeamHue(seam.hue)).toBe(true);
      expect(isSeamHue(openHue(seam.hue))).toBe(false);
    }
    for (let hue = 0; hue < 360; hue += 1) {
      const open = openHue(hue);
      expect(isSeamHue(open)).toBe(false);
      // An open hue is kept exactly; a sealed one moves only to its seam's edge.
      if (!isSeamHue(hue)) expect(open).toBe(hue);
      else expect(hueDistance(open, hue)).toBeLessThanOrEqual(WHEEL_SEAM);
    }
  });

  test('each ring is one lightness all the way round, and true to its hue', () => {
    for (const ring of ['lit', 'shade'] as const) {
      for (let hue = 0; hue < 360; hue += 5) {
        if (isSeamHue(hue)) continue;
        const colour = linearToOklch(hexToLinear(wheelColour(ring, hue)));
        expect(Math.abs(colour.l - WHEEL_RINGS[ring].l)).toBeLessThan(0.02);
        expect(colour.c).toBeLessThanOrEqual(WHEEL_RINGS[ring].c + 0.005);
        // Chroma is what the gamut takes; the hue itself never drifts.
        expect(hueDistance(colour.h, hue)).toBeLessThan(3);
      }
    }
  });

  test('no colour the wheel makes wears a status hue', () => {
    for (let lit = 0; lit < 360; lit += 2) {
      const tone = toneFromHues(lit, lit);
      for (const stop of [tone.from, tone.to]) {
        for (const seam of WHEEL_SEAMS) expect(hueDistance(hueOf(stop), seam.hue)).toBeGreaterThan(WHEEL_SEAM - 3);
      }
    }
  });

  test('a tone from the wheel reads back to the thumbs that made it', () => {
    for (const [lit, shade] of [
      [288, 288],
      [346, 300],
      [205, 266],
      [60, 60],
    ]) {
      const back = huesOfTone(toneFromHues(lit, shade));
      expect(hueDistance(back.lit, lit)).toBeLessThan(2.5);
      expect(hueDistance(back.shade, shade)).toBeLessThan(2.5);
    }
  });

  test('a colour is named, and a twilight pair names both hues', () => {
    expect(toneName(288, 288)).toBe('Violet');
    expect(toneName(346, 308)).toBe('Rose into Orchid');
  });
});

describe('a face reads on its stone', () => {
  test.each(BOT_CREST_TONES.map((tone, i) => [i, tone] as const))('house jewel %i', (_, tone) => {
    expect(faceInkContrast(tone)).toBeGreaterThanOrEqual(FACE_INK_MIN_CONTRAST);
  });

  test('every linked colour on the wheel keeps its face legible', () => {
    for (let hue = 0; hue < 360; hue += 4) {
      const tone = toneFromHues(hue, hue);
      expect({ hue, contrast: faceInkContrast(tone) >= FACE_INK_MIN_CONTRAST }).toEqual({ hue, contrast: true });
    }
  });

  test('platinum, too pale for white, wears the stage\'s near-black', () => {
    expect(faceInkIsDark({ from: '#E8E9EE', to: '#646878' })).toBe(true);
    expect(faceInkIsDark(BOT_CREST_TONES[0])).toBe(false);
  });
});

describe('the cast', () => {
  test('a Bot\'s natural form and face come from its id, the same every time', () => {
    expect(naturalShape('forge')).toEqual(naturalShape('forge'));
    expect(AVATAR_FORMS).toContain(naturalShape('forge').form);
    expect(AVATAR_FACES).toContain(naturalShape('forge').face);
    // Bare is a choice to wear no face, never given.
    for (let i = 0; i < 200; i += 1) expect(naturalShape(`bot-${i}`).face).not.toBe('bare');
  });

  test('a team of six is six different characters', () => {
    registerCrestFleet(TEAM);
    const fleet = new Map(TEAM.map((id, i) => [id, i]));
    const cast = fleetCast(fleet);
    expect(new Set(TEAM.map((id) => cast.get(id)?.form)).size).toBe(TEAM.length);
    expect(new Set(TEAM.map((id) => cast.get(id)?.face)).size).toBe(TEAM.length);
    // Order of arrival does not reshuffle anyone.
    const reversed = fleetCast(new Map([...TEAM].reverse().map((id, i) => [id, i])));
    for (const id of TEAM) expect(reversed.get(id)).toEqual(cast.get(id));
  });

  test('a choice overrides only the part it names; an unknown value is ignored', () => {
    const fleet = new Map(TEAM.map((id, i) => [id, i]));
    const natural = botLookIn(fleet, NONE, 'forge', 'Forge');
    const chosen = botLookIn(fleet, new Map([['forge', { form: 'spark', face: 'nonsense' }]]), 'forge', 'Forge');
    expect(chosen.form).toBe('spark');
    expect(chosen.face).toBe(natural.face);
    expect(chosen.tone).toEqual(natural.tone);
    expect(chosen.initial).toBe('F');
  });
});

describe('a chosen colour is the Bot\'s colour everywhere', () => {
  const tone = toneFromHues(205, 266);

  test('the crest, and the room\'s lamp, take the chosen tone', () => {
    registerCrestLooks(new Map([['aria', { tone }]]));
    expect(botCrestFromId('aria').tone).toEqual(tone);
    const lights = stageLightsFor({ kind: 'bot', botId: 'aria' });
    expect(lights.key.core).toEqual(lampLight(tone.from, LAMP_CORE_CHROMA, LAMP_CORE_FLOOR));
  });

  test('a stored look is read once, validated, and merged under newer choices', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({
        aria: { form: 'bloom', face: 'visor', tone },
        forge: { form: 'hexagon', tone: { from: 'red', to: '#000000' } },
        muse: 'nonsense',
      }),
    );
    await ensureBotLooksLoaded();
    await ensureBotLooksLoaded();
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(BOT_LOOKS_KEY);
    const looks = crestLooksSnapshot();
    expect(looks.get('aria')).toEqual({ form: 'bloom', face: 'visor', tone });
    // Nothing forge stored is drawable, so forge keeps its natural look.
    expect(looks.has('forge')).toBe(false);
    expect(looks.has('muse')).toBe(false);
  });

  test('keeping a look writes it; forgetting it returns the Bot to its natural look', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue(undefined);
    await saveBotLook('ledger', { face: 'starry' });
    expect(crestLooksSnapshot().get('ledger')).toEqual({ face: 'starry' });
    expect(JSON.parse(mockSet.mock.calls[0][1])).toEqual({ ledger: { face: 'starry' } });
    await saveBotLook('ledger', null);
    expect(crestLooksSnapshot().has('ledger')).toBe(false);
    expect(JSON.parse(mockSet.mock.calls[1][1])).toEqual({});
  });

  test('a corrupt store costs the choices, never the app', () => {
    expect(parseBotLooks('{not json').size).toBe(0);
    expect(parseBotLooks('[1,2]').size).toBe(0);
    expect(parseBotLooks(null).size).toBe(0);
  });
});
