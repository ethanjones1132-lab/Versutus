import { Redirect, Stack } from 'expo-router';

import { VersutusDarkTheme } from '@/constants/navigation-theme';

export default function DevLayout() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: VersutusDarkTheme.colors.card },
        headerTintColor: VersutusDarkTheme.colors.text,
        contentStyle: { backgroundColor: VersutusDarkTheme.colors.background },
      }}>
      <Stack.Screen name="preview" options={{ title: 'UI Preview' }} />
    </Stack>
  );
}