import { TlsFingerprintChangeSheet } from '@/components/gateway/tls-fingerprint-change-sheet';
import { useGateway } from '@/context/gateway-provider';

/**
 * Mounts the TLS change prompt above every screen.
 *
 * A fingerprint mismatch aborts the connect attempt wherever it was started —
 * setup, the home dashboard or a reconnect — so this cannot live inside the
 * chat screen: the user would be left with a gateway that silently refuses to
 * connect and no way to resolve it.
 */
export function TlsFingerprintGuard() {
  const { tlsFingerprintChange, approveTlsFingerprintChange, rejectTlsFingerprintChange } = useGateway();

  return (
    <TlsFingerprintChangeSheet
      visible={!!tlsFingerprintChange}
      previousFingerprint={tlsFingerprintChange?.previousFingerprint ?? ''}
      observedFingerprint={tlsFingerprintChange?.observedFingerprint ?? ''}
      gatewayLabel={tlsFingerprintChange?.gatewayName}
      onApprove={() => void approveTlsFingerprintChange()}
      onReject={rejectTlsFingerprintChange}
    />
  );
}
