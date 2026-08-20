# Handoff — Phase 7 / §2.4: Hermes bots API (Tier 1, behind a Gate front)

For a fresh agent picking up the bots work in `C:\Projects\Versutus`.
Branch `master`, clean, `npm run verify` green (494 jest, 443 gate tests).
Several commits are **unpushed** — check `git status` before assuming.

## Read these first, do not re-derive them

- `docs/capability-gap-audit-2026-08-19.md` **§4** — the whole bots analysis:
  why `api_server.py` can reach every bot in-process, what Tier 1/2/3 cost, and
  why Tier 3 is rejected on principle. This handoff does not repeat it.
- `docs/gap-and-bug-audit-2026-08-19.md` **§2.4** — why it was left unranked.
- `docs/capability-implementation-plan-2026-08-19.md` — Phases 0–5 are done;
  Phase 7 is the last unstarted one. Its §0 table lists claims from an earlier
  revision that did **not** survive verification; treat that as a warning about
  how this plan was written, not just as history.

## The decision that gates this

Tier 1 needs `GET /api/bots` in **Hermes**, which is upstream Python — a fork to
maintain or a PR to land. Asking for this handoff implies that commitment, but
**confirm it with Ethan before writing any Python.** Nothing else here is
blocked by it (see the split below).

Tier 2 (runtime start/stop) is a separate decision and is **not** in scope.
Tier 3 (config CRUD) is rejected — see §4.

## Split the work; only one half is upstream

**(b) is buildable and fully testable today, without (a) existing.** That is the
pattern used four times this session.

**(a) Upstream, in Hermes:** `GET /api/bots` — enumerate `runner.adapters`,
report platform + connected state, join with `build_channel_directory(adapters)`.
~100–150 lines, near-zero risk. §4 has the exact accessor the cron handler
already uses.

**(b) In this repo, mirroring the skills/cron/diagnostics work in `69dd4f2`:**

1. `gate/core/cli-environments/backends/hermes.mjs` — add `listBots()`, a thin
   `call('/api/bots')` passthrough. `call()` already does auth, error mapping
   and JSON.
2. `gate/core/cli-environments/adapters/hermes.mjs:9` — add `'bots'` to the
   capabilities array. This is what makes `backendCan('bots')` true.
3. `gate/core/server.mjs` — **two edits, and the first is easy to miss:**
   - add `/v1/bots` to `isKnownAuthenticatedRoute` (~`:555-585`). That allowlist
     404s anything not on it, ~180 lines before the handlers. A route added only
     to the handler block is dead code. There is a drift test for exactly this
     in `gate/__tests__/backend-routes.test.mjs`.
   - add the handler beside the other fronted routes, resolving with
     `resolveBackendFor('listBots')` — **not** `resolveBackend`. The live Gate
     attaches claude/codex/hermes/opencode in that order, so resolving by
     position hands the request to `claude-local` and 501s while `hermes-local`
     sits there able to serve it. That bug shipped once already; see `b88c336`.
4. `gate/core/manifest.mjs` — advertise `endpoints.bots` gated on
   `backendCan('bots')`, and add the pair to `CAPABILITY_BACKING` in
   `gate/__tests__/manifest-capabilities-advertised.test.mjs`. That test fails
   loudly on any capability advertised without an endpoint behind it — it is the
   detector that caught `tools: true` being a lie.
5. `gate/core/capabilities/gateway-methods.mjs` — add `bots.list` so the slash
   command works. Advertised and dispatchable must not drift; `manifest.rpcMethods`
   is built from these tables.
6. `src/lib/gateway/dashboard.ts` — **a new capability group def.** `bots` is not
   among the current 21. Give it real `features`/`endpoints` match keys, or it
   joins the six groups that can never resolve (§2.2). Add commands with a
   `method` so the live dispatch filter can see them.

## Two things worth exploiting

- **`channels` may come free.** Tier 1 joins `build_channel_directory(adapters)`,
  and `channels` is one of the six groups that currently have no match keys and
  can never read ready (§2.2). If the bots payload carries the channel
  directory, `channels` can be given real keys in the same change.
- **Hermes under-reports itself.** It answers `/api/jobs` with 200 while
  reporting `jobs_admin: false`. The Gate therefore advertises from what it
  observably fronts, not from Hermes' self-report — do the same for bots even if
  upstream adds a capability flag. See §1c.

## How to verify — and the trap

`npm run verify` (config, tsc, lint incl. `gate/`, jest + ratchet, gate tests).

**Then verify on the device, not from Node.** This session's most expensive
lesson: streaming chat was broken on the phone the entire time every gate was
green, including a live pass I ran against the real Gate and real Hermes. All of
it ran in Node, where `fetch` exposes a readable body and React Native's does
not. See `docs/gap-and-bug-audit-2026-08-19.md` §0 and §2.1.

If bots work touches app code paths, assume Node tells you nothing about the
device until §2.1 (a dev screen probing the real environment) exists. Building
that first is cheap and would pay for itself here.

For live checks against the running Gate: it listens on 8760, Hermes on 8642,
both `0.0.0.0`. The bootstrap token is in `gate/.tokens.json`; do not print it.
Restart with `node gate/cli.mjs start` after Gate changes — the running process
does not hot-reload, and a stale one silently serves the old manifest.

## Repo conventions that are load-bearing

- Commit messages here explain *why*, at length, and name the failure the change
  prevents. Match that; the history is the design record.
- Do not cite a convention without checking it exists. Two claims in the earlier
  plan — a 422 precedent and a pass-rate convention in `AGENTS.md` — were
  fabricated and survived review. `AGENTS.md` is four lines about Expo docs.
- `AGENTS.md` requires reading the versioned Expo docs
  (https://docs.expo.dev/versions/v57.0.0/) before writing app code.

## Suggested skills for the next session

- `superpowers:brainstorming` — before designing the upstream endpoint shape, if
  Tier 1's payload is not already settled by §4.
- `diagnose` — if anything misbehaves; it forces a real feedback loop first,
  which is what caught the two false hypotheses in this session.
- `superpowers:verification-before-completion` — given §0, claims of "working"
  need evidence from the right environment.
- `superpowers:test-driven-development` — the Gate-front half has a clean seam
  and the existing route tests are a direct template.

## State of the other open gaps

- **§2.3 terminal RCE: decided — accepted as-is** (Ethan, this session). It ships
  enabled by default; any valid Gate token can open a shell on the host.
  Sessions are bound to the credential that opened them (`c0ca07f`), so a second
  token cannot type into someone else's. No further work planned.
- **§2.1 device verification loop** — open, unstarted, and the highest-value
  item in the repo. See above.
- **§2.2 capability denominator** — open, cosmetic; overlaps step 6 above.
