import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { AppHeader } from './AppHeader';

export type PageTitleProps = {
  title: string;
  /** The control row above the title: a menu or back button, trailing actions. */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** One quiet line under the title — usually a status. */
  status?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * The page shape of `AppHeader`, kept as a named entry point for screens that
 * have not moved onto the variant prop yet. It renders the same header — one
 * component owns the title area, so this is a façade, not a second header.
 */
export function PageTitle({ title, leading, trailing, status, style }: PageTitleProps) {
  return (
    <AppHeader
      variant="page"
      title={title}
      leading={leading}
      trailing={trailing}
      status={status}
      style={style}
    />
  );
}
