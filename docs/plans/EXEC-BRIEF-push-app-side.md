# Execution brief — push on model final response, APP SIDE ONLY

The Gate side is fully done, tested, and verified. **Do not touch anything
under `gate/`.** `gate/core/push-tokens.mjs`, `push-send.mjs`, `push-rpc.mjs`,
`push-notifier.mjs`, and their tests all exist and pass (745/745 gate tests,
full `npm run verify` exit 0 on the tree as it stands right now).

Execute the remaining app-side steps of
`docs/plans/2026-09-11-push-final-response.md`:

## Scope — implement ONLY these steps, in order

**A1.** Tap router: add the `routine` kind (A5's push spelling, alongside the
existing local `routine-due`) and a new `reply` kind to
`src/lib/notifications/tap-route.ts`. `reply` carries `{ sessionId: string;
botId?: string }` — `sessionId` required, half-shaped payloads return null
(fall back to Activity), matching the module's existing "never guess an id"
rule. Test file: `__tests__/notification-tap-route-test.ts` (existing file,
add cases).

**A2.** Create `src/lib/notifications/push-registration.ts` per the plan's
code sketch: `loadStoredExpoPushToken`, `obtainExpoPushToken`,
`registerWithGate`, `deregisterWithGate`, `syncPushRegistration`. Test:
`__tests__/push-registration-test.ts` (new file). Mock `expo-notifications`,
`expo-constants`, and secure storage — do not call the real Expo API in tests.

**A3.** Android notification channels + foreground handler: modify
`src/lib/notifications/local.ts` (add the three channels next to
`RUN_PROGRESS_CHANNEL_ID`: `approvals` HIGH, `model-replies` DEFAULT,
`routine-results` DEFAULT) and `src/app/_layout.tsx` (call the channel-ensure
function from the same mount effect that already calls
`registerNotificationCategories`). Test: `__tests__/push-channels-test.ts`
(new file).

Read the plan's own text for A1/A2/A3 for full detail — this brief summarizes,
the plan is authoritative.

## Explicitly OUT of scope

G5, G5b, G6, A4, A4b, A5, A6 — all depend on work not yet done or decisions
not yet made. Do not touch `README.md`. Never describe this feature as "push"
in user-facing copy.

## Hard rules

- Each step lists its tests first. Write the tests, then the implementation.
- App tests: `npx jest __tests__/<file> --runInBand`
- After all three steps, run the **full** `npm run verify`. It must pass.
  Never weaken a test, a lint rule, or the coverage ratchet to get green.
- **Do NOT modify `package.json` and do NOT run `npm install`.** These steps
  need no new dependencies (expo-notifications and expo-constants are already
  installed).
- If a test you write fails, check whether the bug is in your test or your
  implementation before concluding either — do not loosen an assertion
  without understanding why it failed first.
- If a step's premise is false — a file is not where the plan says, an API
  differs — STOP and report. Do not invent an API.
- Commit nothing. Leave all changes in the working tree.
- Touch only the files these three steps name.

## Report when done

Print a short summary: steps completed, files changed, test results, the
final `npm run verify` result, and anything you stopped on.
