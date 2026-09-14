/**
 * The map's connect sheet: what the two-truth map exists to drive.
 *
 * Tapping a saved node opens this sheet. Every word it renders comes from
 * the screen through the fold — the Connect control's label and enabled
 * state, the humanized failure cause, the gateway's own status word — so
 * the sheet owns no decision of its own, only the drawer's words.
 */

import { Button, BaseSheet, Text } from '@/components/ui';
import type { ConstellationConnectOffer } from '@/lib/fleet/connect-offer';

export function FleetConnectSheet({
  gatewayName,
  offer,
  onConnect,
  onClose,
}: {
  gatewayName: string;
  /** The fold's own answer for the node the sheet is open on. */
  offer: ConstellationConnectOffer;
  onConnect: () => void;
  onClose: () => void;
}) {
  return (
    <BaseSheet
      visible
      title={gatewayName}
      eyebrow="CONNECT"
      onClose={onClose}
      closeLabel="Close">
      <Text variant="caption" color="secondary">
        {offer.detail
          ? offer.detail
          : 'Connect this saved gateway to make it the live one on the ring.'}
      </Text>
      <Button
        label={offer.label}
        onPress={onConnect}
        disabled={!offer.tappable}
        expanded
        accessibilityHint="Connects this saved gateway and opens chat with it."
      />
    </BaseSheet>
  );
}
