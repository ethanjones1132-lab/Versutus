import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { Palette } from '@/constants/tokens';

type VersutusMarkProps = {
  size?: number;
  /** Rounded sapphire gradient tile behind the motif */
  showBackground?: boolean;
};

export function VersutusMark({ size = 76, showBackground = true }: VersutusMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 76 76">
      <Defs>
        <LinearGradient id="versutusMarkBg" x1="38" y1="0" x2="38" y2="76" gradientUnits="userSpaceOnUse">
          <Stop stopColor={Palette.accent} />
          <Stop stopColor="#1E3A6E" />
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
        stroke={Palette.accentWarm}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={38} cy={18} r={5} fill={Palette.accentWarm} />
      <Circle cx={38} cy={18} r={2} fill="#1E3A6E" />
    </Svg>
  );
}