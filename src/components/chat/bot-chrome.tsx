import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { botChromeToggleLabel } from '@/lib/gateway/bot-chrome';

export function BotChrome({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <View style={styles.toggle}>
        <Button
          label={botChromeToggleLabel(open)}
          variant="ghost"
          size="sm"
          onPress={() => setOpen((value) => !value)}
        />
      </View>
      {open ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
});
