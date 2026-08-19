import Svg, { Circle, Path } from 'react-native-svg';

/**
 * Web-only vector icon fallback. `expo-symbols`' SymbolView has no web surface,
 * so feature components used to fall back to a raw monochrome glyph (\u2699),
 * which read as a rendering bug. This maps the handful of symbols the UI
 * actually needs to minimal inline paths drawn from the design palette.
 */
export function WebSymbol({
  name,
  size = 22,
  color = '#F0D690',
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  const normalized = name.replace(/\.fill$/, '');
  const glyph = GLYPHS[normalized] ?? GLYPHS.gearshape;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityLabel={name}>
      {glyph(color)}
    </Svg>
  );
}

const GLYPHS: Record<string, (color: string) => React.ReactNode> = {
  gearshape: (color) => (
    <>
      <Circle cx="12" cy="12" r="7.5" stroke={color} strokeWidth="1.8" />
      <Path
        d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22M4.93 4.93l3.18 3.18M15.89 15.89l3.18 3.18M19.07 4.93l-3.18 3.18M8.11 15.89l-3.18 3.18"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </>
  ),
  settings: (color) => GLYPHS.gearshape(color),
  xmark: (color) => (
    <Path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
  ),
  close: (color) => GLYPHS.xmark(color),
  chevronRight: (color) => <Path d="M9 5l7 7-7 7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  chevronLeft: (color) => <Path d="M15 5l-7 7 7 7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  plus: (color) => <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth="1.8" strokeLinecap="round" />,
  checkmark: (color) => <Path d="M4 12l5 5L20 6" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  arrowLeft: (color) => <Path d="M19 12H5m6-7-7 7 7 7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
};
