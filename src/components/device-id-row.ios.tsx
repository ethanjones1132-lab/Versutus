import { Button as SwiftButton, ContextMenu, Host } from '@expo/ui/swift-ui';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

type CopyKind = 'id' | 'cmd';

export function DeviceIdRow({
  deviceId,
  copied,
  onCopy,
}: {
  deviceId: string;
  copied: CopyKind | null;
  onCopy: (text: string, kind: CopyKind) => void;
}) {
  return (
    <View style={styles.step}>
      <Text variant="caption" color="secondary">
        Your device ID
      </Text>
      <Host matchContents style={styles.contextHost}>
        <ContextMenu>
          <ContextMenu.Trigger>
            <Pressable style={styles.copyRow} onPress={() => void onCopy(deviceId, 'id')}>
              <Text variant="mono" style={styles.copyValue} numberOfLines={2}>
                {deviceId}
              </Text>
              <Text variant="caption" color={copied === 'id' ? 'accent' : 'tertiary'}>
                {copied === 'id' ? 'Copied' : 'Copy'}
              </Text>
            </Pressable>
          </ContextMenu.Trigger>
          <ContextMenu.Items>
            <SwiftButton label="Copy device ID" onPress={() => void onCopy(deviceId, 'id')} />
          </ContextMenu.Items>
        </ContextMenu>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  step: {
    gap: Spacing.one,
  },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  copyValue: {
    flex: 1,
  },
  contextHost: {
    alignSelf: 'stretch',
  },
});