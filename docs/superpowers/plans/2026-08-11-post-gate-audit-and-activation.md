# Post-Gate Audit & Activation Plan

Date: 2026-08-11  
Branch: `master`  
Trigger: Gate phase complete; claim that “everything but simple chat is dead and UI is a mess.”  
Live evidence: Gate smoke green but Chat capability false-negative; Hermes hung mid-audit (listener death pattern from handoff §3.1).

---

## Verdict

The claim is **mostly fair for product feel**, overstated for raw capability:

| Area | Reality |
|---|---|
| Connect + streaming chat (Hermes) | Alive (previously live-verified) |
| Sessions / model picker (Hermes) | Wired and should work when Hermes listens |
| Shell terminal | **Dead on Hermes** (no endpoint; honest empty state) |
| Most slash / Tools RPC | **Guidance theater** (~23 mapped, ~45 guidance-only) |
| Activity / `/run` | Wired for Hermes, **not live-proven**, easy to miss |
| Tool-call cards | **Dead chrome** (UI only, stream never populates) |
| Gate / ManifestClient | Chat+models+health only; sessions/runs/RPC throw |
| UI | Design system exists; craft lags; surfaces advertise dead features |

Roadmap M1–M6 “completed” closed on compile/lint/unit, not full Hermes/Gate product truth.

Full inventories: dead-function findings D1–D18 and UI findings U01–U28 from the 2026-08-11 audit session (embedded summary below).

---

## Confirmed live bugs (this session)

1. **Gate capability false-negative** — manifest advertises `endpoints.chat` + `capabilities.chat`; snapshot looks for `chat_completions` → Chat pill **unsupported** while chat works.  
   Evidence: `npm run smoke:live -- http://127.0.0.1:8760` capability table.
2. **Hermes identify fragile** — `probeHermes` required `caps.runtime` object; real Hermes fixture has no `runtime`. Health already returns `platform: hermes-agent`.
3. **Hermes can go deaf** while process “running” — health/timeouts (WinError 64 class); client cannot heal a dead listener.
4. **Offline outbox unreachable** — provider queues when disconnected; composer sets `canSend` / `editable` only when `connected`.
5. **`/model set` on Hermes** hits `config.get`/`config.patch` (guidance-only); picker works via profile override.

---

## Implementation batches

### Batch A — Truth & unblock (done 2026-08-11)

1. ✅ Capability alias map: Gate `chat`/`models` → snapshot `ready`.
2. ✅ ManifestClient capability synthesis: emit Hermes-compatible endpoint/feature keys.
3. ✅ Hermes identify: trust `/health.platform` containing `hermes`; capabilities optional enrich.
4. ✅ `/model set` on Hermes: profile model override (same as picker); OpenClaw keeps config path.
5. ✅ Tools tab: default mode RPC when shell unsupported.
6. ✅ Capability grid: ready groups first; collapse unsupported behind “Show all”.
7. ✅ Composer: allow send/queue when a gateway profile exists (not only when connected).
8. ✅ Home empty troubleshooting: Hermes/Tailscale copy, not OpenClaw-only.
9. ✅ Hide “Retry connection” while connected.

**Exit met:** Gate `smoke:live` shows Chat **ready**; capability unit tests; `tsc`/`lint`/jest 72 green.

### Batch B — Non-chat surfaces that should work (Hermes) (done 2026-08-11)

1. ✅ Live-smoke surface checks (capability-gated): models, sessions, skills, toolsets, runs+stop.
2. ✅ Activity “Start a run” card; Chat overflow “Run task”; Home hint when runs ready.
3. ✅ Tools RPC filtered to executable; slash palette hides unavailable unless typed.
4. ✅ Activity empty states: unsupported vs offline vs none yet.
5. ✅ Notification tap → `/activity`.
6. ✅ Skills command group fixed so `/skills` is executable when advertised.
7. ✅ Hermes identify now returns kind Hermes (health.platform).

**Live evidence:** Gate smoke all pass (Chat ready, models list). Hermes smoke: models/skills/toolsets/runs green; `/api/sessions` can hang (WARN, non-fatal).

### Batch C — Dead chrome & honesty (done 2026-08-12)

1. ✅ Tool-call cards: history `extractToolCalls` + stream `onToolCall` for OpenAI tool_calls deltas.
2. ✅ Rename “Agent targets” → “Gateway targets” (Batch B).
3. ✅ Discovered row “pinned” → “fingerprint seen”.
4. ✅ Sheets no longer invent raw hex chrome (confirmation/approval use Button + tokens).

### Batch D — UI craft (partial 2026-08-12)

1. ✅ Unify `add.ios.tsx` → re-export shared add (identify/deep-link/TLS).
2. ✅ BaseSheet → Modal (shared + Android re-export); confirmation/approval token polish.
3. ✅ Home title/brand hierarchy; Retry already hidden when connected.
4. ✅ Chat: model/session chips only in header (composer cleaned).
5. ✅ Tools mode picker → SegmentedControl (iOS re-export shared).
6. ✅ Wire TextField `validationState` (base + iOS border); onboarding uses valid/invalid colors.
7. ✅ Delete unused `GatewayCard*` / `GatewayCardInner*` (no consumers).
8. ✅ Persist offline outbox + activity runs (`session-persistence.ts`); restore on bootstrap; cancel in-flight runs after restart.

### Batch E — Gate product depth (optional / later)

1. Local-only session UX when manifest has no sessions endpoint.
2. Provider child sync manual verify + UI for multi-provider Gate.
3. Optional manifest endpoint extensions if Gate grows runs/sessions.

---

## Dead-function summary (priority)

| ID | Item | Sev | Status |
|----|------|-----|--------|
| D1 | Shell terminal on Hermes | P0 | DEAD (honest) |
| D2 | Most slash/RPC commands | P0 | PARTIAL / guidance |
| D3 | `/model set` vs picker | P0 | BROKEN slash path |
| D4 | Runs + Activity | P0 | PARTIAL / unproven |
| D5 | Tool-call cards | P1 | DEAD |
| D6 | ManifestClient beyond chat | P0 Gate | PARTIAL |
| D7 | Chat stop server-side | P1 | PARTIAL |
| D8 | Agents surface | P1 | Honest stub |
| D9 | iOS add gateway | P1 | Divergent / broken |
| D11 | Capability wall noise | P2 | PARTIAL |
| D15 | Approval notification route | P2 | Wrong target |
| — | Gate chat capability alias | P0 | **BUG** (live) |
| — | Hermes probe `runtime` | P0 | **BUG** |
| — | Offline composer gate | P0 | **BUG** |

---

## UI mess summary (priority)

| ID | Issue | Sev |
|----|-------|-----|
| U05 | Composer blocks offline outbox | High |
| U10 | iOS add fork | Blocker iOS |
| U03–U04 | Sheet chrome / non-Modal BaseSheet | High |
| U07/U21 | Empty home hierarchy | High |
| U09 | Always-on Retry; cramped actions | Med |
| U06 | Duplicate model/session chips | Med |
| U23 | Capability pill soup | Med |
| U25 | Tools shell-first on Hermes | Med |

---

## Standing validation

```bash
npx tsc --noEmit
npm run lint
npm test -- --coverage=false
npm run smoke:portal
npm run smoke:live -- http://127.0.0.1:8642   # Hermes (restart if deaf)
npm run smoke:live -- http://127.0.0.1:8760   # Gate
```

If Hermes probes hang: check listener (`netstat` / `hermes gateway restart`) before blaming the app — see `docs/2026-08-11-session-handoff.md` §3.1.
