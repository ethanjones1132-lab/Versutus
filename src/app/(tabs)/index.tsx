import { Redirect } from 'expo-router';

/**
 * Where the app root `/` lands. Chat is the hero route (docs/visual-
 * direction-2026-09.md), so the cold-start URL hands the operator straight
 * to the roster — the old command-center dashboard moved to `/home` behind
 * its own trailing tab trigger and is no longer the default pillar.
 *
 * The redirect is a `replace` (that is what `Redirect` does): `/` is not a
 * place to come back to. Deep links, notification taps, and onboarding
 * already name `/chat` (or another concrete path), so nothing here can race
 * them — this route only answers the bare root.
 */
export default function RootTabLand() {
  return <Redirect href="/chat" />;
}
