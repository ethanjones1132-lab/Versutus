import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { Palette } from '@/constants/tokens';

type VersutusMarkProps = {
  size?: number;
  /** Rounded brand-violet gradient tile behind the motif */
  showBackground?: boolean;
};

export function VersutusMark({ size = 76, showBackground = true }: VersutusMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 76 76">
      <Defs>
        {/* Violet light falling onto the tile from its top-left corner. Both
            stops need an offset: without one they sit together at 0 and the
            tile renders flat. */}
        <LinearGradient id="versutusMarkBg" x1="0" y1="0" x2="76" y2="76" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={Palette.accent} />
          <Stop offset="1" stopColor={Palette.accentDeep} />
        </LinearGradient>
      </Defs>

      {showBackground ? <Rect width={76} height={76} rx={18} fill="url(#versutusMarkBg)" /> : null}

      <Path
        d="M22 26 L38 54 L54 26"
        stroke={Palette.textPrimary}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M38 22 L38 30"
        stroke={Palette.textPrimary}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={38} cy={18} r={5} fill={Palette.textPrimary} />
      <Circle cx={38} cy={18} r={2} fill={Palette.background} />
    </Svg>
  );
}