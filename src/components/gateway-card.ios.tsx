import { Button as SwiftButton, Host, SwipeActions } from '@expo/ui/swift-ui';
import { buttonStyle, tint } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

import { GatewayCardInner, type GatewayCardInnerProps } from '@/components/gateway-card-inner';
import { useTokens } from '@/hooks/use-tokens';

export function GatewayCard({ onDelete, ...props }: GatewayCardInnerProps) {
  const tokens = useTokens();

  return (
    <Host style={styles.host}>
      <SwipeActions>
        <GatewayCardInner {...props} onDelete={onDelete} showDeleteButton={false} />
        <SwipeActions.Actions edge="trailing" allowsFullSwipe>
          <SwiftButton
            role="destructive"
            label="Delete"
            onPress={onDelete}
            modifiers={[buttonStyle('bordered'), tint(tokens.statusDisconnected)]}
          />
        </SwipeActions.Actions>
      </SwipeActions>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
  },
});