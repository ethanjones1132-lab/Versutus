import { Redirect } from 'expo-router';

/**
 * Where the app root `/` lands. Chat is the product surface (CHARTER /
 * visual-direction 2026-09), so the cold-start URL hands the operator
 * straight to the roster. The Gate dashboard lives at `/home` behind the
 * drawer's thin Gate status — not a bottom destination.
 *
 * The redirect is a `replace` (that is what `Redirect` does): `/` is not a
 * place to come back to. Deep links, notification taps, and onboarding
 * already name `/chat` (or another concrete path), so nothing here can race
 * them — this route only answers the bare root.
 */
export default function RootTabLand() {
  return <Redirect href="/chat" />;
}
