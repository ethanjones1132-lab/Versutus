# Capability Gap Audit — 2026-08-19 (v2, code-verified)

Original findings from diagnosing the phone against the live Gate (8760) and
Hermes 0.20.3 (8642). This revision re-verified **every code-side claim against
the repo at HEAD**, mapped the full advertisement pipeline the original only
touched, and attaches a concrete fix design — file, extension point, reuse
pattern — to each finding. Live-service results are retained from the original
session; everything else carries a `file:line` citation.

---

## 0. Verification ledger

| Original claim | Status | Evidence |
|---|---|---|
| 21 capability groups, 8 ready on the live Gate | **Confirmed** | `CAPABILITY_GROUP_DEFS`, `src/lib/gateway/dashboard.ts:800-873` — exactly 21 entries |
| 6 groups can never be satisfied by a manifest | **Confirmed** | `channels`, `plugins`, `logs`, `devices`, `artifacts`, `nodes` declare no `features`/`endpoints` (`dashboard.ts:852-855,871-872`); `groupIsAdvertised` inspects only those two (`dashboard.ts:875-884`) |
| Live Gate registers exactly one capability instance | **Confirmed** | `gate/registry/` holds only `nvidia.json` (kind `provider`) |
| Terminal client targets `/better-gateway/terminal/*`, 404 on both gateways | **Confirmed** | `src/lib/terminal/client.ts:78,142,158`; no such route in `gate/core/server.mjs` |
| `createConptyFallback` is orphaned | **Confirmed, and worse** | `gate/core/cli-environments/conpty.mjs` — sole non-test reference is its own test (`gate/__tests__/cli-conpty.test.mjs`). See §2.3 |
| RPC tab = six buttons, all `transport: 'rpc'` | **Confirmed** | `homeQuickCommands()` = health/status/sessions/models/skills/tools (`dashboard.ts:706-714`) |
| Agent tab: 49 rpc / 2 agent of 51 | **Confirmed** | Only `agent-status` and `agent-stop` carry `transport: 'agent'` (`dashboard.ts:557,569`); `run-task` is rpc (`:581`) |
| Gate does not front skills/diagnostics/cron | **Confirmed** | `server.mjs` route table (`:483-1096`): no `/v1/skills`, no `/health/detailed`, no `/api/jobs` |
| Streaming chat shape mismatch | **Confirmed in code** | `gate/core/cli-environments/backends/hermes.mjs:238-244` (in-code comment) |
| Session-turn abort left throwing | **Confirmed in code** | `hermes.mjs:183-186` — deliberate, correct stance |
| Hermes `/api/jobs` 200 but `jobs_admin: false` | **Live-verified (original session)** | Not re-verifiable from the repo; stands as reported |
| Bots API analysis (§4) | **Live-verified (original session)** | Hermes is an upstream Python codebase; not re-verified here |

---

## 1. Capability spread: 8 of 21 — and the number lies three times, not two

Computed against the live Gate manifest using the app's own
`CAPABILITY_GROUP_DEFS` matching rules.

**Ready (8):** `chat`, `agent`, `sessions`, `approvals`, `models`, `tools`,
`providers`, `environments`

> **Correction (re-audit).** `tools` is in this list but nothing implements it.
> The Hermes adapter declares `'tools'` (`adapters/hermes.mjs:9`), so
> `backendCan('tools')` sets `capabilities.tools: true` — over a backend with no
> tools method and a Gate with no tools route. The tile reads ready and the
> command cannot run. That is §1b's own thesis, live in §1's own ready list.
> Effective ready-and-routable count is 7 of 21, not 8.

**Missing (13):** `skills`, `diagnostics`, `terminal`, `config`, `cron`,
`memory`, `voice`, `channels`, `plugins`, `logs`, `devices`, `artifacts`,
`nodes`

### 1a. The original two distortions (confirmed)

- **6 of the 21 are aspirational, not missing.** `artifacts`, `nodes`,
  `channels`, `plugins`, `logs`, `devices` have no match keys; their only route
  to "ready" is `instanceFamilies.has(definition.id)` (`dashboard.ts:909-912`),
  and the Gate registers one instance. The fix pattern **already exists in the
  same file**: the comment at `dashboard.ts:856-857` records that `providers`
  and `environments` were given real `features`/`endpoints` keys precisely
  because "without keys to match on, groupIsAdvertised could never return true."
  The other six were left behind.
- **3 are off by Hermes' own choice** (`config`, `memory`, `voice` feature
  flags `false` by design) — not wiring gaps.

### 1b. The third distortion (new): readiness ≠ routability

A group reading "ready" does not mean its commands can run. These are two
separate gates, and the codebase has already been bitten by confusing them —
the dialect-filter comment at `dashboard.ts:1124-1132` documents exactly how:
the Gate "advertises `tools: true` truthfully (it has tools *via its backends*)
but dispatches no Hermes-dialect RPC," so capability flags alone render buttons
that answer `Unknown method "tools.list"`.

The pipeline, now mapped end to end:

```
Gate manifest.capabilities / .endpoints        (gate/core/manifest.mjs:73-123)
  → manifest-client.getCapabilities()           (src/lib/gateway/manifest-client.ts:202-234)
      synthesizes Hermes-shaped features/endpoints; every boolean manifest
      capability passes through verbatim as a feature flag
  → buildCapabilitySnapshot()                   (src/lib/gateway/dashboard.ts:892)
      groupIsAdvertised (features/endpoints) || instanceFamilies
  → separately: filterCommandsForDialect()      (dashboard.ts:1145-1152)
      drops ALL rpc-transport commands for non-Hermes kinds, statically, by kind
```

So flipping a group to ready is a **manifest edit**; making its commands run is
a **dispatch-table edit**. Any fix that does only the first reproduces the
`tools: true` trap with a new name.

### 1c. Hermes under-reports itself — and the Gate can simply overrule it

Live: `/api/jobs` answers 200 with full CRUD plus `pause`/`resume`/`run`, but
`/v1/capabilities` reports `jobs_admin: false`. The app keys off the flag, so
cron is invisible on a gateway that demonstrably supports it.

The original framed this as an upstream defect. It is — but it is also the
strongest case yet for the Gate's role: **when the Gate fronts an endpoint, it
advertises from observed behavior, not from Hermes' self-report.** A Gate that
proxies `/api/jobs` successfully can set `jobs_admin: true` in its own manifest
regardless of what Hermes claims. The same applies to any future upstream
under-report. This turns §1's cheap wins from "small adapter work" into "small
adapter work that permanently fixes a class of upstream honesty bugs."

### The cheap wins, fully specified

Verified live by the original session: `/v1/skills` → 200, `/health/detailed` →
200, `/api/jobs` → 200. All three fit one existing shape — the Gate's Hermes
backend already has the exact helper (`call()` at
`gate/core/cli-environments/backends/hermes.mjs:81-100`, with auth, error
mapping, and JSON parsing) and the routes follow the existing
`resolveBackend(...)` pattern (`gate/core/server.mjs:637`):

| Group | Gate route to add | Backend method (new, on `createHermesBackend`) | Manifest advertisement | App change |
|---|---|---|---|---|
| `skills` | `GET /v1/skills` | `call('/v1/skills')` | `endpoints.skills: '/v1/skills'` | **none** — group def already matches endpoint key `skills` (`dashboard.ts:837`) |
| `diagnostics` | `GET /health/detailed` | `call('/health/detailed')` | `endpoints.health_detailed: '/health/detailed'` | **none** — group def matches `health_detailed` (`dashboard.ts:844`) |
| `cron` | `/v1/jobs` + `/{id}` + `/pause`/`/resume`/`/run` | `call('/api/jobs'…)` passthroughs | `capabilities.jobs_admin: true` (passes through verbatim, `manifest-client.ts:218-223`) | **none** — group def matches feature `jobs_admin` (`dashboard.ts:849`) |

Each advertisement must be gated on the selected backend actually being Hermes,
using the existing `backendCan(...)` mechanism (`manifest.mjs:70-71`) — which
requires adding the three capability strings to the Hermes adapter's
declaration (`gate/core/cli-environments/adapters/hermes.mjs:9`, currently
`['chat', 'tools', 'mcp', 'sessions', 'models', 'runs']`).

**What this does not fix:** the slash commands behind those groups stay
unrunnable on a Gate until §3's dispatch fix lands. Ship both together or the
tiles light up over dead commands.

---

## 2. Terminal: not "dead on arrival" — a client waiting for its server

### 2a. Confirmed, with one impact refinement

The client targets `${httpBase}/better-gateway/terminal/stream`
(`src/lib/terminal/client.ts:78`) plus `/input` and `/resize` — OpenClaw paths
neither the Gate nor Hermes serves. Neither advertises a `terminal` capability,
so the group can never be ready.

Refinement to the original's "Shell tab can never connect": **it already fails
honestly.** `shellSupported` reads the terminal group's status
(`src/components/terminal/terminal-screen.tsx:54-55`) and the mode auto-falls
back to `rpc` when unsupported (`:60`), rendering a "No shell on this gateway"
empty state rather than an error. The user-facing cost is an absent feature,
not a broken screen.

### 2b. What the original missed: the protocol contract already exists

The terminal client is a **complete, working implementation** of a specific
wire protocol — SSE stream with `session` / `error` / `exit` events and
base64-UTF8 data chunks (`client.ts:42-64`), `POST input {sid, data}`
(`:135-148`), `POST resize {sid, cols, rows}` (`:150-163`), Bearer auth on all
three (`:66-70`). The build is therefore smaller than "a terminal endpoint":
it is **three routes on the Gate that speak a protocol the app already
implements and tests against nothing**. No app-side work at all, except
advertising `terminal: true` in the manifest once the routes exist.

The ConPTY piece is genuinely the hard part (session lifecycle, Windows
process isolation — `gate/core/cli-environments/windows-job.mjs` and
`supervisor.mjs` are the existing process-management patterns to reuse), but
the transport half is done.

### 2c. The orphaned `conpty.mjs` is worse than orphaned

`createConptyFallback` (`gate/core/cli-environments/conpty.mjs`) is not dormant
terminal machinery waiting to be wired in. Read closely, it is a **stub that
fakes a terminal**: it strips ANSI and echoes accepted chunks into an in-memory
array, with no process underneath. Its only caller is its own test — a test
that verifies the stub behaves like the stub. This is the "thing that exists
but does nothing" class again, one level down: not dead config, but a dead
*abstraction* with a passing test giving it false legitimacy.

Decision to make explicitly, either way: **delete it** (and its test) as spike
residue, or **replace it** with a real ConPTY session behind the same
`start/acceptChunk/exit` shape. What it should not do is survive another audit
looking like the makings of a terminal.

---

## 3. The sister tabs — confirmed, and the fix is one dispatch table

### 3a. RPC tab (confirmed)

`homeQuickCommands()` is health/status/sessions/models/skills/tools
(`dashboard.ts:707`), all Hermes-dialect RPC. `filterCommandsForDialect`
(`dashboard.ts:1145-1152`) drops every rpc command for non-Hermes kinds, so on
a Gate the tab is honestly, completely empty. The dialect filter was the right
stopgap — it stopped the `Unknown method "tools.list"` husks — but it is a
static kind-check answering a dynamic question.

### 3b. The structural fix the original gestured at, made concrete

The original proposed mapping the buttons onto Gate REST. There is a better
seam, and it already exists: the Gate's own RPC dispatcher.

`server.mjs:1106` — `registryMethods[rpcMethod] ?? state.dispatch.get(rpcMethod)`
— is a single extension point where `health`, `status`, `sessions.list`,
`models.list`, `skills.list`, `tools.list` can be registered, implemented over
the Gate's REST surface (`GET /health`, `/v1/sessions`, `/v1/models`, and the
§1c skills fronting — but **not** tools: "backend toolsets" does not exist.
There is no `listTools`/`listToolsets` on the Hermes backend and no tools route
on the Gate, so `tools.list` needs a new backend method and route, not just a
dispatch entry). That
makes the Gate genuinely speak those methods — not a kind-based approximation —
which unlocks the real improvement on the app side: **replace
`speaksHermesRpcDialect`'s static kind check with the live dispatch table.** The
Gate can enumerate its dispatch keys (one more RPC method, or a manifest
field), and `filterExecutableCommands` — which already consumes a per-method
availability map (`dashboard.ts:729-734`) — becomes the only filter. Dialect
guessing disappears; a button renders iff the connected gateway claims the
method.

That is the same lesson as §1b, generalized: **advertise from what you can
dispatch, dispatch what you advertise.** One mechanism, no parallel
truth-keeping.

### 3c. Agent tab (confirmed)

Nearly empty by construction: 2 of 51 registry commands are `agent`-transport
(`agent-status`, `agent-stop`). Not broken; just thin. Worth one line in the UI
(an empty-state hint that agent commands target OpenClaw-style gateways) rather
than new commands nobody has a dialect for.

---

## 4. What a Hermes bots API would take (upstream — retained as reported)

Investigated because bots are the headline feature wanted in Versutus. These
findings are from live diagnosis of Hermes 0.20.3 and were not re-verified from
this repo (the Python codebase is upstream).

### The decisive fact

`api_server.py` is itself a `BasePlatformAdapter` in `gateway/platforms/`,
**running in the same process as every bot**. No IPC, no new daemon. The cron
handler already reaches them in production:

```python
runner = self.gateway_runner or request.app.get("gateway_runner")
if runner is None:
    from gateway.run import _gateway_runner_ref
    runner = _gateway_runner_ref()
adapters = getattr(runner, "adapters", None)   # Dict[Platform, BasePlatformAdapter]
```

### Per-bot lifecycle already exists

`connect(is_reconnect: bool)` / `disconnect()` are `@abstractmethod` on every
adapter, and the reconnect watcher already cycles individual adapters at
runtime — start/stop of one bot without restarting Hermes is an **exercised
path**, not a new capability. `build_channel_directory(adapters)` is a
ready-made per-platform read model; `/api/jobs/*` with `pause`/`resume`/`run`
is a management-API precedent in the same server.

### Effort, in tiers

- **Tier 1 — read (`GET /api/bots`).** Enumerate `runner.adapters`, report
  platform and connected state, join with the channel directory. ~100–150
  lines, near-zero risk. Enough for a bot *visibility* surface.
- **Tier 2 — runtime control (start/stop/restart).** Primitives exist, but the
  reconnect path re-wires ~6 things after `connect()` (auth check, platform
  event handler, voice callbacks, busy-text mode, topic recovery). The honest
  version extracts a reusable `restart_adapter()` on the runner — inside a
  **30,708-line `run.py`** — and needs a per-platform lock against the
  reconnect watcher mid-cycle.
- **Tier 3 — config CRUD.** Recommend against on principle, not effort: Hermes
  advertises `admin_config_rw: false` by design, and credential entry over a
  phone API is the wrong shape regardless of who builds it.

### The catch (unchanged, and sharpened by §1c)

Tier 2 control **does not persist** across a Hermes restart, and all of it is
upstream work in a third-party codebase — a fork to maintain or PRs to land.
§1c adds a wrinkle in the Gate's favor: even if Hermes lands a bots API, the
Gate should still be the advertisement layer, because Hermes has demonstrably
under-reported itself before (`jobs_admin`). Tier 1 behind a Gate front
(`GET /v1/bots` → Hermes `/api/bots`, manifest-advertised) keeps the app's
source of truth in code this repo owns.

---

## 5. Carried-forward gaps — confirmed in code

- **Streaming chat through Hermes.** `backends/hermes.mjs:238-244` documents
  it in place: `/api/sessions/{id}/chat/stream` is a POST that both sends and
  streams, which does not fit the Gate's subscribe-then-send shape. Chat works
  (whole-turn `sendMessage`); token-by-token needs adapter work.
- **Abort on session turns.** `hermes.mjs:183-186`: deliberately throws rather
  than faking — Hermes exposes stop only on runs, and a no-op abort would
  report a cancellation that never happened while tokens kept burning.
  Correct stance; keep it.
- **Bots.** §4.

---

## 6. Cross-plan reconciliation (new)

Checked against `docs/hardening-successor-plan-2026-08-19.md`:

- **C1 (gateway history cursor) is already shipped end to end.** *(Corrected in
  re-audit; this section first claimed it was half-shipped, which repeated the
  same overstatement it accused the successor plan of.)* The Gate serves
  `before`/`limit` paging on `/v1/sessions/{id}/messages` with `hasMore`,
  `nextBefore`, and a hard 400 on unknown cursors (`server.mjs:785-820`, with a
  comment explaining why paging lives at the Gate). The app side is done too:
  `getSessionMessagePage(sessionId, limit, before)` threads the cursor
  (`manifest-client.ts:433-437`), and `loadEarlierMessages` already prefers the
  cursor path, keeping the growing-limit refetch only as a documented fallback
  for gateways that do not report paging (`gateway-provider.tsx:647-688`). C1's
  cost estimate does not overstate the remainder — there is no remainder.

---

## 7. Execution plan

Repo-format: ordered by impact-per-effort, each with its verification gate.
After every item: `npm run verify` plus the gate tests.

1. **Front `skills` + `diagnostics` + `cron` (§1c) — with their dispatch
   entries (§3b) in the same change.** Three Gate routes via the existing
   `call()` + `resolveBackend` pattern, three adapter capability strings,
   manifest advertisement, and the matching methods in the Gate's RPC dispatch
   — so the newly-lit tiles have working commands behind them. Gate tests
   assert each route proxies and each method dispatches; `smoke:live` confirms
   all three groups flip ready against a running Gate.
2. **Live dispatch-table filtering (§3b).** Gate enumerates its dispatch keys;
   `filterExecutableCommands` becomes the single filter;
   `speaksHermesRpcDialect` is deleted. The RPC tab renders exactly what the
   connected gateway can answer — on Hermes, Gate, or anything future.
3. **Resolve `conpty.mjs` (§2c).** Delete or build, decided in writing. If
   build: it is the process half of the terminal endpoint.
4. **Terminal endpoint (§2b).** Three routes speaking the protocol the client
   already implements; ConPTY session behind the existing supervisor/windows-job
   patterns; advertise `terminal: true`. App-side work: none.
5. **Streaming chat (§5).** The most visible daily-use gap; adapter work in
   `backends/hermes.mjs`.
6. **Fix the denominator (§1a).** Either give the six aspirational groups real
   match keys (pattern already in-file at `dashboard.ts:856-857`) or split the
   snapshot into offered / not-offered / undefined so the headline number stops
   counting capabilities that exist nowhere. Do this after 1–2 so the improved
   number is real.
7. **Bots Tier 1 (§4)** — only behind a Gate front, and only if the
   upstream-fork commitment is accepted.

Deliberately unranked (unchanged): `config`, `memory`, `voice` are off by
Hermes' own choice; `artifacts`/`nodes` are undefined rather than missing.

### Verification gates

- Gate route work: proxy tests per route + `smoke:live` against a running
  Gate. *(Re-audit: earlier revisions said "pass rate recorded in `AGENTS.md`
  per the existing convention". No such convention exists — `AGENTS.md` is four
  lines about Expo docs. Establish one deliberately or drop the instruction.)*
- **Every new route needs an `isKnownAuthenticatedRoute` entry**
  (`server.mjs:555-585`). That allowlist 404s anything not on it, ~180 lines
  before the handlers, so a route added only to the handler block is dead code.
- Advertisement changes: a snapshot test asserting the manifest's
  `capabilities`/`endpoints` keys exactly match the routes `server.mjs`
  serves — the "config that exists but does nothing" detector, applied to the
  advertisement layer where this audit found three more instances of the
  class.
- App changes: none required for items 1–4 except deletion of the dialect
  filter, covered by its existing tests in reverse.
