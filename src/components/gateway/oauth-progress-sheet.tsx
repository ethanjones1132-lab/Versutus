import { BaseSheet, Text } from '@/components/ui';

export function OauthProgressSheet({
  visible,
  message,
  onClose,
}: {
  visible: boolean;
  message: string;
  onClose: () => void;
}) {
  return (
    <BaseSheet visible={visible} onClose={onClose}>
      <Text variant="title">Authorizing</Text>
      <Text variant="body">{message}</Text>
    </BaseSheet>
  );
}
