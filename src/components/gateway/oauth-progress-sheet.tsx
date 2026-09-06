import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export function OauthProgressSheet({
  visible,
  message,
  authorizationUrl,
  onClose,
}: {
  visible: boolean;
  message: string;
  authorizationUrl?: string;
  onClose: () => void;
}) {
  return (
    <BaseSheet visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <Text variant="title">Authorizing</Text>
        <Text variant="body">{message}</Text>
        {authorizationUrl ? (
          <>
            <Text variant="caption" color="tertiary" numberOfLines={3}>
              {authorizationUrl}
            </Text>
            <Button
              label="Open in browser"
              onPress={() => {
                void WebBrowser.openBrowserAsync(authorizationUrl).catch(() => undefined);
              }}
            />
          </>
        ) : null}
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: Spacing.two,
  },
});
