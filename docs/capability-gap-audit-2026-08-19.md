# Capability Gap Audit — 2026-08-19

Findings from diagnosing the phone against the live Gate (8760) and Hermes
0.20.3 (8642). Everything here was reproduced against running services, not
read off release notes.

---

## 1. Capability spread: 8 of 21

Computed against the live Gate manifest, using the app's own
`CAPABILITY_GROUP_DEFS` matching rules.

**Ready (8):** `chat`, `agent`, `sessions`, `approvals`, `models`, `tools`,
`providers`, `environments`

**Missing (13):** `skills`, `diagnostics`, `terminal`, `config`, `cron`,
`memory`, `voice`, `channels`, `plugins`, `logs`, `devices`, `artifacts`,
`nodes`

It was **6** at the start of this session. Fronting Hermes' runs API added
`agent` and `approvals`.

### The 13, classified by what it would actually take

| Class | Groups | Reality |
|---|---|---|
| **Reachable now by fronting Hermes** | `skills`, `diagnostics`, `cron` | Endpoints verified 200. Small adapter work. |
| **Explicitly disabled in Hermes** | `config`, `memory`, `voice` | Feature flags are `false` by design. Not a wiring gap. |
| **Host-only, no API anywhere** | `channels`, `plugins`, `logs`, `devices` | Needs upstream Hermes work. |
| **Exists nowhere** | `terminal`, `artifacts`, `nodes` | Would have to be built. |

Verified live:

```
/v1/skills       -> 200   (skills_api: true)
/v1/toolsets     -> 200
/health/detailed -> 200
/api/jobs        -> 200
```

So **3 of the 13 are cheap wins** — Hermes already serves them and the Gate
simply does not front them yet.

### Finding: Hermes under-reports itself

`/api/jobs` answers **200** with full CRUD plus `pause`/`resume`/`run`, but
`/v1/capabilities` reports `jobs_admin: false`. The app keys off the flag, so it
would never offer cron on a gateway that demonstrably supports it.

This is the same defect class we spent the session fixing locally — a capability
flag that disagrees with the running service — except this one is upstream.

### Finding: 6 of the 21 are gated behind an unused mechanism

`artifacts`, `nodes`, `channels`, `plugins`, `logs` and `devices` declare **no
`features` and no `endpoints`** in `CAPABILITY_GROUP_DEFS`. `groupIsAdvertised`
only inspects those two, so none of them can ever be satisfied by a manifest.

Their only route to "ready" is `instanceFamilies.has(definition.id)` — a
capability *instance* registered in the Gate's capability registry with a
matching family. The live Gate registers exactly **one** instance (`models`).

So roughly a quarter of the denominator is aspirational: those groups are not
"missing" so much as *not yet defined*. A "21 capabilities" figure should be
read with that in mind.

---

## 2. Terminal is dead on arrival — root cause

The app opens a terminal against:

```
${httpBase}/better-gateway/terminal/stream        (src/lib/terminal/client.ts:78)
```

`/better-gateway/…` is an **OpenClaw** path. Verified:

```
Gate   /better-gateway/terminal/stream -> 404
Hermes /better-gateway/terminal/stream -> 404
```

Neither gateway you run serves it, and neither advertises a `terminal`
capability, so the Shell tab can never connect.

Compounding it: the Gate ships `gate/core/cli-environments/conpty.mjs` exporting
`createConptyFallback`, and **nothing calls it** — orphaned code. The Gate has
the makings of a terminal and serves no terminal route.

Fixing this is not a wiring change; it is building a terminal endpoint on the
Gate (ConPTY session, streaming transport, auth) and pointing the client at it.

## 3. The sister tabs

**Gateway RPC tab** shows six buttons: `health`, `status`, `sessions`, `models`,
`skills`, `tools`. All six are `transport: 'rpc'`, i.e. Hermes-dialect methods.
Against a Gate they cannot route — that is the `Unknown method "tools.list"`
error. The dialect filter added this session stops the husk errors, but the
honest result on a Gate is now an **empty tab**.

The real fix is to stop routing these through Hermes RPC and map them onto the
Gate's REST surface, which already serves the same information:

| Button | Currently | Available on the Gate |
|---|---|---|
| `sessions` | `sessions.list` RPC | `GET /v1/sessions` |
| `models` | `models.list` RPC | `GET /v1/models` |
| `health` | `health` RPC | `GET /health` |
| `tools` | `tools.list` RPC | via backend `toolsets` |
| `skills` | `skills` RPC | Hermes `/v1/skills` (not fronted) |

**Agent tab** is nearly empty by construction: of 51 registry commands, **49 are
`rpc` and only 2 are `agent`**. The tab is not broken; there is almost nothing
in it.

---

## 4. What a Hermes bots API would take

Investigated because bots are the headline feature wanted in Versutus. Cheaper
than expected — the plumbing already exists.

### The decisive fact

`api_server.py` is itself a `BasePlatformAdapter` in `gateway/platforms/`,
**running in the same process as every bot**. No IPC, no new daemon.

It already reaches them. This is existing production code in the cron handler:

```python
runner = self.gateway_runner or request.app.get("gateway_runner")
if runner is None:
    from gateway.run import _gateway_runner_ref
    runner = _gateway_runner_ref()
adapters = getattr(runner, "adapters", None)
```

`runner.adapters` is `Dict[Platform, BasePlatformAdapter]`.

### Per-bot lifecycle already exists

`connect(is_reconnect: bool)` and `disconnect()` are `@abstractmethod` on
*every* adapter. The reconnect watcher already cycles individual adapters at
runtime:

```python
success = await self._connect_adapter_with_timeout(adapter, platform, is_reconnect=True)
if success:
    self.adapters[platform] = adapter
```

Start/stop of one bot without restarting Hermes is an **exercised path**, not a
new capability. There is also `build_channel_directory(adapters)` — a ready-made
per-platform read model — and `/api/jobs/*` with `pause`/`resume`/`run` as a
management-API precedent in the same server.

### Effort, in tiers

**Tier 1 — read (`GET /api/bots`).** Enumerate `runner.adapters`, report
platform and connected state, join with the channel directory. ~100–150 lines,
no new concepts, near-zero risk. Enough for a bot *visibility* surface.

**Tier 2 — runtime control (start/stop/restart).** Primitives exist, but
`connect()` alone is insufficient: the reconnect path re-wires ~6 things
afterwards (auth check, platform event handler, voice callbacks, busy-text mode,
topic recovery). The honest version extracts a reusable `restart_adapter()` on
the runner rather than duplicating that list — inside a **30,708-line
`run.py`**. Needs a per-platform lock, since the reconnect watcher may be
mid-cycle on the same adapter.

**Tier 3 — config CRUD (add/remove bots, credentials).** Recommend against, and
not on effort grounds:

- Hermes advertises `admin_config_rw: false` — a deliberate stance that config
  mutation is not remote. Persistent enable/disable means writing `config.yaml`
  and crosses it.
- Adding a bot means entering platform tokens. Credential entry over a phone API
  is the wrong shape regardless of who builds it.

### The catch

Tier 2 control **does not persist** — stop a bot at runtime and it returns on
next Hermes restart. "Disable this bot" via Tier 2 really means "until next
restart", which is either fine or surprising depending on what the UI promises.

And all of it is **upstream work in a third-party Python codebase** — a fork to
maintain, or PRs to land. That is a different commitment from everything else in
this session, and the strongest argument for the Gate: it is yours to change.

---

## 5. Carried-forward gaps from this session

- **Streaming chat through Hermes.** Its `/chat/stream` is a POST that both
  sends and streams, which does not fit the Gate's subscribe-then-send shape.
  Chat works; token-by-token needs adapter work.
- **Abort on session turns.** Left throwing rather than faked — Hermes exposes
  stop only on runs. A no-op abort would report a cancellation that never
  happened while tokens kept burning.
- **Bots.** Section 4.

## 6. Suggested order, if resumed

1. **`skills` + `diagnostics` + `cron` via Hermes** — three capability groups,
   endpoints already verified 200, same adapter pattern as runs. Cheapest
   remaining capability gain.
2. **Re-point the RPC tab at Gate REST** — turns an empty tab into a working
   one without new gateway surface.
3. **Streaming chat** — the most visible quality gap in daily use.
4. **Terminal** — real build (ConPTY endpoint + transport + auth), not wiring.
5. **Bots Tier 1** — only if the upstream-fork commitment is acceptable.

Deliberately unranked: `config`, `memory`, `voice` are off by Hermes' own
choice, and `artifacts`/`nodes` are undefined rather than missing.
