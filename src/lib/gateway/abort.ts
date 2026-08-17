/** A mutable holder for the controller of whatever request is in flight. */
export type AbortControllerRef = { current: AbortController | null };

/**
 * Abort whatever is in flight and clear the ref, reporting whether there was
 * anything to abort.
 *
 * Cancelling has to actually stop the work. Marking a transcript "cancelled"
 * without aborting leaves the gateway running, and its completion then
 * re-updates the very message the user cancelled.
 */
export function abortAndClear(ref: AbortControllerRef): boolean {
  const controller = ref.current;
  if (!controller) return false;
  ref.current = null;
  controller.abort();
  return true;
}
