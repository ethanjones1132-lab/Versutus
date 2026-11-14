# App finish-line campaign

## Request and constraints

Ethan: "This was intended for astra, but I want to conserve some usage. Take it and own it bud" — execute `docs/prompts/astra-app-finish-line.md` from the original checkout. He subsequently connected the Android phone by USB and authorized its use.

Goals: a substantial daily-use improvement in smoothness, Nocturne visual coherence, onboarding without configuration-file edits, correct Unicode, and truthful Activity/Routines. Preserve lamp identity, gateway/Bot/session isolation, credentials, approvals, durable queued intent, private Gate ownership, and existing installations. Voice engine/native media internals belong to a separate campaign. Local commits/build/install tests are authorized; publication/account/signing decisions remain Ethan's.

## Starting point and ownership

- Source: `6c899d7`, isolated branch `codex/app-finish-line`, checkout `.worktrees/app-finish-line`. Main checkout has untracked `docs/prompts/`; leave it intact. Other active RH worktrees cover wrong-route connection errors and voice mute. Do not write/build in their checkouts.
- Device: USB A54 `SM-A546U1`, Android 16, serial recorded only in local evidence. Installed `com.versutus.app` version 1.0.0/code 1, updated November 12. Pulled APK SHA-256 `c67b984fd5e9d431349460ca4c95259a75f08bdc7f3b01a3b4ed3fbb01c1e640` matches `output/versutus-master-4e82510-arm64-2026-11-12.apk`.
- Live Gate: Node `C:/Projects/Versutus/gate/cli.mjs start --host 0.0.0.0 --port 8760 --allow-plaintext`; preserve topology and credentials. Default state directory `%LOCALAPPDATA%/Versutus/Gate`; confirm runtime metadata without copying secrets. The installed phone currently reports its saved gateway offline.
- Driver owns diagnosis, integration, device interaction, performance, text boundary audit, final review/build. Bounded Luna read-only investigations cover onboarding and Activity/Routines; implementers receive disjoint files only after findings are checked.
- Read Expo SDK 57 index November 14; read relevant versioned API pages before changes. Read `AGENTS.md`, `CONTEXT.md`, `FUTURE-ITEMS.md`, voice/design language, ambient spec/motion companion, Activity proposal, relevant ADRs, perf/release runbooks.

## Ranked slices and acceptance

1. **Reproduce / baseline.** Capture installed APK identity, screenshots, runtime connectivity, baseline A54 frame/memory evidence. Distinguish old installed APK from starting source. Confirm Unicode by UTF-8/code points. Record causes before edits.
2. **Usable onboarding.** Trace native discovery, pairing and manual entry. Guide supported host setup and explicit address fallback truthfully; preserve entered values. Tests: failed address/auth/pairing/readiness, retry, first response/restart. No magical cross-network discovery or host config mutation contrary to ADRs.
3. **Activity/Routines.** Recover November 9 semantics, remove superseded clutter while preserving live approvals/runs; fix stale/error state, backend ownership, timezone and persistence where demonstrated. Tests: own-session navigation, partial/failed reads, routine CRUD/toggle/reopen, unsupported backends. Verify one real execution where available; use isolated short schedules.
4. **Clean text.** Fix demonstrated corrupted source strings and actual byte-decoding boundaries; guard recurrence. Tests: punctuation/emoji/non-Latin, split multibyte chunks, malformed input, user-visible string scan. Do not claim persisted text recovery without implementation.
5. **Smooth coherent native experience.** Profile stage and actual roster/chat/keyboard/scroll/stream/drawer/Activity flows on the A54. Fix measured contributors. Preserve lamp, AA/readability, reduced motion, background/offscreen suspension. Existing budget: >=95% frames <=16 ms, p95 <16.7 ms, zero >=34 ms frames; report failures honestly. Capture visual/device comparison and interaction limits.
6. **Integrate / review / package.** Verify focused behavior during each slice; independently review consequential diff once. Run final `npm run verify`, `smoke:portal`, applicable live/visual checks. Build local arm64 APK from integrated source only; inspect signing and hash. Install/run packaged core journeys; retain separate clean-onboarding install if needed. Keep reviewable local commits and concise release/evidence notes. No public release.

For each slice: reproduce → focused regression fails → implementation → focused regression passes → runtime comparison → local commit. User authorized autonomous implementation, so use established design and settle routine choices without a fresh approval gate. Consequential unresolved product semantics go to Ethan while independent work continues.

## Evidence and current findings

- Installed screenshot and pulled APK: original checkout `temp/finish-line/` (local, may contain private content; do not commit blindly).
- Baseline frame data: `docs/perf/finishline-installed-2026-11-14-idle.json`, raw under `docs/perf/raw/finishline-installed-2026-11-14/` in this checkout. Baseline failed existing budget; inspect counts before choosing a fix.
- Native `LampCanvas` currently gates its frame callback/sensor on route focus and reduced motion only; background lifecycle needs verification.
- `scanner.ts` native discovery hard-disable reproduced by read-only worker; verify UI claim and supported alternatives before implementation.

### First integrated slices (in progress)

- Explicit installed-roster baseline: `docs/perf/finishline-installed-roster-2026-11-14-idle.json`: 838/863/856 frames in each 10-second run, p95 36/34/36 ms, 0% <=16 ms, 206/116/137 >=34 ms frames. The first `finishline-installed` capture did not save a contemporaneous route proof; use the explicitly verified roster run for comparison. Stage/Figure source is unchanged between installed `4e82510` and starting `6c899d7`.
- Perfetto roster capture (local original checkout `temp/finish-line/installed-roster.pftrace` and `installed-roster-analysis.txt`): ~667 animation slices/10 s, 6,766 ms inclusive animation time, 7,462 ms UI CPU, 6,391 ms RenderThread CPU. 468 update batches carry 95 property instructions. This directs work toward idle per-figure animation, not a speculative shader rewrite. Keep the lamp unchanged.
- Live Gate `/v1/routines` returned four rows whose `schedule` values are objects; the strict app feed expects strings. Local installed Hermes source proves parsed cron/interval/once shapes and `include_disabled` filtering. Pause writes `enabled:false`; old `listJobs` excluded it. Gate fixes normalize schedules with original raw records retained, request disabled jobs, and enumerate independent Hermes Bot homes.
- New feed scope separates routine display owner from storage home: `scopeBotId:null` for a root listing, named scope for `/p/<bot>`. Equal IDs in different homes remain distinct. Failed Bot homes retain healthy rows with partial coverage; one shared read deadline bounds the whole roster. Long-lived sessions omit lifetime totals from Today and report their actual last activity instant.
- Existing Hermes HTTP API supports editing name/schedule/prompt. New Gate PATCH `/v1/jobs/{id}` is guarded by `routines:manage`, routes to the exact backend/Bot, forwards only valid editable fields, and is advertised as `endpoints.jobUpdate` only for the Hermes adapter. Host API does not accept timezone at its create/update doors; do not offer invented timezone controls.
- Focused Gate checks passed: 169 feed/schedule/Hermes tests; 261 backend-route/scope/manifest/Hermes tests; targeted ESLint and Gate diff whitespace check. Full integrated verify/build/device proof still pending.

## Remaining work / resumption

All slices active/investigating; nothing claimed finished. Re-read this file at slice boundaries and update with concrete outcomes, commands/results, commits, artifacts, and remaining physical-device gaps. Keep this one file compact; details belong in focused evidence files.
