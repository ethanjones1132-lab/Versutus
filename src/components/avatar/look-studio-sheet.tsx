import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { BotFigure } from '@/components/avatar/bot-figure';
import { ColourWheel, wheelRings } from '@/components/avatar/colour-wheel';
import { BaseSheet, Button, Icon, PressableScale, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useBotLook } from '@/hooks/use-bot-look';
import { useTokens } from '@/hooks/use-tokens';
import { AVATAR_FORMS, AVATAR_FORM_NAMES, type AvatarForm } from '@/lib/avatar/forms';
import { AVATAR_FACES, AVATAR_FACE_NAMES, botLookIn, sameLook, type AvatarFace, type BotLook } from '@/lib/avatar/look';
import { saveBotLook } from '@/lib/avatar/look-store';
import { huesOfTone, toneFromHues, toneName } from '@/lib/avatar/wheel';
import {
  BOT_CREST_TONES,
  crestFleetSnapshot,
  subscribeCrestFleet,
  type BotCrestTone,
  type BotLookChoice,
} from '@/lib/bot-avatar';
import { haptics } from '@/lib/haptics';

/** The house jewels, named in the order src/lib/bot-avatar.ts declares them. */
export const HOUSE_JEWEL_NAMES = [
  'Violet',
  'Cobalt',
  'Lagoon',
  'Ocean',
  'Mulberry',
  'Orchid',
  'Raspberry',
  'Platinum',
  'Dusk',
  'Tide',
] as const;

const NO_CHOICES: ReadonlyMap<string, BotLookChoice> = new Map();

type Draft = {
  form: AvatarForm;
  face: AvatarFace;
  tone: BotCrestTone;
  lit: number;
  shade: number;
  linked: boolean;
};

function sameTone(a: BotCrestTone, b: BotCrestTone): boolean {
  return a.from.toUpperCase() === b.from.toUpperCase() && a.to.toUpperCase() === b.to.toUpperCase();
}

/** What to keep: only the parts that differ from the Bot's natural look, so the rest still follows the team. */
export function lookChoiceFor(draft: Omit<BotLook, 'initial'>, natural: Omit<BotLook, 'initial'>): BotLookChoice | null {
  const choice: BotLookChoice = {};
  if (draft.form !== natural.form) choice.form = draft.form;
  if (draft.face !== natural.face) choice.face = draft.face;
  if (!sameTone(draft.tone, natural.tone)) choice.tone = draft.tone;
  return Object.keys(choice).length > 0 ? choice : null;
}

/** A rail tile's width plus the gap after it: where the nth tile starts. */
const TILE_STEP = 78;

/** A form's arrival in the studio: it grows into place from the stone before. */
const formArrives = new Keyframe({
  0: { opacity: 0.2, transform: [{ scale: 0.86 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.cubic) },
}).duration(260);

/**
 * The Look studio: where an operator chooses how one of their Bots appears.
 * The Bot stands in the middle of the colour wheel, alive, and wears every
 * change the moment it is made; touch it and it lights up. Below the wheel,
 * the house jewels, then the forms and faces — each shown on the Bot itself,
 * never as an abstract swatch.
 */
export function LookStudioSheet({ botId, name, onClose }: { botId: string | null; name?: string; onClose: () => void }) {
  if (!botId) return null;
  return (
    <BaseSheet visible eyebrow="Look" title={name ?? botId} onClose={onClose} closeLabel="Cancel">
      <Studio key={botId} botId={botId} name={name} onClose={onClose} />
    </BaseSheet>
  );
}

function Studio({ botId, name, onClose }: { botId: string; name?: string; onClose: () => void }) {
  const tokens = useTokens();
  const { width } = useWindowDimensions();
  const current = useBotLook(botId, name);
  const fleet = useSyncExternalStore(subscribeCrestFleet, crestFleetSnapshot, crestFleetSnapshot);
  const natural = botLookIn(fleet, NO_CHOICES, botId, name);
  const [draft, setDraft] = useState<Draft>(() => ({
    form: current.form,
    face: current.face,
    tone: current.tone,
    ...huesOfTone(current.tone),
    linked: true,
  }));
  const [reaction, setReaction] = useState(0);
  const [dragging, setDragging] = useState(false);
  const formRail = useRef<ScrollView>(null);
  const faceRail = useRef<ScrollView>(null);
  const railsPlaced = useRef(false);

  // The chosen form and face stay in view on their rails — on opening, and
  // whenever a choice is made (or restored) off the visible end.
  useEffect(() => {
    const animated = railsPlaced.current;
    railsPlaced.current = true;
    const place = (rail: ScrollView | null, index: number) =>
      rail?.scrollTo({ x: Math.max(0, index * TILE_STEP - TILE_STEP * 1.5), animated });
    place(formRail.current, AVATAR_FORMS.indexOf(draft.form));
    place(faceRail.current, AVATAR_FACES.indexOf(draft.face));
  }, [draft.form, draft.face]);

  const look: BotLook = { form: draft.form, face: draft.face, tone: draft.tone, initial: current.initial };
  const wheel = Math.min(width - Spacing.four * 2 - 8, 330);
  const hero = Math.round(wheelRings(wheel).hole * 2 * 0.8);
  const jewel = BOT_CREST_TONES.findIndex((tone) => sameTone(tone, draft.tone));
  const colourName = jewel >= 0 ? HOUSE_JEWEL_NAMES[jewel] : toneName(draft.lit, draft.shade);
  const unchanged = sameLook(look, current);
  const isNatural = sameLook(look, natural);

  const pickForm = (form: AvatarForm) => {
    if (form === draft.form) return;
    void haptics.selection();
    setDraft((d) => ({ ...d, form }));
  };
  const pickFace = (face: AvatarFace) => {
    if (face === draft.face) return;
    void haptics.selection();
    setDraft((d) => ({ ...d, face }));
    // The Bot tries its new face on with a smile.
    setReaction((n) => n + 1);
  };
  const pickJewel = (tone: BotCrestTone) => {
    void haptics.selection();
    setDraft((d) => ({ ...d, tone, ...huesOfTone(tone) }));
  };
  const keep = async () => {
    await saveBotLook(botId, lookChoiceFor(look, natural));
    void haptics.success();
    onClose();
  };

  return (
    <ScrollView
      scrollEnabled={!dragging}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}>
      <View style={styles.stage}>
        <ColourWheel
          size={wheel}
          lit={draft.lit}
          shade={draft.shade}
          linked={draft.linked}
          onDragChange={setDragging}
          onChange={({ lit, shade }) => setDraft((d) => ({ ...d, lit, shade, tone: toneFromHues(lit, shade) }))}>
          <PressableScale
            onPress={() => {
              void haptics.light();
              setReaction((n) => n + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${name ?? botId}, as it will look`}>
            <Animated.View key={draft.form} entering={formArrives}>
              <BotFigure look={look} size={hero} seed={botId} reaction={reaction} wake />
            </Animated.View>
          </PressableScale>
        </ColourWheel>
      </View>

      <View style={styles.caption}>
        <Text style={styles.colourName} numberOfLines={1}>
          {colourName}
        </Text>
        <PressableScale
          onPress={() => {
            void haptics.selection();
            setDraft((d) => ({ ...d, linked: !d.linked }));
          }}
          accessibilityRole="switch"
          accessibilityState={{ checked: draft.linked }}
          accessibilityLabel="Turn both hues together"
          style={[styles.link, { backgroundColor: draft.linked ? tokens.rowSelected : 'transparent', borderColor: tokens.border }]}>
          <Icon
            name={
              draft.linked
                ? { ios: 'link', android: 'link', web: 'link' }
                : { ios: 'circle.lefthalf.filled', android: 'contrast', web: 'contrast' }
            }
            size={13}
            color={draft.linked ? 'textPrimary' : 'textSecondary'}
          />
          <Text variant="caption" color={draft.linked ? 'primary' : 'secondary'}>
            {draft.linked ? 'Linked' : 'Twilight'}
          </Text>
        </PressableScale>
      </View>

      <Text variant="eyebrow" color="tertiary" style={styles.section}>
        House jewels
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.jewels}>
        {BOT_CREST_TONES.map((tone, index) => (
          <PressableScale
            key={tone.from}
            onPress={() => pickJewel(tone)}
            accessibilityRole="button"
            accessibilityState={{ selected: index === jewel }}
            accessibilityLabel={HOUSE_JEWEL_NAMES[index]}>
            <JewelSwatch tone={tone} selected={index === jewel} />
          </PressableScale>
        ))}
      </ScrollView>

      <Text variant="eyebrow" color="tertiary" style={styles.section}>
        Form
      </Text>
      <ScrollView ref={formRail} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {AVATAR_FORMS.map((form) => (
          <RailTile
            key={form}
            label={AVATAR_FORM_NAMES[form]}
            selected={form === draft.form}
            tone={draft.tone}
            onPress={() => pickForm(form)}>
            <BotFigure look={{ ...look, form }} size={50} seed={`${botId}:${form}`} animated={false} />
          </RailTile>
        ))}
      </ScrollView>

      <Text variant="eyebrow" color="tertiary" style={styles.section}>
        Face
      </Text>
      <ScrollView ref={faceRail} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {AVATAR_FACES.map((face) => (
          <RailTile
            key={face}
            label={AVATAR_FACE_NAMES[face]}
            selected={face === draft.face}
            tone={draft.tone}
            onPress={() => pickFace(face)}>
            <BotFigure look={{ ...look, face }} size={50} seed={`${botId}:${face}`} animated={face === draft.face} />
          </RailTile>
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          label="Natural look"
          variant="ghost"
          size="sm"
          disabled={isNatural}
          onPress={() => {
            void haptics.selection();
            setDraft((d) => ({ ...d, form: natural.form, face: natural.face, tone: natural.tone, ...huesOfTone(natural.tone) }));
            setReaction((n) => n + 1);
          }}
        />
        <Button label={unchanged ? 'Done' : 'Keep this look'} onPress={() => void (unchanged ? onClose() : keep())} style={styles.keep} />
      </View>
    </ScrollView>
  );
}

function RailTile({
  label,
  selected,
  tone,
  onPress,
  children,
}: {
  label: string;
  selected: boolean;
  tone: BotCrestTone;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const tokens = useTokens();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.tile, { backgroundColor: selected ? tokens.rowSelected : 'transparent' }]}>
      {children}
      <Text variant="micro" color={selected ? 'primary' : 'tertiary'} numberOfLines={1}>
        {label}
      </Text>
      {/* The chosen tile carries a bar of the stone's own light. */}
      <View style={[styles.tileBar, { backgroundColor: selected ? tone.from : 'transparent' }]} />
    </PressableScale>
  );
}

function JewelSwatch({ tone, selected }: { tone: BotCrestTone; selected: boolean }) {
  const id = `jewel-${tone.from.slice(1)}-${tone.to.slice(1)}`;
  const d = 30;
  return (
    <View style={[styles.swatch, { borderColor: selected ? '#FFFFFF' : 'transparent' }]}>
      <Svg width={d} height={d}>
        <Defs>
          <LinearGradient id={id} x1="0.15" y1="0" x2="0.85" y2="1">
            <Stop offset="0" stopColor={tone.from} />
            <Stop offset="1" stopColor={tone.to} />
          </LinearGradient>
        </Defs>
        <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${id})`} />
        <Circle cx={d * 0.36} cy={d * 0.3} r={d * 0.12} fill="#FFFFFF" fillOpacity={0.35} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: Spacing.three,
  },
  stage: {
    alignItems: 'center',
    paddingTop: Spacing.one,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    marginTop: Spacing.two,
  },
  colourName: {
    flexShrink: 1,
    fontFamily: FontFamily.serifItalic,
    fontSize: 26,
    lineHeight: 32,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  section: {
    marginTop: Spacing.three,
    marginBottom: Spacing.one,
    paddingHorizontal: Spacing.one,
  },
  jewels: {
    gap: 10,
    paddingHorizontal: Spacing.one,
    paddingVertical: 2,
  },
  swatch: {
    padding: 2,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  rail: {
    gap: 4,
    paddingHorizontal: 2,
  },
  tile: {
    width: 74,
    alignItems: 'center',
    gap: 6,
    paddingTop: 10,
    paddingBottom: 8,
    borderRadius: Radius.lg,
  },
  tileBar: {
    width: 18,
    height: 2,
    borderRadius: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginTop: Spacing.four,
    paddingHorizontal: Spacing.one,
  },
  keep: {
    flexGrow: 1,
    maxWidth: 220,
  },
});
