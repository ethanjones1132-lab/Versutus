import { ScrollView } from 'react-native';

import { BaseSheet, Text } from '@/components/ui';
import type { EnvironmentRunEvent } from '@/lib/gateway/environment-types';

export function EnvironmentRunSheet({
  visible,
  events,
  onClose,
}: {
  visible: boolean;
  events: EnvironmentRunEvent[];
  onClose: () => void;
}) {
  return (
    <BaseSheet visible={visible} onClose={onClose}>
      <Text variant="title">Run events</Text>
      <ScrollView>
        {events.map((event) => (
          <Text key={`${event.runId}-${event.sequence}`} variant="caption">
            {event.sequence} {event.type}
          </Text>
        ))}
      </ScrollView>
    </BaseSheet>
  );
}
