import { Redirect } from 'expo-router';

/**
 * Where a `versutus://compose?text=…` link lands.
 *
 * Item 5's internal handoff puts a shared text in a thread's composer rather
 * than in the send path, and WHICH thread is the Chat screen's own call — the
 * router that reads the link hands the words over as a request
 * (`requestComposeRequest` / `composeRequestApplies`), so nothing here ever
 * sees the text. What this route is for is the ARRIVAL: a path with no route
 * of its own is answered by expo-router's generated `+not-found`, so a shared
 * text used to land the operator on "Unmatched Route" with the Chat tab the
 * deep-link router pushes sitting on top of it. The one thing this route
 * says is where that arrival belongs.
 *
 * The redirect is a `replace` (that is what `Redirect` does): the compose
 * path is not a place to come back to. A device with no gateway never reaches
 * this route at all — the boot overlay withholds the Stack until bootstrap,
 * and its first-run redirect still decides where that operator lands.
 */
export default function ComposeLinkLanding() {
  return <Redirect href="/chat" />;
}
