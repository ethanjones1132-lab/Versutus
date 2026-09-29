/**
 * A Bot's look: the form it is cut as, the face it wears, and the stone's
 * colour. Every Bot has a natural look derived from its id, so a team reads
 * as a cast of different characters before anyone picks anything; an
 * operator's choice (src/lib/avatar/look-store.ts) overrides any part of it.
 */

import {
  botCrestIn,
  fnv1a,
  type BotCrestTone,
  type BotLookChoice,
} from '@/lib/bot-avatar';
import { contrastRatio, hexToLinear, luminance } from '@/lib/stage/lamp';

import { AVATAR_FORMS, isAvatarForm, type AvatarForm } from './forms';

export const AVATAR_FACES = [
  'monogram',
  'calm',
  'bright',
  'visor',
  'iris',
  'joy',
  'serene',
  'pixel',
  'starry',
  'bare',
] as const;

export type AvatarFace = (typeof AVATAR_FACES)[number];

export const AVATAR_FACE_NAMES: Record<AvatarFace, string> = {
  monogram: 'Initial',
  calm: 'Calm',
  bright: 'Bright',
  visor: 'Visor',
  iris: 'Iris',
  joy: 'Joy',
  serene: 'Serene',
  pixel: 'Pixel',
  starry: 'Starry',
  bare: 'Bare',
};

export function isAvatarFace(value: unknown): value is AvatarFace {
  return typeof value === 'string' && (AVATAR_FACES as readonly string[]).includes(value);
}

export type BotLook = {
  form: AvatarForm;
  face: AvatarFace;
  tone: BotCrestTone;
  /** The initial the Initial face shows. */
  initial: string;
};

/**
 * The faces a Bot is given before anyone chooses: every face but Bare, which
 * is a choice to wear none.
 */
const NATURAL_FACES: readonly AvatarFace[] = AVATAR_FACES.filter((face) => face !== 'bare');

/** A Bot's own form and face, from its id — stable across launches and gateways. */
export function naturalShape(botId: string): { form: AvatarForm; face: AvatarFace } {
  return {
    form: AVATAR_FORMS[fnv1a(`form:${botId}`) % AVATAR_FORMS.length],
    face: NATURAL_FACES[fnv1a(`face:${botId}`) % NATURAL_FACES.length],
  };
}

/**
 * Distinct slots across a fleet, the way crest tones are assigned: ids are
 * walked sorted, each takes its natural slot when free, and only the ids that
 * collide step forward to the next free one. A Bot that owns its natural
 * slot never moves when the team changes around it.
 */
function assignDistinct(ids: readonly string[], natural: (id: string) => number, count: number): Map<string, number> {
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  const colliders: string[] = [];
  for (const id of ids) {
    const slot = natural(id);
    if (taken.has(slot)) colliders.push(id);
    else {
      taken.add(slot);
      assigned.set(id, slot);
    }
  }
  for (const id of colliders) {
    if (taken.size >= count) taken.clear();
    const start = natural(id);
    for (let step = 1; step <= count; step += 1) {
      const slot = (start + step) % count;
      if (!taken.has(slot)) {
        taken.add(slot);
        assigned.set(id, slot);
        break;
      }
    }
  }
  return assigned;
}

type Cast = Map<string, { form: AvatarForm; face: AvatarFace }>;
const castByFleet = new WeakMap<ReadonlyMap<string, number>, Cast>();

/**
 * The team as a cast: every Bot on the fleet gets a form and a face no one
 * else on it wears, while forms and faces remain — six Bots never show up as
 * three of the same character.
 */
export function fleetCast(fleet: ReadonlyMap<string, number>): Cast {
  const cached = castByFleet.get(fleet);
  if (cached) return cached;
  const ids = [...fleet.keys()].sort();
  const forms = assignDistinct(ids, (id) => AVATAR_FORMS.indexOf(naturalShape(id).form), AVATAR_FORMS.length);
  const faces = assignDistinct(ids, (id) => NATURAL_FACES.indexOf(naturalShape(id).face), NATURAL_FACES.length);
  const cast: Cast = new Map();
  for (const id of ids) {
    cast.set(id, { form: AVATAR_FORMS[forms.get(id) ?? 0], face: NATURAL_FACES[faces.get(id) ?? 0] });
  }
  castByFleet.set(fleet, cast);
  return cast;
}

/**
 * A Bot's look under a given fleet assignment and set of choices — pure, so a
 * component that passes both in visibly depends on them (the React Compiler
 * memoizes on what a computation reads).
 */
export function botLookIn(
  fleet: ReadonlyMap<string, number>,
  looks: ReadonlyMap<string, BotLookChoice>,
  botId: string,
  displayName?: string,
): BotLook {
  const crest = botCrestIn(fleet, botId, displayName, looks);
  const natural = fleetCast(fleet).get(botId) ?? naturalShape(botId);
  const choice = looks.get(botId);
  return {
    form: isAvatarForm(choice?.form) ? choice.form : natural.form,
    face: isAvatarFace(choice?.face) ? choice.face : natural.face,
    tone: crest.tone,
    initial: crest.initial,
  };
}

/** Where a face is read against: the stone's colour at its middle. */
function faceGround(tone: BotCrestTone): number {
  const from = hexToLinear(tone.from);
  const to = hexToLinear(tone.to);
  // The body runs corner to corner; the face sits a little past the middle.
  const t = 0.56;
  return luminance([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]);
}

/** WCAG's floor for a meaningful mark against what it sits on. */
export const FACE_INK_MIN_CONTRAST = 3;

/** The face's ink: white on every stone that holds it at 3:1, the stage's near-black on pale ones. */
export function faceInkIsDark(tone: BotCrestTone): boolean {
  return contrastRatio(1, faceGround(tone)) < FACE_INK_MIN_CONTRAST && faceInkContrast(tone, true) > contrastRatio(1, faceGround(tone));
}

/** The contrast a face's ink keeps against its stone. */
export function faceInkContrast(tone: BotCrestTone, dark = faceInkIsDark(tone)): number {
  const ground = faceGround(tone);
  return dark ? contrastRatio(luminance(hexToLinear(FACE_INK_DARK)), ground) : contrastRatio(1, ground);
}

export const FACE_INK_LIGHT = '#FFFFFF';
export const FACE_INK_DARK = '#121118';

/** Whether two looks would draw the same figure. */
export function sameLook(a: Omit<BotLook, 'initial'>, b: Omit<BotLook, 'initial'>): boolean {
  return (
    a.form === b.form &&
    a.face === b.face &&
    a.tone.from.toUpperCase() === b.tone.from.toUpperCase() &&
    a.tone.to.toUpperCase() === b.tone.to.toUpperCase()
  );
}
