import { Redirect, type Href } from 'expo-router';

/** Folded into the consolidated setup screen; kept so existing links resolve. */
export default function EnvironmentsRedirect() {
  return <Redirect href={"/gateway/setup" as Href} />;
}
