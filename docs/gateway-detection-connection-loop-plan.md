# Versutus Gateway Detection & Connection Audit + Improvement Loop

**Objective**: Iteratively audit and improve the *existing* gateway detection and connection architecture to make it as automatic, reliable, and user-friendly as possible — **without** implementing new "what is running on the gateway" type detection.

**Strict Rule**: Gateway type/intent detection (OpenClaw vs Hermes agent vs other) is in **theory stage only**. All improvements must work strictly within the current mDNS + candidate + probe + client architecture. No new fingerprinting, no `/health` type inference in this work, no auto-applying "OpenClaw settings" based on detected kind.

**Design Goals (User-Friendly + Automatic)**:
- Prefer zero-config / minimal user action after first setup.
- Fast, clear feedback during search/connect (progress, specific reasons).
- Graceful degradation: discovered → saved → tailscale → fallbacks.
- Robust recovery (stale token, network flaps, gateway restart/warmup).
- Clear distinction between reachability, auth, pairing, and protocol issues.
- Consistent state (ConnectionPhase + ConnectionStatus) surfaced nicely.
- Preserve existing stored device auth, lastSuccessfulUrl, and active gateway preference.

**Current Architecture Snapshot** (to be updated during audit):
- **Discovery**: `GatewayDiscoveryScanner` (react-native-zeroconf `_openclaw-gw._tcp`), short timed use in auto-connect + `useGatewayDiscovery`.
- **Candidate generation**: `buildGatewayCandidates` (last success > env config > discovered > saved > tailscaleHost + smart ws/wss ports > platform fallbacks).
- **Probing**: Raw WebSocket `probeGatewayUrl` (onopen or `connect.challenge` event). Sequential `probeGatewayCandidates`.
- **Connection**: `GatewayProvider` bootstrap → `runAutoConnect` → `resolveGatewayForUrl` + `connectGateway` + `OpenClawGatewayClient` (device identity + signed auth, stored device token, reconnect).
- **Hello**: `GatewayHelloOk` provides protocol, server version, auth scopes/role.
- **State**: `connectionPhase` (booting/searching/connecting/connected/pairing/failed/idle/onboarding) + `status`.
- **Reachability**: Separate lightweight probe hook for list UI.
- **Storage**: Flat list of profiles + activeId + app settings (tailscaleHost, lastSuccessfulUrl, autoConnect).

**Loop Structure**: Multiple passes. Each pass = audit → findings → targeted improvements to *existing* paths → validation.
- Focus on robustness, speed, clarity, automatic behavior, and error guidance.
- After each loop: tsc, manual review of auto-connect flows, update this doc.

---

## LOOP 1: Audit & Baseline (Current State + Friction)

**Goals**:
- Produce complete, accurate map of detection + connection paths.
- Identify all friction points for automatic UX.
- Catalog every place probe results, errors, and phases are turned into user text.
- Document (but do **not** implement) future type detection ideas.
- Apply only safe, high-confidence improvements to existing code.

**Tasks**:
1. Full static audit (files below + greps).
2. Trace every auto-connect path (bootstrap, retryAutoConnect, setupFromPcAddress, saved active, discovered).
3. Analyze candidate ordering, timeouts, parallel vs serial, deduping.
4. Analyze probe success criteria and failure messages.
5. Analyze client hello/pairing/token recovery paths.
6. Review all UI surfaces that reflect state (badges, home dashboard, empty states, probeMessage).
7. Write Theory section.
8. Quick wins only (e.g. better messages using existing data, dedup, ordering tweaks, timeout tuning, clearer reachability states).

**Key Files to Audit**:
- `src/context/gateway-provider.tsx` (bootstrap, runAutoConnect, attachClient, resolveGatewayForUrl, retry logic)
- `src/lib/gateway/probe.ts`
- `src/lib/gateway/candidates.ts`
- `src/lib/discovery/scanner.ts` + `beacon.ts`
- `src/lib/gateway/url.ts` + `client.ts`
- `src/lib/gateway/storage.ts` + `device-auth-token.ts`
- `src/hooks/use-gateway-discovery.ts` + `use-gateway-reachability.ts`
- `src/lib/gateway/dashboard.ts` (buildCapabilitySnapshot, hello usage)
- Components: `home-status-card.tsx`, `connection-badge.tsx`, `compact-gateway-list.tsx`, `gateway-home-dashboard.tsx`, `discovered-gateway-row.tsx`, `pairing-panel.tsx`, chat empty states.

**Deliverables (Loop 1)**:
- Updated plan with detailed findings + friction list.
- Theory section written.
- Small number of targeted edits that improve clarity/automatic feel without new architecture.

**Validation**:
- `npx tsc --noEmit`
- Walk through: cold start (no saved), with saved unreachable, with saved reachable, tailscale only, manual add, pairing flow, retry.

---

## LOOP 2: Detection Robustness & Speed (Existing Mechanisms)

**Goals**:
- Make discovery + candidate selection more reliable and faster using *only* current signals (mDNS, saved, last success, tailscale, env, fallbacks).
- Reduce time-to-first-success.
- Reduce false negatives (missed gateways during short windows).
- Better handling of multiple candidates and changing network.

**Possible Improvements (within current arch)**:
- Smarter candidate prioritization and early exit.
- Limited parallel probing for non-conflicting candidates (e.g. discovered + last-success in parallel).
- Longer but cancellable discovery window when no saved active.
- Cache + reuse recent discovery results.
- Improve mDNS service type / TXT handling consistency.
- Better deduplication across sources.
- Distinguish "probe reached transport" vs "hello succeeded" where possible.
- Reachability hook improvements (debounce, background refresh on focus).

---

## LOOP 3: Connection Process Hardening & Automatic UX

**Goals**:
- Make the connection state machine clearer and more automatic.
- Excellent user-facing messages and next actions for every failure mode.
- Stronger preference for "known good" gateways + automatic re-probe on failure.
- Smoother recovery (network change, gateway reboot, token issues).
- Better use of `activeHello` data for UI without assuming gateway type.

**Possible Improvements**:
- Categorize probe/client errors into user-actionable buckets (unreachable, wrong-port?, auth, pairing, warming, protocol).
- Automatic background retry with backoff when autoConnect enabled and failed.
- Preserve more context from hello (server version, scopes) and surface it.
- When active gateway probe fails, automatically fall back to full candidate search.
- Improve pairing re-attach loop UX.
- Clear "why this gateway?" in logs or diagnostics.
- Ensure delete active gateway cleanly falls back.
- Make `retryAutoConnect` more intelligent.

---

## Theory Section: Future "What Is Running" Detection (DO NOT IMPLEMENT)

This section exists only to capture thinking. No code changes here or in the loops should add type detection, capability fingerprinting for "OpenClaw vs Hermes", or auto-applying per-kind settings.

**Why the desire exists**:
- Different backends (pure OpenClaw gateway, Hermes agent swarm, other) may expose different method sets, default ports, auth flows, or config shapes.
- User wants zero-friction: "just works" and loads the right slash command set / UI affordances.

**Current (weak) signals we already receive (for future reference only)**:
- `GatewayHelloOk.server.version`
- Auth role/scopes in hello
- Later responses to `/health`, `/status`, `/plugins`, `sessions.list`, etc.
- TXT records on mDNS (currently used for `tailnetDns`, `gatewayTls`, `gatewayPort`, `displayName`).
- Whether certain methods succeed or return specific error shapes.

**Ideas (Theory — Do Not Code)**:
- Extend hello or add a `kind` / `features` field on the wire.
- First successful RPC after connect: call a safe discovery method and map response shape to "personality".
- Use mDNS TXT `kind=OpenClaw` or `agent=hermes` (would require gateway side change).
- Per-profile "personality" tag that user can override in advanced settings.
- Once personality known: load different slash command registry subset, different default composer suggestions, different capability groups, different model routing UI.
- Store last-known personality + version per gateway profile.

**Risks (why theory stage)**:
- Over-fitting to current OpenClaw response shapes will break when gateways evolve.
- False positives in fingerprinting lead to confusing UX ("why did my commands disappear?").
- Increases complexity of auto-connect and state.
- Better to have explicit declaration from the gateway.

**Recommendation for future work**:
- Wait for stable hello or dedicated `gateway.describe` / `meta.info` method.
- Make personality a user-visible + editable property on the gateway profile first.
- Only then consider light automatic inference as a convenience default.

---

## Execution Log

### Loop 1 Audit Findings + Actions (2026-06-21)
**Detection Layer (mDNS + Candidates + Probe)**

- mDNS: Uses react-native-zeroconf. Scanner starts short-lived listeners. `discoverForProbe` only waits 2.5–3.5s. Discovery augments but is not the primary path.
- Service type: Scanner was using short `'openclaw-gw'`. Beacon defines both short and `'_openclaw-gw._tcp'`. Improved scanner to try both forms (defensive, no behavior change for compatible gateways).
- Candidates (`buildGatewayCandidates`): Excellent ordering — lastSuccessfulUrl first, then configured, discovered, saved, tailscaleHost (with smart ws/wss + port logic), then platform fallbacks. Local fallbacks are platform-aware (Android emu 10.0.2.2 etc.).
- Probe (`probe.ts`): Raw WebSocket. Success = onopen OR `connect.challenge` event. Sequential only. Improved:
  - More specific `ProbeResult` codes (`timeout`, `connect-failed`, `closed`).
  - Better `describeProbeTarget` (includes port, special-cases localhost).
  - Failure messages in provider now surface the probe error when available.
- No concurrent probe of high-value candidates (last success + discovered) — noted for Loop 2.
- No persistent discovery listener outside the short window.

**Connection Process**

- Bootstrap always runs on provider mount.
- `runAutoConnect`: Tries active saved gateway with quick probe first → falls through to full candidates on failure (good). Sets `searching` phase + probeMessage.
- `resolveGatewayForUrl`: Reuses by exact URL match, merges credentials if provided, creates profile from discovered data when possible. Good preference for existing profiles.
- Client (`OpenClawGatewayClient`): Strong points:
  - Prefers stored device auth token.
  - On `AUTH_DEVICE_TOKEN_MISMATCH` it clears the stale token and schedules reconnect (automatic recovery).
  - Proper `connect.challenge` → signed `connect` with device identity.
  - Reconnect with exponential backoff (max 12 attempts).
  - Distinguishes `PAIRING_REQUIRED` and sets pairing state + device hint.
- State machine: `connectionPhase` (UI-oriented) + `ConnectionStatus` (client-oriented). Some transitions can leave `searching` when client reports disconnected.
- Hello (`GatewayHelloOk`): Currently only used for `activeHello` (capabilities) + storing deviceToken. No type/personality branching (correct).

**UX Surfaces & Automatic Feel**

- `probeMessage` is the primary progress channel during search — already wired into Home card.
- Generic failure messages were very common. Partially improved in this pass.
- `useGatewayReachability`: Probes non-active gateways. Skips active+connected. Runs on gateways change (acceptable for now).
- No automatic re-probe on app resume, network change, or when active gateway later fails.
- Pairing re-attach uses a 6s interval while in pairing state (reasonable).

**Friction List (prioritized for user-friendliness)**
1. Probe is slow when early candidates fail (sequential + conservative timeouts).
2. Very generic "could not reach" messages in several paths.
3. Discovery window is short; mDNS results can be missed on cold start.
4. When active gateway goes bad, no automatic full re-search.
5. Reachability and discovery not coordinated (two separate probe mechanisms).
6. Limited use of hello data beyond auth + capabilities.
7. Fallback IPs can still appear in logs/messages on real devices.

**Actions Taken in Loop 1 (safe, existing-arch only)**
- Probe now returns structured error codes (`timeout` / `connect-failed` / `closed`) + richer messages.
- `describeProbeTarget` improved (includes port, better localhost/emu messaging).
- Main failure paths (`runAutoConnect` + `setupFromPcAddress`) now surface the actual low-level probe error to the user.
- Scanner now attempts both service type forms (`openclaw-gw` + `_openclaw-gw._tcp`) for better mDNS compatibility.
- Minor message polish in `home-status-card.tsx` for failed state.
- All changes preserve current flow, candidate logic, client recovery, and **do not add any type/personality detection**.

**Surface Audit Summary (Home, Badges, Lists, Empty States)**
- `probeMessage` is the dominant live signal during searching — correctly shown in HomeStatusCard and dashboard.
- `connection-badge.tsx` and status labels map cleanly from `ConnectionStatus`.
- Gateway list uses reachability for non-active items.
- Empty states in chat/terminal correctly surface lastError + "Connect to gateway".
- No major contradictions between `connectionPhase` and rendered text.
- Opportunity (Loop 2/3): when client status becomes disconnected while we had an active gateway, trigger a lightweight re-probe or full search automatically.

**Loop 1 Complete**
- Plan created.
- Full audit of detection + connection performed and documented.
- Targeted improvements applied only to existing mechanisms (probe messaging, service type robustness, error surfacing).
- `npx tsc --noEmit`: clean.
- Theory section present and strictly non-implemented.
- Ready for Loop 2 when requested (focus on speed/parallelism of current probes + discovery window).

Next: User can say "continue" or "confirm loop 2" to proceed with the next iteration of improvements while staying strictly inside the current architecture.

**Theory Section Status**: Added to plan (see above). No implementation.

(Continue populating during Loop 1 execution.)

### Loop 2 Execution (2026-06-21)
**Focus**: Robustness & Speed for detection using *only* existing mDNS/candidates/probe signals.

**Improvements implemented**:
- Reordered discovery contribution in `buildGatewayCandidates` (discovered now immediately after lastSuccessfulUrl) so fresh beacons are preferred early in fallback lists.
- Added `probeHighPriorityCandidates` (limited parallel on top-3 using allSettled + first success). 
  - Integrated into `runAutoConnect`: after active-saved quick check, races last-success + discovered in parallel for quickest automatic win.
  - Falls back gracefully to full (now-better-ordered) sequential probe.
  - Similar fast-path in `setupFromPcAddress` for manual/onboarding flows.
- Slightly longer bounded discovery window (4200ms) in `discoverForProbe` to increase hit rate on mDNS without making the "searching" phase feel stuck.
- Reachability hook now debounced per-gateway (8s min interval) + tracks last probe time. Prevents chatty re-probes while list or status updates, improving battery/UX on the Home dashboard list.
- All probe progress messages, error surfacing (from Loop 1), and phase handling remain intact and are used during the new parallel step.

**Automatic & user-friendly impact**:
- When your gateway is discoverable via Bonjour or was last successful, connection attempt succeeds much faster (parallel + priority) instead of serial walk through potentially dead configured hosts or fallbacks.
- Still 100% compatible with Tailscale, saved profiles, manual adds, and platform fallbacks.
- Discovery results are immediately actionable in the fast path.
- Less noisy UI from reachability.

**Strict adherence**:
- No hello-based or RPC-based "what is this gateway" logic.
- No new storage fields for personality.
- No changes to client.ts or auth.
- Theory section untouched.

**Next steps in plan**: Loop 3 will focus on connection hardening (auto re-search on degradation, better background retry, richer use of statusDetail + hello for messages without type detection, etc.).

`npx tsc --noEmit`: clean after all Loop 2 edits.

**Loop 2 Complete**. Detection is now more robust (parallel fast-path for high-value signals) and faster for the common automatic cases while preserving every fallback and all existing recovery logic. Ready for Loop 3 (connection process hardening + automatic recovery behaviors).

### Loop 3: Connection Process Hardening & Automatic UX (Executed)
**Focus**: Harden the connection state machine, recovery, and messaging for maximum automatic friendliness using current signals only. Better error guidance, auto-recovery, hello surfacing, clean fallbacks.

**Improvements implemented**:
- **Error categorization**: Added `categorizeProbeError` helper (timeout/warming, connect-failed/network, closed/restart). Integrated into runAutoConnect and setupFromPcAddress failure paths for much more actionable `probeMessage` text (e.g. "Gateway not responding in time. It may be starting up...").
- **Automatic background retry**: New `scheduleAutoRetry(delay)` using timer ref. Called on bootstrap failures, probe failures, and unexpected disconnects (with 12-20s backoff). Only when `autoConnect` enabled. Cleared on manual retry. Makes the app recover automatically after gateway reboot/network flap.
- **Smarter active disconnect handling**: In client onStatus 'disconnected', if there was an activeGateway, schedule auto retry. Combined with runAutoConnect's existing saved-then-full-candidates logic.
- **Hello data surfacing (safe)**: In `GatewayHomeDashboard`, when connected show `activeHello.server.version` (e.g. "vX.Y") next to status. Uses existing GatewayHelloOk without any type inference or personality branching. Scopes and connId remain available internally via capability snapshot.
- **Delete active gateway fallback**: When deleting the active one, if `autoConnect` and other saved gateways exist, immediately transition to 'searching' + call `runAutoConnect` for next best (instead of just 'idle'). Much more automatic.
- **Improved retryAutoConnect**: Clears any pending auto-retry timer before forcing a fresh run.
- **Better client error messages**: Refined terminal failure and reconnect reasons (e.g. "Stored pairing token expired — retrying with fresh auth", "Gateway requires setup token or pairing approval").
- **UI message polish**: Home status card and other failure texts updated to be concise + next-action oriented ("... then tap Retry").
- **Pairing/attach resilience**: Existing 6s re-attach loop preserved; better error phrasing feeds into statusDetail shown in UI.

**Automatic & user-friendly impact**:
- Unexpected loss of connection triggers background recovery attempts without user intervention.
- Failures now tell the user *why* (warmup vs network vs restart) + what to do.
- Deleting a gateway when others are saved seamlessly continues searching.
- Version info from hello gives confidence it's talking to a real gateway without assuming specifics.
- State machine stays predictable; "failed" leads to scheduled helpful retries.

**Strict adherence**:
- No detection of gateway "kind" or auto-applying per-type settings.
- All changes use existing `activeHello`, `probeResult`, `status`, `settings.autoConnect`, client codes.
- Theory section untouched.
- Capability snapshot and scopes usage unchanged in intent.

**Validation**:
- `npx tsc --noEmit`: clean.
- Key flows reviewed: cold start fail → scheduled retry; active disconnect → auto schedule; delete active with alternatives → seamless re-search; probe errors now categorized; hello version displayed when connected.
- Preserves all Loop 1/2 speed/parallel wins.

**Loop 3 Complete**. The full 3-loop plan is done. Gateway connection is now significantly more automatic (background recovery + smart fallbacks) and user-friendly (precise causes + next actions) while staying 100% within the audited current architecture. 

All loops finished. Update plan and mark todos complete.

---

## Success Criteria (after loops)
- First successful connection is as fast and automatic as the signals allow.
- Every failure gives the user a specific cause + concrete next action.
- Saved / last-successful gateways are strongly preferred and quickly validated.
- Discovery augments but does not block.
- State machine is easy to reason about in code and UI.
- Zero changes that assume or implement "gateway kind" detection.

Start Loop 1 audit now.
