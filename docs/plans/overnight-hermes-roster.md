# Hermes roster "JSON parse error from HTML" — investigation draft and plan

Status: **draft for human review. Source-only investigation. Nothing reproduced.**
Worktree: `C:\rh-wt\20261101-0050-versutus-vs-overnight-20261101-ha`, HEAD `b026c05`
("VS-OVERNIGHT-20261101 activity_diagnosis: Investigate OpenCode Activity from source and draft
independent plan"); parent `b258652` (markdown step).
Author: unattended Ralph iteration (`roster_diagnosis`), one pass, no device, no live Gate, no
credentials, no network call.

Labels used throughout:

- **[SOURCE]** — read in this worktree at the cited `file:line`; a statement about code, not about a
  running system.
- **[INFERENCE]** — a conclusion drawn from two or more [SOURCE] facts. Still not a measurement.
- **[HYPOTHESIS]** — plausible cause; needs the stated measurement to become fact.
- **[UNVERIFIED]** — a claim from the report, or something this tree cannot confirm.
- **[NOT RUN]** — a check a human must run; I did not run it and claim no result.

> This document deliberately does **not** say the reported failure was reproduced. It does **not**
> report a live HTTP status, a captured body, a Gate version, a device, or a log line. The Ralph
> check for this step is `grep -q Evidence docs/plans/overnight-hermes-roster.md`; it proves the word
> "Evidence" appears, nothing more. A human must read the diff and run the full `npm run verify`
> before any merge.

---

## 1. The request as received

> "Hermes roster reportedly shows JSON parse error from HTML while connected. Trace app roster
> through Gate and Hermes HTTP layers, status/content-type/error handling and metadata-write
> deadlines, identify possible HTML sources as hypotheses, and plan safe live verification."

Three parts of the request need disambiguation before any code changes, because the wording points at
three different seams:

1. **"Hermes roster"** is a *screen name* in this app, not a wire endpoint. The app has **no** Hermes
   roster read at all (Section 3.1), so the failing read is almost certainly the Gate's `/v1/bots`.
2. **"JSON parse error"** is JavaScript engine wording. Something in this repo calls `JSON.parse` on
   text that turned out to be HTML. The only roster-relevant `JSON.parse` without a guard is in the
   Gate's **OpenCode** backend (Section 3.4), not in the Hermes path.
3. **"from HTML"** narrows the HTML sources to (a) an OpenCode 2.x server's SPA catch-all (or an
   intermediary in front of one), (b) an intermediary in front of the Gate, or (c) the app
   mis-reading a 200 HTML body as an empty roster. Only (a) can produce the reported sentence through
   Gate-origin code (Section 3.2, H1).

So the report is best read as: *the roster surface failed while the connection stayed green, and the
text shown was a JSON parse error whose input was an HTML page*. The backend that actually failed may
well be OpenCode, with Hermes merely the environment the operator thinks of as "my roster".

---

## 2. What "the roster" is in this tree

**[SOURCE]**

- One app-side read: `ManifestClient.listBots()` (`src/lib/gateway/manifest-client.ts:826-831`).
  `HermesGatewayClient` has **no** `listBots` at all — `src/lib/gateway/client.ts` contains no
  occurrence of `listBots` (grep in this worktree), and `PortalClient.listBots` is optional
  (`src/lib/portal/adapters.ts:127-128`).
- One provider seam: `gateway-provider.listBots` returns `[]` when the live client has no roster
  method (`src/context/gateway-provider.tsx:6664-6672`). A direct Hermes connection therefore reads as
  "zero Bots", not as "this connection cannot inventory Bots".
- One Gate route: `GET /v1/bots` (`gate/core/server.mjs:3584-3613`).
- Two backend implementations of `listBots`:
  - Hermes: filesystem walk of `profiles/` (`gate/core/cli-environments/backends/hermes.mjs:584-594`
    → `hermes-profiles.mjs:204-221`);
  - OpenCode: HTTP `GET /agent` (`gate/core/cli-environments/backends/opencode.mjs:1208-1211`,
    `:1504-1507`).
- One manifest advertisement: `bots` is advertised iff some backend lists the `bots` capability
  (`gate/core/manifest.mjs:133`; Hermes capabilities include `bots`,
  `gate/core/cli-environments/adapters/hermes.mjs:93`; OpenCode includes `bots`,
  `adapters/opencode.mjs:9`).

**[INFERENCE]** A roster failure with a JS parse message cannot originate in the Hermes profile walk:
that path never parses JSON (Section 3.3). It must involve the Gate route plus a Bot-capable
environment that speaks HTTP — today that is OpenCode — or a non-Gate intermediary.

---

## Evidence

Every line reference below was opened in this worktree during this iteration. No request was made to
any Gate, Hermes, OpenCode server, proxy, or device.

### 3.1 App read path: one GET, no scope, no content-type check

**[SOURCE]**

- `ManifestClient.listBots()` reads the manifest's `bots` endpoint and nothing else:
  `const result = await this.rootTransport.request<{ data?: PublicBot[] } | PublicBot[]>('GET', path)`
  then `Array.isArray(result) ? result : result.data ?? []` (`manifest-client.ts:826-831`).
  It deliberately does **not** use `withBot`/`withBackend`/`withBotOnly`
  (`manifest-client.ts:644-698`); the app never sends `?backendId=` or `?bot=` on this read. That is
  pinned by `__tests__/manifest-client-test.ts:968-972` ("bots stay Gate-level") and
  `:1084-1098`.
- The transport sends `Content-Type: application/json` and `Authorization`, but **no `Accept`**
  (`src/lib/gateway/http-transport.ts:123-130`, used at `:158-163`). A server or proxy is therefore
  under no content-negotiation obligation to answer JSON.
- `request<T>` parses the body and, when parsing fails, **returns the raw text cast to `T`**
  (`http-transport.ts:176-181`). There is no `response.headers.get('content-type')` check anywhere in
  `request`.
- On a non-2xx it builds `GatewayHttpError(messageFromHttpErrorBody(text, status), status, code)`
  (`http-transport.ts:167-174`, class at `src/lib/gateway/errors.ts:19-28`). The whole request —
  including the body read — is bounded by `DEFAULT_TIMEOUT_MS = 30000`
  (`http-transport.ts:6`, `:152-157`), and an elapsed timer becomes
  `Request timed out: GET /v1/bots` (`:189-192`).
- Retry behaviour: a lookup failure may try an advertised IPv4, but any HTTP answer is final for that
  attempt (`src/lib/gateway/host-lookup.ts:154-166`). A 502 roster read is not retried by the
  transport.
- The read is cached on success only and keyed by gateway:
  `readCached('roster', gatewayId, 'bots')` / `writeCached(...)` (`chat-screen.tsx:1885-1907`,
  `:1933`, `:2423`; store validation at `src/lib/cache/swr-store.ts:135-166`).

**The app's view of the wire, by body:**

| Status / body | App result | Where |
|---|---|---|
| 200 `[...]` | rows | `manifest-client.ts:830` |
| 200 `{object:'list',data:[...]}` | rows | same |
| 200 `{data:[]}` | believed empty (zero-bots) | same |
| 200 `<!doctype html>…` | **`[]` — believed empty**, then cached over the good copy | `http-transport.ts:176-181` → `manifest-client.ts:830` → `chat-screen.tsx:1933` |
| 4xx/5xx `{"error":{"message","code"}}` | `GatewayHttpError`; roster caption is `message` | `http-transport.ts:167-174`; `http-error-body.ts:1-19` |
| 4xx/5xx `<!doctype html>…` | `GatewayHttpError` whose **message is the raw HTML** | `http-error-body.ts:1-19` (fallback returns `errorText` verbatim) |
| timeout | `Request timed out: GET /v1/bots` | `http-transport.ts:189-192` |

This table is the whole content-type story on the client: two distinct dishonesty modes exist
(silent empty roster on 200 HTML; raw markup in the caption on non-2xx HTML), before any Gate code is
considered.

### 3.2 Gate route: two paths, one dead error variable

**[SOURCE]**

- The JSON content type is set for **every** Gate response at the top of the handler
  (`res.setHeader('Content-Type', 'application/json')`, `gate/core/server.mjs:2406`), before routing.
  The roster success path `res.writeHead(200); res.end(JSON.stringify(roster))`
  (`:3591-3592`, `:3600-3601`) inherits it. **A Gate-origin roster body is JSON by construction.**
- Unpinned request → `mergedBotRoster()` (`:2981-3012`, called at `:3588-3594`):
  - loops every backend that can serve `listBots` (`:2984-2985`);
  - `backendManager.get(...)` failures and `backend.listBots()` failures are assigned to
    `firstError` (`:2983`, `:2986`, `:2993`);
  - **`firstError` is never read.** `grep firstError gate/core/server.mjs` shows only the declaration
    and the two assignments. With one environment listed the answer is that environment's own roster
    (`:2999`); with zero listed the function returns `null` (`:3000`); with two or more the failed
    environment is silently absent from the merged rows (`:3003-3011`).
  - zero listed → the route falls through to the single-backend path (`:3595-3597`), which may now
    resolve a *different* environment and report *its* error.
- Single-backend path (`:3596-3611`): `resolveBackendFor('listBots')` (`:3033-3075`), then
  `backend.listBots()`. On throw it answers the upstream status when it is 4xx/5xx, else **502**, with
  `{ error: { message: error.message, code: error.code ?? 'bot_read_failed' } }` (`:3602-3611`).
  The message is passed through **unfiltered**.
- The scope is deliberately not appended on this route unless the caller asks
  (`:3588`), and the app never asks (Section 3.1).
- A throw that escapes the route is **not** handled by the roster envelope above: the request
  handler's last-defence catch answers **500** with a different shape,
  `{ error: 'Internal Server Error', message }` (`server.mjs:4841-4846`). The app's
  `messageFromHttpErrorBody` would still read `message` (`http-error-body.ts:5-7`), but the status
  becomes 500 instead of the upstream status/502, and `errorCodeFromHttpBody` finds no
  `error.code` (`http-error-body.ts:22-30`), so the named code is lost. Any fix that makes an error
  reach the route must keep writing the `{ error: { message, code } }` envelope.
- Existing regression coverage pins the single-backend envelope exactly — status mapping, JSON
  content type, message, code, and retry-ability — at
  `gate/__tests__/backend-routes.test.mjs:1295-1334`. **There is no test for `mergedBotRoster`'s
  multi-environment path or for `firstError`**, in this file or elsewhere: the other `/v1/bots`
  matches under `gate/__tests__/` are POST/PATCH scope checks (`scope-enforcement.test.mjs:103-122`,
  `:428-446`) and comments, not a GET with two Bot-capable environments.

**[INFERENCE]** With two or more Bot-capable environments, a broken one costs its rows silently and
the screen looks like an honest, smaller roster. With exactly one (or with all of them failing on the
first pass), the failure is loud: 502 + the backend's raw message. The loud path is the one that can
put a JSON parse error on screen.

### 3.3 Hermes backend: filesystem only, failure folds into apparent facts

**[SOURCE]**

- `listBots` reads every profile's `.env`, `profile.yaml`, `config.yaml` and maps the records through
  `toPublicBot` (`gate/core/cli-environments/backends/hermes.mjs:584-594`;
  `hermes-profiles.mjs:190-202`, `:204-221`, `:166-180`). **No HTTP, no JSON.parse.**
- `readText` returns `''` on **any** read failure (`hermes-profiles.mjs:182-188`). `describeRouting`
  then reports `listen_key_missing` for a record with no listen key
  (`hermes-profiles.mjs:151-160`), so a transiently unreadable `.env` renders as "No listen key" on a
  Bot whose key is fine.
- A failed `readdir` of `profiles/` is swallowed and the roster is the `default` Bot alone
  (`hermes-profiles.mjs:208-221`). One unreadable directory reads as "this host has one Bot".
- `getHermesBot` is the one-Bot read and is careful about id casing/directories
  (`hermes-profiles.mjs:300-321`), but it shares the same `readText` swallow.
- The roster read is **not** tied to a metadata write: `description` is parsed from `profile.yaml` at
  read time (`hermes-profiles.mjs:65-79`), so a write that has not landed yet simply shows the old
  text until the next read.

**[INFERENCE]** Hermes can produce a *wrong* roster (missing rows, false "No listen key"), but it
cannot produce "JSON parse error" or any HTML body. If the operator's Gate has only a Hermes
environment, H1 must be false; H2 (an intermediary) and H3/H4 still need checking.

### 3.4 OpenCode backend: the one unguarded `JSON.parse`, and the v2 HTML catch-all

**[SOURCE]**

- `listBots` → `readAgents()` → `call('/agent')` (`gate/core/cli-environments/backends/opencode.mjs:
  1504-1507`, `:1208-1211`). **There is no `major` argument and no v2 branch on this route**
  (`grep "api/agent"` over `gate/` returns nothing; `/agent` appears once, at `:1209`).
- `call(path, …, major = 1)` (`:848-900`) does:
  - non-2xx: read text, try `JSON.parse` to extract a message, keep the raw text on failure, and throw
    with the upstream `status` (`:871-882`);
  - 204/205 or blank body: return `null` (`:891-893`);
  - otherwise: **`const parsed = JSON.parse(text)`** with no content-type check and no try/catch
    (`:892-899`). A `SyntaxError` escapes as-is, carrying neither `status` nor `code`.
- OpenCode 2.x is documented in this tree to answer unknown paths with the web UI's SPA HTML:
  - adapter comment: "The v2 web UI's SPA catch-all answers 200 text/html on any unknown path, so a
    bare `response.ok` can false-attach to a v2 server through the v1 health route. Requiring a JSON
    body keeps that impossible." (`gate/core/cli-environments/adapters/opencode.mjs:29-34`);
  - contract: "the v1 health path `GET /session` answers **SPA HTML 200** on v2, so health must
    require a JSON body, not `response.ok`" (`docs/opencode-backend-contract.md:259-261`);
  - the v2 endpoint table has **no agent route at all**
    (`docs/opencode-backend-contract.md:268-284`); Bot support is listed only for v1
    (`docs/opencode-backend-contract.md:47`).
- Classification: `detectOpenCodeServerMajor` probes with `JSON.parse(await response.text())` inside a
  per-probe try/catch and returns `null` if nothing identifies the server
  (`backends/opencode.mjs:39-67`); `serverProfile()` then caches `{ major: major ?? 1 }`
  (`:774-787`). So even a v2 server that cannot be classified is spoken to as v1 — and `readAgents`
  is v1 unconditionally anyway.
- **The attach itself is already protected against this HTML**, which is why the Gate can be genuinely
  connected to a v2 server while the roster fails: the native-server health probe requires a JSON body
  when the adapter sets `healthJson`
  (`gate/core/cli-environments/native-server.mjs:177-199`; flag at `adapters/opencode.mjs:29-34`,
  comment also at `native-server.mjs:190-192`). `/api/info` answers JSON, so attach succeeds; only the
  un-branched v1 `/agent` read hits the catch-all.
- The backend's own HTTP test records the contract explicitly: "`call()` reads every ok response as
  text and parses what is there" (`gate/__tests__/opencode-backend-http.test.mjs:251-253`).
- Bot inventory tests use a fake whose `/agent` always answers JSON
  (`gate/__tests__/opencode-bots.test.mjs:58-84`, roster test `:135-150`). **No test feeds HTML to
  `listBots`.**

**[INFERENCE]** On a Gate whose only Bot-capable environment is OpenCode 2.x (or where every
Bot-capable environment fails, so the merged path falls through to a single-backend retry),
`GET /v1/bots` reaches `JSON.parse('<!doctype html>…')`. The escaped error has no `status`, so the
Gate maps it to **502 `bot_read_failed`** and forwards its message; the app's
`messageFromHttpErrorBody` returns that verbatim. On Node 20/22 the engine's wording is of the form
`Unexpected token '<', "<!doctype "... is not valid JSON` (exact wording is runtime-version
dependent); the roster caption shows it as the engine wrote it.

**This is the mechanism that produces the reported kind of wording, and it is reachable with the
connection genuinely healthy**: `/health` and the v2 `/api/info` probe are JSON and stay green; only
the un-branched v1 `/agent` route hits the catch-all. Whether it *was* the reported machine is exactly
what Step H measures.

### 3.5 Metadata-write deadlines: two unbounded writes, no roster deadline of their own

**[SOURCE]**

- Hermes description edit: writes are **serialised per Bot home** by a promise chain
  (`gate/core/cli-environments/hermes-bot-edit.mjs:17-22`, `:58-64`). There is **no deadline**: a
  filesystem operation that never settles (a locked network/OneDrive path) leaves `previous` pending
  and every later edit for that Bot waits on it forever. `writeFileAtomic` is used for the write and
  the rollback (`:37-56`).
- OpenCode agent create: write the markdown file, reload with the **v1** routes `GET /session/status`
  and `POST /global/dispose` (`backends/opencode.mjs:1227-1233`), then re-read **once, immediately**
  (`botAgent`, `:1536-1540`). There is no bounded wait for the server to load the metadata; on
  failure the file is removed and `bot_create_failed` (502) is thrown (`:1528-1535`). [INFERENCE] On
  a v2 server those two reload routes are themselves unknown paths (Section 3.4), so the create path
  fails with the same class of parse error.
- The roster read itself has the 30 s transport bound (Section 3.1) and a fetch-time lookup retry, but
  **no retry after an HTTP answer** (`host-lookup.ts:154-166`). There is no separate "roster deadline"
  in the Gate; `readAgents` inherits `READ_TIMEOUT_MS = 30_000` (`backends/opencode.mjs:434`), so a
  hung OpenCode `GET /agent` becomes `backend_timeout` after 30 s rather than a parse error.
- `botIdOwnedElsewhere` (create path) catches a failed roster read and proceeds: "an unreachable
  roster cannot prove a clash; the create proceeds"
  (`gate/core/server.mjs:3022-3028`). The one-namespace invariant is therefore best-effort whenever
  any environment's inventory is failing.

**[INFERENCE]** "Metadata write deadlines" do not explain a parse error. They explain a different
family: a Bot edited/created but not visible, or an edit that hangs behind a previous one. They are
worth fixing, but they belong to a separate step and should not be bundled into the roster fix.

### 3.6 App rendering: the message is shown raw, in three places

**[SOURCE]**

- Mount read: on failure the screen stores `error.message` verbatim
  (`src/components/chat/chat-screen.tsx:1935-1945`); pull-to-refresh does the same
  (`:2394-2427`). `describeGatewayError`/`humanizeGatewayError` are **not** applied here, although
  they exist for other surfaces (`src/lib/gateway/error-humanizer.ts:100-280`, `:316-325`).
- `ChatRoster` renders `{error}` as an unbounded caption above the list
  (`src/components/chat/chat-roster.tsx:458-462`) and separately renders the load-failed empty state
  with "Couldn't load agents" and a Retry (`:482-490`).
- `rosterEmptyView` decides between zero-bots, load-failed, waiting and no-match
  (`src/lib/gateway/bots.ts:176-211`). On a **200 HTML** read the app has a successful empty array, so
  it shows "No bots on this gateway" (`chat-roster.tsx:538-543`) and writes `[]` over the remembered
  roster (`chat-screen.tsx:1933`).
- A failed re-read keeps the last good rows and still reports the error (`roster-read.ts:10-23`), so a
  parse-error caption can sit above a perfectly good Hermes list — consistent with "the roster shows
  a parse error".
- The same raw message reaches Council: `setRosterError(cause.message)`
  (`src/app/council.tsx:113-129`) and the empty-roster `ErrorCard` uses it as `cause`
  (`src/app/council.tsx:375-381`); with retained chips it shows a fixed sentence plus Retry
  (`:422-429`). Fleet is the one surface that names the read status rather than the message:
  `failFleetRosterRead` (`src/lib/fleet/roster-read.ts:24-37`, used at `src/app/fleet.tsx:88-94`).

### 3.7 Existing regression coverage (so a proposed test is not a duplicate)

**[SOURCE]**

| Seam | Test |
|---|---|
| Roster transport shape / no backend scope / no session resume | `__tests__/manifest-client-test.ts:1084-1098`, `:950-972` |
| Roster keep-old-rows, first-read fallback, empty-is-believed | `__tests__/chat-roster-swr-test.ts:145-165`, `:227-360` |
| Empty-state copy and failure/retry wiring | `__tests__/roster-load-failure-test.ts`, `__tests__/roster-waiting-test.ts` |
| Roster rows/subtitles/routing issues | `__tests__/bots-roster-test.ts` |
| Fleet roster read statuses | `__tests__/fleet-roster-state-test.ts` |
| Gate single-backend roster error envelope | `gate/__tests__/backend-routes.test.mjs:1295-1334` |
| OpenCode roster + Bot CRUD against a JSON fake | `gate/__tests__/opencode-bots.test.mjs` |
| OpenCode `call()` parses ok bodies as text | `gate/__tests__/opencode-backend-http.test.mjs:251-253` |
| Hermes profile parsing / Bot lookup | `gate/__tests__/hermes-bot-*.test.mjs`, `hermes-bot-lookup.test.mjs` |

Gaps (nothing above pins these):

1. an OpenCode `GET /agent` that answers **HTML** (any status);
2. `mergedBotRoster` with a failing environment (any number of healthy ones);
3. the app's `listBots` receiving a non-array, non-envelope 200 body;
4. a non-JSON **error** body reaching the roster caption (raw-markup leak);
5. a direct Hermes connection's roster saying "No bots" rather than "cannot inventory";
6. a Hermes profile/directory read failure vs a genuine missing key;
7. any deadline on a serialised Hermes metadata write.

---

## 4. Ranked hypotheses

Confidence is about the *mechanism being present in code*, never about the operator's symptom.

### H1 — An OpenCode 2.x environment's `/agent` HTML reaches `JSON.parse`, and the Gate forwards the SyntaxError. **High**

[SOURCE] `readAgents` uses v1 `/agent` with no major branch (`backends/opencode.mjs:1208-1211`);
`call` parses every ok body unconditionally (`:892-899`); the v2 SPA catch-all is documented for
unknown paths (`adapters/opencode.mjs:29-34`, `docs/opencode-backend-contract.md:259-261`) and v2 has
no agent route in the contract (`:268-284`); the Gate maps an unstatused throw to 502 and forwards
the message (Section 3.2); the app shows the message raw (Section 3.6). [INFERENCE] The visible result
is the reported class of sentence — an engine parse error naming `<!doctype`/`<` — over a roster that
may still show Hermes rows from a previous good read, while the connection stays green. Confirmation:
the Gate manifest lists an OpenCode environment whose reported server major is 2;
`GET /v1/bots?backendId=<that>` returns 502 `bot_read_failed` with a `<!doctype`/`Unexpected token`
message; the OpenCode host answers `GET /agent` with `200 text/html`. Refutation: no OpenCode
environment attached, or `/agent` answers JSON on the reported host.

### H2 — An intermediary (web-UI catch-all, reverse proxy, or captive page) answers the roster with HTML. **Medium-High as an HTML source; Low as the reported wording**

[SOURCE] The client never checks content type (`http-transport.ts:176-181`) and never sends `Accept`
(`:123-130`). A 200 HTML body becomes `[]` (silent empty roster, cache overwritten); a 4xx/5xx HTML
body becomes the caption verbatim (`http-error-body.ts:1-19`). [INFERENCE] Neither outcome is a JSON
parse error sentence, so H2 explains a missing roster or an HTML caption, not the reported wording.
Still worth fixing because both outcomes are dishonest. Confirmation: capture the response's
`content-type` and first bytes at the device or through a local proxy; the app caption text will be
either empty-roster copy or markup.

### H3 — A Hermes metadata read is failing on the host and is rendered as a fact. **Medium**

[SOURCE] `readText` returns `''` for any error (`hermes-profiles.mjs:182-188`) and `describeRouting`
calls that "No listen key" (`:151-160`); a failed `profiles/` readdir collapses the roster to the
default Bot with no error (`:208-221`). Confirmation: a row that says "No listen key" while its
`.env` is readable, or a roster that is exactly one Bot on a multi-Bot host; reproduce a locked file
with an injected `readFile` that throws `EBUSY`. Refutation: all rows look right and the roster count
matches the host.

### H4 — On a multi-environment Gate, a failing environment is silently dropped from the roster. **Medium**

[SOURCE] `mergedBotRoster` assigns `firstError` and never reads it (`server.mjs:2981-3012`). The app
never scopes the read (`manifest-client.ts:826-831`, test `:968-972`), so this is the only path a
normal app read takes on a multi-env Gate. Confirmation: manifest lists two or more Bot-capable
environments; `GET /v1/bots` omits one environment's rows while `GET /v1/bots?backendId=<it>` fails.
Refutation: a single Bot-capable environment, or the missing rows come from an empty profiles dir.

### H5 — A metadata write has no deadline, so a create/edit is reported late or never and the "roster" looks stale. **Medium-Low, and not a parse error**

[SOURCE] Hermes edits queue behind a promise chain with no timeout
(`hermes-bot-edit.mjs:17-22`, `:58-64`); OpenCode create reloads through v1 routes and re-reads once
with no wait (`backends/opencode.mjs:1227-1233`, `:1528-1540`). Confirmation: an injected
never-settling `writeFile` leaves the next edit pending past any reasonable bound; an OpenCode fake
that loads the agent one tick late reports `bot_create_failed` today. Refutation: writes settle
promptly and created Bots appear immediately.

### H6 — The app attached as a Hermes client and has no roster method at all, which reads as "no Bots". **Low-Medium**

[SOURCE] A Gate whose manifest fetch failed is attached without a manifest and gets
`HermesGatewayClient` (`adapters.ts:301-310`); the manifest read swallows a non-JSON body as `null`
(`src/lib/portal/manifest.ts:311-318`); the provider maps a missing `listBots` to `[]`
(`gateway-provider.tsx:6664-6672`); the roster then says "No bots on this gateway"
(`chat-roster.tsx:538-543`). Confirmation: the live client has no `listBots`; the manifest fetch
returned null with a 200 HTML body. Refutation: the roster read exists and returned rows.

### H7 — The Gate's own roster route serves HTML. **Very low / effectively excluded**

[SOURCE] The handler sets `Content-Type: application/json` for every response before routing
(`server.mjs:2406`), and both success and failure bodies are `JSON.stringify` (`:3591-3592`,
`:3600-3611`). Every `text/html` occurrence under `gate/` is a comment about the **OpenCode v2 SPA
catch-all**, not a Gate response body (`adapters/opencode.mjs:30`, `backends/opencode.mjs:30-31`,
`native-server.mjs:153-154`, `:190-192`). Only an intermediary or an OpenCode backend can put HTML on
this route (H1/H2). Refutation: any captured 200/502 from a real Gate that starts with `<`.

---

## 5. What this investigation could **not** establish

- **No reproduction.** [UNVERIFIED] The operator's Gate version, environment list, which environment
  failed, the response status, and the exact banner text. Nothing here claims any of them.
- **No live HTTP.** Every status in this document is a code path, not an observation. No Gate was
  started, no token was read, no device or account was touched.
- **OpenCode 2.x `/agent` behaviour is not measured** [NOT RUN]. The SPA catch-all is documented for
  `/session` and generalised in a source comment; whether 2.0.32 answers `/agent` with
  `200 text/html` (versus a JSON 404) is the single measurement that promotes or kills H1.
- **No performance claim.** Nothing here is an FPS or latency statement.
- **No claim that any existing test is green at HEAD.** The focused gate for this step is the document
  grep only; `npm run verify` is the reviewer's job.
- **Council/Fleet rendering** were read, not rendered. No visual regression is claimed either way.

---

## 6. Proposed work, one independent step per item

Order is by value, not dependency. Every step keeps layout, motion and colour untouched; the only
visual surface any step proposes is **text content** in an existing caption/error card. Each step is
provable by a focused, hermetic test and must leave existing assertions byte-identical.

### Step A — Name a non-JSON Bot inventory at the OpenCode boundary

Problem: H1. A v2 SPA page becomes a `SyntaxError` and travels to the phone as product text.

- Files: `gate/core/cli-environments/backends/opencode.mjs` (`call` at `:892-899`, `readAgents` at
  `:1208-1211`), `gate/__tests__/opencode-bots.test.mjs` or a new
  `gate/__tests__/opencode-roster-html.test.mjs`.
- Change: in `call`, after an ok body that is non-empty, parse inside a guard. On failure throw a
  named error such as `opencode: GET <path> answered <content-type or "a non-JSON body">, not JSON`
  with `code: 'backend_not_json'` and `status: 502`. Keep 204/205 and empty bodies returning `null`
  exactly as today; keep the non-2xx path unchanged (it keeps its upstream status). `listBots` and
  `getBot` then fail with a named capability-class error instead of an engine message.
- Do **not** invent a v2 agent route in this step. The contract lists none
  (`docs/opencode-backend-contract.md:268-284`); if `/openapi.json` (a live read, Step H) names one,
  wiring it is a separate step with its own fixtures.
- Acceptance tests (hermetic, no real server):
  1. fake whose `/agent` answers `200` `text/html` (`<!doctype html><title>OpenCode</title>`) and whose
     `/api/info` answers v2 JSON → `listBots()` rejects with `code: 'backend_not_json'`, and the
     message names `/agent` and `text/html`, and does **not** contain `Unexpected token`;
  2. the same fake with `/agent` answering a JSON array → roster rows unchanged byte-for-byte;
  3. `/agent` answering `404` `text/html` → still a `status: 404` error, message names the route;
  4. `/agent` answering `200` with an empty body → `null` path unchanged (no new throw);
  5. `detectOpenCodeServerMajor` still classifies from `/api/info` (no regression).

### Step B — A failed environment must not vanish from the merged roster

Problem: H4. `firstError` is dead code; a broken environment is indistinguishable from an empty one.

- Files: `gate/core/server.mjs` (`mergedBotRoster` at `:2981-3012`),
  `gate/__tests__/backend-routes.test.mjs` or a new focused test.
- Change (smallest honest version): make `firstError` load-bearing, without throwing into the outer
  500 handler (see Section 3.2) —
  - when `listed.length === 0`, hand `firstError` back to the route so it writes it through the
    existing roster error envelope (`:3602-3611`) instead of re-resolving and reporting a different
    environment;
  - when at least one environment listed, keep today's merged rows and add an additive
    `warnings: [{ backendId, code, message }]` to the `{ object: 'list', data }` envelope. Older app
    clients ignore an unknown envelope field; nothing in the current `listBots` would break
    (`manifest-client.ts:826-831` reads only `data`).
- Do **not** drop the rows that did read, and do not fail the whole roster because one environment is
  down (that would turn a partial truth into no truth).
- Acceptance tests:
  1. one failing + one healthy fake environment → 200, the healthy rows present, one warning naming
     the failed `backendId` and its code;
  2. only a failing environment → 502/its upstream status with its original message and
     `bot_read_failed` (or its own code), and `resolveBackendFor` is not asked to pick a different
     backend;
  3. all healthy → response bytes identical to today (no `warnings` key when nothing failed);
  4. the existing single-backend envelope cases at `backend-routes.test.mjs:1295-1334` stay green.

### Step C — The app must not read a non-JSON 200 as an empty roster

Problem: Section 3.1, the silent-empty mode. Today an HTML 200 returns `[]`, paints "No bots", and
writes `[]` over the remembered copy.

- Files: `src/lib/gateway/manifest-client.ts` (`:826-831`), `__tests__/manifest-client-test.ts`.
- Change: accept only an array of Bot-shaped rows or `{ data: PublicBot[] }`. A string, number,
  `null`, or object without an array `data` must throw a `GatewayHttpError` with a product-neutral
  message (e.g. `The gateway answered the Bot roster with a body that is not a roster.`) and a named
  code. An empty array stays a valid, believed answer. Do not add a global content-type rule to
  `HttpTransport.request`: its text fallback is relied on by other routes and a global change is
  outside this step.
- Acceptance tests:
  1. 200 `<!doctype html>…` → throws; the cache write is not reached (source/behaviour assertion in
     the existing style);
  2. 200 `{ data: [] }` → `[]`, and the roster still shows the zero-bots state (no regression);
  3. 200 `[]` → `[]`;
  4. 200 `{ object:'list', data:[…] }` → same rows byte-for-byte;
  5. 502 `{ error: { message, code } }` → unchanged `GatewayHttpError` with that message/code.

### Step D — A non-JSON error body must not become the operator's caption

Problem: Section 3.1/3.6, the raw-markup mode, and the same class of leak that shows an engine
sentence today.

- Files: `src/lib/gateway/http-error-body.ts`, `__tests__/http-transport-test.ts` (it already imports
  these helpers at `:3`) or a new focused test.
- Change: keep JSON extraction byte-identical. When the body is not JSON and (after trimming) starts
  with `<`, return a bounded sentence that names the status and the fact that a page was returned
  instead of JSON (e.g. `The gateway or something in front of it answered HTTP 502 with a web page
  instead of JSON.`), and cap the returned length. Empty/non-HTML bodies keep the current
  `errorText || HTTP <status>` fallback.
- Do **not** add LLM-style heuristics or try to classify every body; the only rule is "markup is not a
  message".
- Acceptance tests:
  1. `{"error":{"message":"boom"}}` → `boom` (unchanged);
  2. `{"error":{"code":"x"}}` → `HTTP 502` fallback unchanged;
  3. `<!doctype html><h1>502</h1>` + 502 → no `<` in the result and the status is mentioned;
  4. a very long non-HTML body still falls back to the current text (length unchanged) — so this step
     changes only markup;
  5. an empty body → `HTTP 502`.

### Step E — A direct Hermes connection is not "no Bots"

Problem: H6 and the provider's `[]` fallback. A surface that never attempted an inventory claims
zero.

- Files: `src/context/gateway-provider.tsx` (`:6664-6672`), optionally a small pure helper in
  `src/lib/gateway/bots.ts`, and the roster wiring in
  `src/components/chat/chat-screen.tsx`/`chat-roster.tsx`.
- Change: expose whether the live client has a roster method (or the manifest advertises
  `endpoints.bots`) alongside `listBots`; on the roster surface show a distinct "This connection
  cannot inventory agents" line instead of "No bots on this gateway" when the read never ran. Keep
  `rosterEmptyView`'s existing cases and their exact copy for a real zero.
- Acceptance tests:
  1. client without `listBots` + connected → the new copy, and not "No bots on this gateway";
  2. client with `listBots` returning `[]` → the existing zero-bots copy byte-identical;
  3. `rosterEmptyView`'s existing table in `__tests__/bots-roster-test.ts:340-430` unchanged.

### Step F — A failed Hermes profile read is not a fact about a Bot

Problem: H3. `readText`'s blanket `''` and the swallowed `readdir`.

- Files: `gate/core/cli-environments/hermes-profiles.mjs`, the Hermes backend's `listBots`, and
  `gate/__tests__/hermes-bot-*.test.mjs` / `hermes-bot-lookup.test.mjs`.
- Change: distinguish "file absent" from "file unreadable". At minimum, a failed `profiles/` directory
  read must fail the roster read with a named code (the precedent is the provider roster's
  `provider_roster_unreadable`, `gate/__tests__/provider-roster-read-failure.test.mjs:54-72`) rather
  than returning the default Bot alone. Per-profile unreadable `.env`/`profile.yaml` needs a shape
  decision: either a new additive field (e.g. `readError`) or a named whole-read failure — **do not**
  reuse `routingIssue` for it, because that enum is a routing verdict and the row would claim the
  wrong fix.
- Do **not** change `PublicBot`'s existing required fields or the wire shape of a healthy roster.
- Acceptance tests:
  1. `readdir` throws `EBUSY` → `listBots` rejects with the named code; the Gate route returns 5xx with
     that code (extend the table at `backend-routes.test.mjs:1295-1299` if the code is generic);
  2. a profile with no `.env` still reads `listen_key_missing` (unchanged);
  3. a readable host with three profiles still returns three rows, `default` first, byte-identical;
  4. `getHermesBot` keeps its case-sensitive, single-directory behaviour
     (`hermes-profiles.mjs:300-321`).

### Step G — Bounded metadata writes (only if the report includes "my new Bot never appears")

Problem: H5. Independent of the parse error.

- Files: `gate/core/cli-environments/hermes-bot-edit.mjs` (`:17-22`, `:58-64`),
  `gate/core/cli-environments/backends/opencode.mjs` (`:1528-1540`), plus tests.
- Change: wrap the serialised edit in a deadline (a few seconds, injectable for tests) and refuse with
  a named `bot_edit_timeout` instead of queueing forever; ensure the chain always advances. For
  OpenCode, replace the single immediate `botAgent` re-read with a small bounded poll (injectable
  clock) whose expiry is reported as `bot_create_not_loaded`, keeping the file-removal rollback on
  genuine failure.
- Acceptance tests: a never-settling first write → the edit rejects at the deadline and the *next*
  edit still runs; a slow-loading fake → createBot succeeds once the agent appears inside the bound;
  the existing `createBot removes its file when the server never loads the agent`
  (`opencode-bots.test.mjs:207-211`) still passes (with its fake made explicitly never-loading).

### Step H — Live verification runbook (no code; a human runs it) **[NOT RUN]**

Purpose: turn H1/H2/H3/H4 into measurements without this loop touching any device, account, key or
service. All commands are read-only against the operator's own machine. Never print tokens or
`Authorization` headers; do not run `--turns`; do not create, edit or delete a Bot.

1. **Record the build.** Gate version from `GET /.well-known/gateway.json`, the app's connection
   screen's gateway name, and the environment list (`manifest.backends` ids + kinds). This alone
   separates single-env from multi-env (H4).
2. **Reproduce the roster read without the phone.** With the Gate's token available locally (never
   echoed):
   `node scripts/live-smoke.mjs` — its read-only pass calls `/health`, `/v1/bots`,
   `/.well-known/gateway.json`, `/v1/models`, and per-environment model/session lists
   (`scripts/live-smoke.mjs:210-244`). On a failing roster it records
   `bots listed: false — HTTP <status>` (`:217-225`). Capture that line.
3. **Find the failing environment.** For each id from step 1:
   `GET /v1/bots?backendId=<id>` (same token). Record status, `content-type`, and the first ~200
   characters of the body. Expected discriminator:
   - 502 `bot_read_failed` whose message contains `Unexpected token` and `<!doctype`/`<`
     → H1, and the `backendId` names the culprit;
   - 200 with rows → that environment is healthy;
   - 200 with `[]` → genuinely empty, or the app-side C leak if the body was HTML (check the
     recorded `content-type`).
   The `call()` helper in `live-smoke` already exposes raw `text`, `status` and parsed `json`
   (`scripts/live-smoke.mjs:84-110`), so no extra tooling is needed.
4. **Ask the OpenCode host what it serves** (only if step 3 named an OpenCode environment). Using the
   credentials the Gate already holds, read-only:
   - `GET /agent` (v1 shape) — record status and `content-type`;
   - `GET /api/info` (v2 shape) — confirms major;
   - `GET /openapi.json` — search for an agent route (this is the only honest basis for a v2 agent
     mapping).
   A `200 text/html` on `/agent` confirms H1. A `404 text/html` refutes the exact wording but still
   means the roster cannot work on v2.
5. **Check an intermediary only if step 3 shows HTML from the Gate itself** (which H7 says should not
   happen): compare a request sent straight to the Gate host/port with the same request through the
   proxy/Tailscale name. A different `content-type` or body identifies H2.
6. **Hermes-only check for H3.** On a Gate with only the Hermes environment, compare the roster count
   with `profiles/` on disk, and check whether any row says "No listen key" while its `.env` carries
   `API_SERVER_KEY`. Do not open or copy credential values; check key presence only.
7. **Record** device/app build (if the report is from a phone), the exact banner text, whether the
   bots list was empty or merely stale, and every status/content-type above. A banner containing
   `Unexpected token` points at H1 (the Gate parsed an HTML body from a backend route); a banner
   containing markup is H2 or the D-class leak; an empty list with 200 is the C-class leak.

---

## 7. Acceptance summary for the whole set

- A non-JSON Bot inventory is named as such by the environment that produced it, never as an engine
  `SyntaxError` (A).
- A partial roster never silently omits a failing environment; a total failure never fails over to an
  unrelated backend's error (B).
- A 200 page can never be painted or cached as "zero Bots" (C).
- An HTML error body can never be shown as the roster's reason; a JSON message is unchanged (D).
- A connection that cannot inventory agents says so instead of claiming there are none (E).
- A Hermes read failure is never rendered as a missing listen key or a one-Bot host (F).
- A hung metadata write cannot block the next edit forever, and a created Bot's visibility is bounded
  and named (G).
- Every claim about the real system comes from Step H; none is pre-written here.

Risks: A and G are Gate-only, pure-ish error paths; B adds an additive envelope field (older clients
ignore it); C, D and E are app-side message/honesty changes with no layout, motion or colour work; F
needs a shape decision for per-profile read errors and should not silently extend `routingIssue`.

Existing snapshots and source-assertion tests must be extended, never relaxed. No new Expo API is
proposed (the driver read https://docs.expo.dev/versions/v57.0.0/ before launching; this document uses
no new Expo surface).

---

## 8. Questions for whoever owns the handoff

1. Which Gate, and how many Bot-capable environments does it list? One environment makes B's dead
   `firstError` irrelevant and points straight at A/H1; several make B the first fix.
2. Is any OpenCode environment attached, and which server major does it report? H1 dies immediately
   without one.
3. Was the roster **empty**, **stale but populated**, or **populated plus an error line**? The first
   points at C or E, the second at A/B, the third at A/B with the keep-old-rows rule
   (`roster-read.ts:10-23`).
4. What exactly did the caption say? An `Unexpected token '<' … is not valid JSON` string points at
   H1 (the Gate parsed an HTML body from a backend route); a screenful of markup points at H2 (an
   intermediary answered the Gate call) or the D-class leak; "No bots on this gateway" with no error
   is C/E.
5. Did the failure start after an OpenCode 2.x upgrade, or after a proxy/Tailscale change? Those are
   the only two HTML sources this tree supports.
6. If a Bot was created or edited around the same time: did it ever appear? That splits G from A/B.
7. Is the operator willing to run the read-only Step H commands and paste the statuses/content-types
   (never tokens)? Without that, this stays a ranked hypothesis list, not a diagnosis.
