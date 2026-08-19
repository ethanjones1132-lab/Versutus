# Hardening & Capability Plan — 2026-08-19

Successor to `hardening-and-capability-plan-2026-08-17.md` and to Kimi's
`carnage-starman-karnak` implementation roadmap, which is now **complete**.

Same format: **Why** (impact) and **Fix** (approach), ordered by impact-per-effort.

---

## What landed (the success being hardened)

Kimi implemented Phases 0–9 of its roadmap until it hit its billing-cycle usage
limit (`403`, 07:21:35Z, turnStep 0.259). Claude resumed and closed the rest.

| Phase | Scope | Landed by | State |
|---|---|---|---|
| 0 | Expo 57 in `AGENTS.md`, `feat/hardening-a2-c4` branch | Kimi | done |
| 1 | A2 — `message-reducer.ts` + regression locks | Kimi | done |
| 2 | A3 — jest coverage floor | Kimi + Claude | done (see below) |
| 3 | A5 — server-side cancel, 5 pre-flight guards documented | Kimi | done |
| 4 | B2 — `error-humanizer.ts`, `ConfirmSheet`, 6 `Alert.alert` removed | Kimi | done |
| 5 | B3 — gateway surface consolidation, redirect stubs deleted | Kimi | done |
| 6 | B4 — slash-command palette | Claude | done |
| 7 | C1 — interrupted-stream resume | Kimi (logic) + Claude (tests) | done |
| 8 | C2 — settle unresolved runs | Kimi (logic) + Claude (tests) | done |
| 9 | C4 — TLS fingerprint TOFU | Kimi (logic) + Claude (UI) | done |

Verification at time of writing: **53 jest suites / 393 tests**, **390 gate tests**,
`tsc --noEmit` clean, `eslint` clean, coverage floor enforced, `npm run verify`
exit 0.

### Three things the handoff got wrong

Verified against the repo — worth recording, because each was a *silent* failure
that no existing check would have caught:

- **The working tree was left syntactically broken.** `gateway-provider.tsx:2292`
  had a value-object entry (`tlsFingerprintChange: … ? {…} : null`) pasted into a
  `useMemo` **dependency array**, where property syntax is illegal — `TS1005`.
  Kimi's last edit was cut off mid-apply by the 403. Nothing but a human running
  `verify` would have surfaced it.
- **The coverage floor was dead config.** `coverageThreshold` was added to
  `package.json`, but `npm test` runs `jest --runInBand` with no `--coverage`, so
  the threshold never executed. It gated nothing for the entire phase.
- **`tlsFingerprintChange` shipped with no consumer.** The provider computed the
  mismatch, set state, and `return`ed — blocking the connect — but nothing
  rendered it. The gateway became permanently unconnectable with no explanation
  and no way to approve. Typecheck cannot catch exposed-but-unrendered state.

The common shape: **config and state that exist but do nothing.** Part A attacks
that class directly rather than the three instances.

---

## Part A — Harden (do first)

### A1. TOFU silently trusts a changed fingerprint on discovered gateways 🔴
- **Why:** **This is a live security hole in last night's work, not a hypothetical.**
  `checkTlsFingerprintTofu` returns `first-seen` whenever `tlsFingerprintTrusted`
  is falsy — *without checking whether a different fingerprint is already stored*.
  Gateways added from LAN discovery (`use-gateway-settings-screen.ts:59`) record
  `tlsFingerprint` from the beacon but never set the trusted flag. So on the first
  connect after upgrade, a fingerprint that **differs from the one discovery
  recorded** is silently accepted and persisted as trusted. Proven:
  `checkTlsFingerprintTofu({tlsFingerprint:'AA:AA:AA'}, 'BB:BB:BB')` →
  `{kind:'first-seen'}` where security requires `changed`. This defeats the
  feature on exactly the transport (LAN discovery) whose threat model motivated it.
- **Fix:** Treat a stored-but-untrusted fingerprint that differs from the observed
  one as `changed`, not `first-seen`. Only a profile with *no* stored fingerprint
  is genuinely first-seen. Add regression tests for all four quadrants of
  (stored?, trusted?) × (matches?, differs?).

### A2. Fail the build on dead config
- **Why:** Two no-op configs shipped this cycle (the coverage floor above; and per
  the 08-17 plan, `smoke:portal` assertions that had been silently red since
  2026-08-05). Config that looks like a gate but runs nothing is worse than no
  config — it buys false confidence.
- **Fix:** `scripts/verify-config.mts`, wired into `verify`, asserting:
  every `coverageThreshold` key resolves to files that exist and are actually
  collected; every npm script referenced by `.github/workflows/ci.yml` exists;
  the Expo version cited in `AGENTS.md` matches the `expo` dependency in
  `package.json`. Each is a one-line failure the moment it drifts.

### A3. Fail the build on context state with no consumer
- **Why:** `tlsFingerprintChange` was exposed on `GatewayContextValue` and never
  rendered — a whole feature that could not be reached. The provider now exposes
  ~60 keys; nothing checks that any of them are used.
- **Fix:** A test that parses the `GatewayContextValue` type members and asserts
  each key appears somewhere under `src/app` or `src/components`. Allow an
  explicit opt-out list for genuinely provider-internal values, so the exception
  is written down rather than silent.

### A4. Ratchet coverage instead of pinning it
- **Why:** The floor is a static 38/30/40/40 against actual 42.65/33.8/45.29/45.12.
  A static floor rots: it permits a slow slide down to the number, and nobody
  raises it.
- **Fix:** `scripts/coverage-ratchet.mts` reading `coverage-summary.json` — fail if
  any metric drops below the committed baseline, and rewrite the baseline upward
  when it improves. Turns coverage into a one-way door.

### A5. Cover `slash-commands.ts`
- **Why:** 1711+ lines, **18% statement coverage** — the largest and least-tested
  module in the app, and now the data source behind the new palette. The palette
  makes every one of those commands reachable in one tap, which raises the cost of
  a bad mapping from "power user hits it" to "anyone browsing hits it".
- **Fix:** Table-driven tests over the command registry: every command has a
  non-empty slash, description and family; no two commands claim the same slash;
  `danger` is one of the three legal values; every `slash` starts with `/`.

---

## Part B — Quality of life

### B1. Reach the palette from the keyboard, not just the toolbar
- **Why:** The palette is currently opened by a toolbar button. Typing `/` still
  shows only the 12-row inline strip, so the discovery problem is only half
  solved — a user who types `/` and sees 12 rows has no signal that ~100 more exist.
- **Fix:** Append a "Browse all N commands" row to the end of the inline strip that
  opens the palette pre-filtered with the current draft.

### B2. Remember what you actually run
- **Why:** `Recent` is already a palette family, but it is fed from
  `recentCommands` which is session-shaped. Frequency beats recency for a surface
  this large.
- **Fix:** Persist a small frequency map alongside recents; sort the `Recent`
  group by frequency-then-recency. Pure, testable, no new UI.

### B3. Humanize the surfaces the humanizer does not yet cover
- **Why:** B2 (08-17) routed `lastError` through `humanizeGatewayError` in chat and
  the dashboard, but the new TLS and palette paths raise their own failures, and
  the connect timeline still renders some raw text.
- **Fix:** Audit every remaining raw-error render site; route through `ErrorCard`.

---

## Part C — Capability

### C1. Gateway-side history cursor *(the debt B1/08-17 deferred)*
- **Why:** "Load earlier" works by re-fetching with an ever-larger limit — it
  re-downloads the whole window each tap and cannot page past whatever ceiling the
  gateway enforces. The 08-17 plan explicitly deferred the correct fix.
- **Fix:** Add `before`/`cursor` to `/api/sessions/{id}/messages` in the gate,
  thread it through `manifest-client.ts`, and switch `loadEarlierMessages` to it.
  Keep the limit-growing path as the fallback for gateways without the parameter.

### C2. Live + visual verification pass
- **Why:** **The largest unverified claim in the repo now.** Model-picker search
  (C3), load-earlier (B1), the slash palette and the TLS sheet have all shipped
  without ever being seen running. Four UI features are covered only by unit tests
  on their pure helpers.
- **Fix:** Run the app against the live gate; exercise and screenshot each of the
  four. Fix what is broken. Record the pass in `AGENTS.md` as a release checklist
  item, the same way A4/08-17 did for smoke tests.

### C3. Settle-on-reconnect for interrupted streams, not just runs
- **Why:** C2/08-17 settles `unresolved` **runs** on reconnect. Interrupted
  **streams** are only reconciled against whatever history returns; if the gateway
  finished the turn after the disconnect, the bubble stays interrupted until the
  next manual reload.
- **Fix:** Re-poll the owning run for interrupted bubbles on reconnect and resolve
  them from the run result, reusing `settleUnresolvedRuns`'s shape.

---

## Execution order

1. **A1** — security hole, smallest diff, ship first.
2. **A2 → A3** — the two "dead thing" detectors; they retro-catch tonight's bugs.
3. **A4 → A5** — coverage ratchet, then spend it on the biggest untested module.
4. **B1 → B2 → B3** — the palette's remaining reach, then error polish.
5. **C1**, then **C2** as a dedicated session with the app actually running, then **C3**.

## Verification gates

After every item: `npm run verify` (tsc, lint, jest **with coverage floor**, gate
tests). No `Alert.alert`. No Skia in web files. `AGENTS.md` stays accurate — now
machine-checked by A2.

---

## Implementation status — 2026-08-19

Part A is complete; B1 landed with it. Gate after every item:
**54 jest suites / 416 tests**, **390 gate tests**, coverage ratchet holding,
`npm run verify` exit 0.

| Item | State | Notes |
|---|---|---|
| A1 TOFU changed-fingerprint hole | **done** | Failing case reproduced first, then fixed in `security.ts`; 4 quadrant tests added |
| A2 fail on dead config | **done** | `scripts/verify-config.mts`, run first by `verify` |
| A3 fail on dead context state | **done** | 5th check in the same script; **found 5 dead keys**, all removed |
| A4 coverage ratchet | **done** | `scripts/coverage-ratchet.mts` + git-tracked `coverage-baseline.json` |
| A5 cover `slash-commands.ts` | **done** | 19 registry tests; **found a duplicate `/plugins`** |
| B1 palette from the `/` strip | **done** | "Browse all commands" row + `initialQuery` seeding |
| B2 frequency-ranked recents | open | |
| B3 humanize remaining error sites | open | |
| C1 gateway history cursor | open | |
| C2 live + visual verification | open | still the largest unverified claim |
| C3 settle interrupted streams | open | |

### What the new detectors caught immediately

Both A2/A3 and A5 found real defects on their first run, which is the argument
for them:

- **5 dead context keys.** `sendMessage` (superseded by `sendChatInput`),
  `transcripts`, `liveCapabilities`, `completeOnboarding` (superseded by
  `setupFromPcAddress` completing inline) and `runningCommandLabel` were all
  exposed on `GatewayContextValue` and consumed by nothing. Removed. `runTask`
  is allow-listed with a written reason — the in-provider slash-command runner
  consumes it.
- **A shadowed command.** Two registry entries both claimed `id: 'plugins'` and
  `slash: '/plugins'` with different RPC methods. `.find` returns the first, so
  `plugins.list` ("Installed plugins") was permanently unreachable behind
  `plugins.uiDescriptors`. Split into `plugins-ui` / `/plugins ui`.

`transcripts` and `runningCommandLabel` remain as **write-only state** — the
setters are threaded through the command paths but nothing reads the values.
That is now commented at the declaration rather than left as a puzzle. A
transcript view is the obvious consumer if one is ever wanted; deleting the
recording would throw away the data it needs.

### A note on how A3 is implemented

It is a check in `verify-config.mts`, not a jest test. The check needs
`node:fs`, and `tsconfig.json` scopes `types` to `["jest"]`; adding `"node"`
would let application code reach for node APIs and still typecheck, which is a
bad trade in a React Native app for the sake of one test's convenience.

### C2 — partial: the sheet lab

The two sheets shipped this session (`SlashCommandPalette`,
`TlsFingerprintChangeSheet`) are no longer unverified. `/dev/preview` gained a
**Sheet Lab** section that opens both against real registry data with no gateway,
and both were exercised in the running app on Expo web:

- TLS sheet: gateway name interpolates, both fingerprints render in full (not
  truncated — a MITM only needs to match the first few characters to fool a
  skimming reader), both actions present.
- Palette: families group in priority order (CHAT before AGENT), search narrows
  correctly (`session` → the SESSIONS family including the space-delimited
  sub-commands), and the no-match empty state offers "Clear search".
- No React warnings or render errors in the console.

**Still open for C2:** the model-picker search (C3/08-17) and load-earlier
(B1/08-17) remain unverified — both live behind a connected gateway, and the
browser blocks that on web. Expo web cannot reach the gate because the gate
sends no `Access-Control-Allow-Origin`, and **adding permissive CORS to the gate
is the wrong fix** — it would let any web page in the user's browser talk to
their gateway. Verify those two on a native build, or behind a purpose-built
local mock that speaks the handshake.

The lab is the reusable part: any future sheet can be dropped into it and checked
without a gateway, which is the structural answer to "shipped without ever being
seen".
