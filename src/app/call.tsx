import { Redirect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useId } from 'react';
import { Platform } from 'react-native';

import { useGateway } from '@/context/gateway-provider';
import { deepLinkTarget, namedCallEngine } from '@/lib/gateway/deep-link';
import { supportsHandsfreeCalls } from '@/lib/voice/voice-engine-choice';

/** Expo Router's landing for the native `versutus://call` intent. */
export default function CallLinkLanding() {
  const query = useLocalSearchParams();
  const router = useRouter();
  const focused = useIsFocused();
  const callRequest = useId();
  const { status, openBot, requestSurface } = useGateway();
  const supported = supportsHandsfreeCalls(Platform.OS);
  const target = deepLinkTarget('call', query);
  const botId = target?.kind === 'call' ? target.botId : undefined;
  const engine = namedCallEngine(query);

  useEffect(() => {
    if (!focused || !supported || (botId && status !== 'connected')) return undefined;
    const destination = {
      pathname: '/chat' as const,
      params: { call: '1', callRequest, callBot: botId, engine },
    };
    // In-app links can request the confirmation sheet. The native signature
    // check owns any widget auto-start, so its parameters never follow this route.
    if (!botId) {
      router.replace(destination);
      return undefined;
    }

    let focusedRequest = true;
    const finish = (opened: boolean) => {
      if (!focusedRequest) return;
      requestSurface(opened ? { kind: 'bot', botId } : { kind: 'roster' });
      router.replace(opened ? destination : '/chat');
    };
    void openBot(botId).then(finish, () => finish(false));
    return () => {
      focusedRequest = false;
    };
  }, [focused, supported, status, botId, engine, callRequest, openBot, requestSurface, router]);

  return supported ? null : <Redirect href="/chat" />;
}
