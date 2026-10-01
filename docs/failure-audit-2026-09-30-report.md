# Failure audit 2026-09-30 - final report (round 1)

Branch `claude/app-failure-audit-fc957c` (21 commits on top of `master` @ `67306a9`; not pushed, not deployed).
Companion docs: [the list](failure-audit-2026-09-30.md) (where/what/why per finding, with a *Fix status* line) and
[the fix log](failure-audit-2026-09-30-fixes.md) (diagnosis and fix per finding).

## Result

60 findings from the first scan: **52 fixed, 1 partly fixed, 7 not fixed.** The seven are decisions or need you, not
overlooked defects:

| Finding | Why it was not changed |
|---|---|
| LIFE-7 TLS fingerprint guard is inert | Needs native certificate pinning or removing the claim from the UI - a product call |
| GATE-11 `/health` can't see a dead backend | Changes what "connected" means in the app - needs a contract decision |
| COV-1 coverage only measures `src/lib/gateway` | Widening it drops below the recorded baseline - needs a deliberate baseline reset |
| CFG-1 fallback hosts compiled into `app.json` | Low value; changes how builds are configured |
| DEAD-1 mDNS discovery code still on the connect path | Refactor, no failure to remove |
| ENV-1 main checkout's `node_modules` is incomplete | **Needs you:** `npm ci` there after restoring the npm cache dir `E:\Data\pkg-caches\npm`. Not touched because the live Gate runs from that checkout |
| VOICE-6 hands-free calls never open | Already tracked in `PENDING.md`; not caused by anything fixed here |
| (partly) STORE-2 one SecureStore item holds every gateway | The iOS-only 2 KB size risk is unchanged |

The headline fixes: a chat turn now survives the phone's socket dropping (Gate keeps it running, pushes on completion,
phone reconciles on return); foreground recovery no longer blanks the chat; a rejected token stops retrying and keeps
its message; a stalled stream is detected and the monitor is nudged; request bodies are bounded; one bad child
process can no longer take the whole Gate down; the Codex backend recovers after a crash; auth/pairing files are written
atomically; connect no longer starts every backend, skips duplicate fetches and paints cached data first; hang-up no
longer crashes the app on a Gate call (Kotlin) and the jitter buffer is thread-safe.

## How it was done

Free `opencode` models did the work so Claude's own usage stayed low: **space-bunny-free** wrote almost everything;
**longcat-2.5-preview-free** wrote the first Gate/transport packages and then stopped answering mid-run (its endpoint
returned nothing), so space-bunny covered the rest. A harness the authors could not edit ran, per package: typecheck,
ESLint, related jest or the Gate suite, `verify-config`, and a diff guard (no suppressions, no skipped/deleted tests,
no protected files, allowed files only). A *separate* model session then reviewed every package against the real code
path and re-ran the new tests against the pre-fix source. **12 reviews failed a package, each with a reproduced
defect** (for example: push-token pruning never worked; a stall that never threw; a keepalive that could corrupt a
streamed event; a foreground return that deleted the reply being streamed; cached data painting over fresh data), and
each was fixed and re-reviewed before landing. Claude read the diffs of the safety-critical ones and spot-checked
claims.

## Verification (on the integration branch)

`verify-config`, `tsc`, ESLint (0 errors), full jest with coverage (655+ suites / 6570+ tests) and the coverage ratchet
(baseline **rose** 85.45 -> 86.5 statements), and the Gate suite (1267+ tests) all pass. The new Kotlin tests pass in a
scratch Android tree (the 3 `GateFrameCodecTest` failures there are a fixture path that exists only in the real repo),
and the whole app compiles in a release build.

## Build

`C:\Projects\Versutus-apk-out\versutus-failure-audit-a9d7535-20261001-0234.apk` (154 MB, debug-signed release build, built from
`a9d7535`, which contains everything on `master` plus these fixes; no other branch has unmerged work).
SHA-256 `4A2600D09BE126265C180FA0221AF1E7104A383B57CC81987C38E85118385DED`. Not sent to the phone.

## What still needs a device

Everything marked `[device?]` in the list is reasoned from code; none of it has run on a phone. In this order:

1. **Background turn** - send a long reply, lock the phone for a minute, unlock: the reply should be there, and a push should have arrived.
2. **Blanked chat** - background the app for several minutes on cellular/Tailscale, return: the thread should still be on screen.
3. **Stream stall** - start a reply, flip Wi-Fi off: the composer should unlock within about a minute, not hang.
4. **Rejected token** - rotate the Gate token: the app should say so once and stop retrying.
5. **Hands-free call hang-up** (once calls open again) - no crash.

The Gate fixes are on the branch only. To use them the Gate must be restarted from a checkout that has them
(`ff-only` + service stop/start per `gate-process-ownership`); nothing was restarted.
