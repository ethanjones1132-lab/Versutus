# Execution brief — wire the `reply` notification tap to actually open the conversation

**Context.** A prior pass added `kind: 'reply'` to `routeForTap`
(`src/lib/notifications/tap-route.ts`) so a push notification for a finished
model reply carries `{ sessionId, botId? }`. That part is done and tested
(19/19 in `__tests__/notification-tap-route-test.ts`). But the response
listener in `src/app/_layout.tsx` never acts on it: `destinationFor` only
special-cases `'routine'` (→ `/chat`); every other kind, `'reply'` included,
falls through to `/activity`. **Right now a reply notification tap opens
Activity, not the conversation it is about — the exact wrong behavior this
kind exists to fix.** This was caught by reading the code directly (grep for
`routeForTap` in `_layout.tsx` and read `destinationFor`'s body), not assumed —
confirm it yourself the same way before changing anything.

## What to build

In `src/app/_layout.tsx`:

1. `destinationFor` must map `route?.kind === 'reply'` to `/chat` as well as
   `'routine'` (same tab — the comment there already explains why: the chat
   tab is where a specific session gets opened).
2. Add a side-channel exactly mirroring the existing `runFocusFor` /
   `runFocusRef` pattern (read that pattern in full before writing anything —
   it is the precedent to copy, not to reinvent):
   - A pure accessor `replySessionFor(data): { sessionId: string } | null`
     using `routeForTap`, returning the sessionId when `route?.kind ===
     'reply'`, else `null`.
   - A ref (e.g. `replySessionRef`) populated the same way `runFocusRef.current
     = requestRunFocus` is populated in the effect at line ~205 — except this
     one needs to actually **open the session**, not just call a context
     setter. Use `openSessionById` (`src/lib/gateway/session-open-by-id.ts`)
     for the open — it validates via `session.get` before switching ("never
     switch on a missing id" is that module's own stated rule), which matters
     here because a push-delivered sessionId can be stale by the time it is
     tapped (session deleted or expired server-side in the meantime).
     `useGateway()` already exposes `gatewayRequest` directly in this same
     component (confirmed: it's in the same destructure that yields
     `requestRunFocus`) — that is the `ThreadSwitchRequest`-shaped function
     `openSessionById` needs as its first argument.
   - **Before wiring this by hand, grep the codebase for an existing call site
     of `openSessionById(`** — it is already used somewhere (its own header
     comment describes a sheet's "Open by id" row calling it) and that call
     site is the proven, working pairing with whatever `gatewayRequest`
     actually looks like at the call boundary. Mirror it exactly rather than
     guessing the argument shape.
   - Call the ref right after navigation, in the same place and the same way
     `if (runFocus) runFocusRef.current?.(runFocus);` already does (there are
     two call sites for that line — the live listener and the launch-replay
     path below it; wire both, matching how `runFocus` itself is handled at
     both).
3. **On an `openSessionById` failure** (stale/deleted session): do not silently
   fail. Use `openSessionByIdFailureText(sessionId, error)` from the same
   module to produce the message, and surface it the same way this file
   already surfaces other tap-time failures (read how `notifyApprovalRefused`
   is called nearby for the established idiom — a local notice, not a thrown
   error and not a silent no-op). The tab has already navigated to `/chat` by
   this point; leave it there rather than bouncing to Activity, since Chat is
   still a reasonable place to land even without the specific session opened.
4. **On success**, the operator lands in the exact conversation the reply
   happened in — that is the entire point of this fix.

## Constraints

- Do not touch `routeForTap`, `tap-route.ts`, or its tests — they are correct
  and already verified. This brief is only about consuming the `reply` route
  that already exists, not producing it.
- Do not modify `package.json` or run `npm install` — no new dependency is
  needed.
- Do not touch `gate/`, `README.md`, or anything under `docs/plans/`.
- Preserve every existing comment's accuracy. If a comment you are near
  becomes stale because of your change (e.g. the comment above `destinationFor`
  currently says "a routine notice opens Chat... Runs, approvals and anything
  unrecognized stay on Activity" — that sentence becomes wrong once `reply`
  also opens Chat), update the comment, do not leave it contradicting the code
  beneath it.
- If any assumption in this brief turns out to be false — `runFocusFor`'s
  shape differs from what is described, `openSessionById` has no existing
  caller to mirror, `gatewayRequest` is not actually compatible — STOP and
  report exactly what you found. Do not invent a workaround.

## Tests

Add cases to whatever test file already covers this listener's routing
behavior (find it — search for existing tests of `destinationFor` or
`runFocusFor`, likely a `_layout` test or a dedicated notification-routing
test; do not create a new file if one already covers this logic). Cover:

- a `reply` payload navigates to `/chat` (not `/activity`)
- a `reply` payload with a resolvable sessionId triggers the session open
- an unresolvable sessionId surfaces the failure notice and does not throw
- existing `routine` and `run` routing behavior is unchanged (regression)
- the launch-replay path (the second call site) behaves identically to the
  live listener path

Run whatever the discovered test file's existing `npx jest` invocation is.
Then run the **full** `npm run verify` — it must pass, unchanged rules on
weakening tests/lint/coverage.

## Report when done

Files changed, test results, full `npm run verify` result, and the exact
existing `openSessionById` call site you found and mirrored (or, if none
exists, say so plainly rather than silently inventing the wiring).
