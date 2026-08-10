import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';

import { Palette, type SemanticColor } from '@/constants/tokens';

export type IconName = {
  ios: SFSymbol;
  android: string;
  web: string;
};

export type IconProps = {
  name: IconName;
  size?: number;
  /** Semantic palette key, or a raw color string. */
  color?: SemanticColor | string;
  weight?: React.ComponentProps<typeof SymbolView>['weight'];
  style?: React.ComponentProps<typeof SymbolView>['style'];
};

/** Cross-platform native symbol (SF Symbols on iOS, Material Symbols elsewhere). */
export function Icon({ name, size = 20, color = 'textPrimary', weight, style }: IconProps) {
  const tintColor = color in Palette ? Palette[color as SemanticColor] : color;

  return (
    <SymbolView
      name={name as React.ComponentProps<typeof SymbolView>['name']}
      size={size}
      tintColor={tintColor}
      weight={weight}
      style={style}
    />
  );
}
