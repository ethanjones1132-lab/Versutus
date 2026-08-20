# Gap & Bug Audit — 2026-08-19

Written after the capability work (Phases 0–5) landed and the first real
device test failed. Scope: bugs in what now ships, and gaps between what the
verification gates claim and what they actually check.

Every finding carries a `file:line` or a command whose output I read. Where I
could not verify something, it says so — that distinction is the point of this
document, for reasons §1 explains.

---

## 0. The finding that reframes the others

Streaming chat never worked on device, and **every gate this repo has was
green while it was broken**: 468 jest tests, 439 gate tests, `tsc`, lint, and a
live pass I ran against the real Gate and real Hermes that showed token-by-token
frames arriving and persisting to the transcript.

All of it was true. None of it touched the failing path.

React Native's global `fetch` is `whatwg-fetch` over XMLHttpRequest — RN 0.86
still ships it (`node_modules/react-native/Libraries/Network/fetch.js` is a bare
re-export). Its `Response` prototype is:

```
constructor, bodyUsed, _initBody, arrayBuffer, text, formData, json, clone
```

No `body`. So `response.body?.getReader()` is `undefined` and
`streamSSE` (`src/lib/gateway/http-transport.ts:113-114`) threw
`"No response body to stream"` on every call. Replies still appeared, because
the turn completes server-side and the transcript reload renders it — which is
why this presented as "no live feed" rather than as an error.

The live pass was run **from Node**, where `fetch` does expose a readable body.
I verified the server was correct and concluded the feature worked. The server
*was* correct. The conclusion did not follow.

**The class:** any assumption about the JS environment is invisible to this
repo's entire test and verification apparatus, because all of it runs in Node.
Findings §1.1–§1.3 are the other members of that class I could find.

---

## 1. Bugs

### 1.1 `btoa` / `atob` are assumed and provided by nothing I can find — UNVERIFIED

`src/lib/gateway/device-identity.ts:19,25` calls `btoa`/`atob` **unguarded**.
This is the device identity path: key encoding and request signing for pairing.

Neither is installed by React Native 0.86 (`grep -rn "global.btoa\|global.atob"
node_modules/react-native/Libraries/` → nothing) nor by Expo's WinterCG runtime,
whose installed set is explicit at
`node_modules/expo/src/winter/runtime.native.ts:15-32`: `TextDecoder`,
`TextDecoderStream`, `TextEncoderStream`, `URL`, `URLSearchParams`,
`DOMException`, `structuredClone`. Note that plain **`TextEncoder` is also
absent** from that list, and is used at `device-identity.ts:90`.

Your phone has a paired device on file, so on your device these almost
certainly exist — Hermes provides them natively. That is an inference from the
feature working, not a verified fact, and it is exactly the shape of reasoning
that produced §0. It holds only for the Hermes engine version in this build.

**Cost if wrong:** pairing and request signing throw. **Detectable by:** nothing
currently in the repo.

### 1.2 Terminal output above 64KB is silently discarded — MINE, this session

`gate/core/cli-environments/terminal.mjs:78`:

```js
const text = Buffer.from(buffer).subarray(0, MAX_CHUNK_BYTES).toString('utf8');
```

`subarray` truncates. Everything past 64KB in a single chunk is **dropped**,
not deferred — a command with a large burst of output loses the tail with no
indication. The cap was meant to bound frame size; it bounds data instead.

Second defect in the same line: cutting at a byte offset can split a multi-byte
UTF-8 sequence, so the boundary character decodes to U+FFFD. `TextDecoder` with
`{stream: true}` exists precisely to carry that partial sequence across chunks.

**Fix:** slice into multiple frames rather than truncating, and decode with a
streaming decoder held per session.

### 1.3 The Shell tab renders nothing, silently, if `atob` is missing

`src/lib/terminal/client.ts:16-17`:

```ts
if (typeof globalThis.atob !== 'function') return '';
```

Every output chunk becomes an empty string. The pane shows a connected session
producing no output and reports nothing wrong. This is the same failure mode
the Gate already went out of its way to eliminate for chat turns — see the
`empty_turn` frame at `gate/core/server.mjs` and its comment: *"a clean [DONE]
here would render as a silent empty bubble with no indication anything went
wrong."* The guard should surface, not swallow.

### 1.4 `gate/` is not linted — `npm run verify` says otherwise

`npm run verify` runs `npm run lint` = `expo lint`, which covers `src/` and
`app/` only. Running ESLint directly on the Gate finds real problems:

```
npx eslint gate/core/cli-environments/terminal.mjs
  78:22  error  'Buffer' is not defined  no-undef
```

Harmless in itself (`Buffer` is a Node global; `eslint.config.js` declares no
Node env for `gate/`), but the point is that **the component with a shell
endpoint, credential vault, device tokens and OAuth has no lint gate at all**,
while the verification command implies whole-repo coverage. `eslint.config.js:8`
ignores only `dist/*`, so this is `expo lint`'s target selection, not an
explicit exclusion — nobody decided this.

### 1.5 Terminal input is not bound to the session's owner

`gate/core/server.mjs` — `POST /v1/terminal/input` looks up `sid` and writes.
Any holder of any valid token can write to any live session id. Today every
token is equally trusted so the practical severity is low, but it means a
second paired device — or one whose device token has not yet been revoked —
can type into a shell another device opened.

### 1.6 33 swallowed rejections in app code

```
grep -rn "\.catch(() => \[\])\|\.catch(() => null)\|\.catch(() => undefined)" src/lib/ src/context/
→ 33
```

Some are deliberate and correct (history reload falling back to an empty list).
Others are the mechanism by which a broken path stays invisible — §0's bug
reached the user as "no live feed" rather than an error partly because failures
in this area do not surface. Worth a pass to separate the two.

---

## 2. Gaps

### 2.1 There is no device-level verification loop — FIXED

This repo can verify: Node unit tests, Node gate tests, types, lint (partially,
per §1.4), and live HTTP against a running Gate **from Node**. It cannot verify
anything about the JS environment the app actually runs in. §0 and §1.1–§1.3 all
live in that blind spot.

**Fixed.** `src/lib/runtime-environment.ts` probes the engine and
`src/app/gateway/diagnostics.tsx` surfaces it at Settings → Runtime environment.
It ships in **release** builds deliberately: `src/app/dev/*` redirects away
outside `__DEV__`, and the release build is the one whose engine is in question.
The live check reads the gateway's `/health` through the installed streaming
fetch and asserts a reader exists — the exact capability whose absence broke
streaming, which no global-presence check can answer.

The original proposal, for the record: a dev-only screen that reports which globals exist
(`fetch().body`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `ReadableStream`)
and runs one real SSE round-trip against the connected Gate. The `/dev` route
group already exists (`src/app/dev/`). That converts an entire class of
unverifiable assumption into a five-second check on the device in your hand.

### 2.2 The capability denominator — FIXED

Computed from the live manifest after the restart:

**Ready (12):** `chat`, `agent`, `sessions`, `approvals`, `models`, `tools`,
`providers`, `environments`, `skills`, `diagnostics`, `cron`, `terminal`
**Off by Hermes' own design (3):** `config`, `memory`, `voice`
**Defined nowhere (6):** `channels`, `plugins`, `logs`, `devices`, `artifacts`,
`nodes`

**Fixed.** The six now report a distinct `undeclared` status and are excluded
from both halves of the ratio, so the headline reads **12 of 15**. The
distinction that matters is preserved: `unsupported` means a real capability
this gateway does not offer, `undeclared` means nothing defines it anywhere. A
registered capability instance still promotes a group out of it.

### 2.3 The terminal is remote code execution — DECIDED: accepted as-is

Raised four times across this work and never answered, so it ships as built:
any holder of a Gate token gets an interactive shell on the host, enabled by
default on upgrade, reachable from anywhere on the tailnet. The Gate already
runs CLI agents with `credential`-risk operations, so this is arguably within
the existing posture — but it materially changes what a leaked or stale device
token is worth, and no operator opted into it.

**Decision (Ethan, 2026-08-19): accepted as-is.** The terminal ships enabled by
default; any holder of a valid Gate token can open a shell on the host. This is
a deliberate acceptance of the posture, not an oversight — recorded here so it
does not get re-raised as an open question.

Session ownership was tightened independently (§1.5, `c0ca07f`): a shell only
accepts input from the credential that opened it, so a second token cannot type
into someone else's session. It can still open its own.

Rejected in taking this decision: a config flag defaulting off, and a distinct
scope on the device token. Either remains available if the posture changes.

### 2.4 Phase 7 (bots) — SUPERSEDED by ADRs 0004–0006

No longer gated on an upstream fork. `docs/adr/0004-bots-are-hermes-profiles.md`
rejects §4's premise outright: a Bot is a Hermes **profile**, not an entry in
`runner.adapters`, and Hermes already owns the multiplex address that routes to
one. ADRs 0004–0006 are the current design; §4's tiering and its fork cost no
longer apply. `docs/handoff-phase7-bots-2026-08-19.md` carries a banner to the
same effect.

---

## 3. What actually went well, and why it is worth keeping

Two mechanisms caught real defects during this work, both by refusing to trust
a claim:

- The **allowlist drift test** caught its own new endpoint hanging, because it
  reads every advertised endpoint rather than a hand-maintained list.
- Reading the **live Gate's manifest** — not a test — found that the fronted
  routes resolved to `claude-local` and would have 501'd on the real machine
  while `hermes-local` sat there able to serve them (fixed in `b88c336`). Every
  route test attached exactly one backend, so position and capability always
  coincided.

Both worked by checking the real artifact against reality instead of checking a
model of it. §2.1 is the same idea applied to the one environment that has never
been checked at all.

---

## 4. Ranked

By expected cost of leaving it, not by effort. Ten findings; §2.4 is listed
unranked because it is carried forward from the previous audit rather than
found here, and is blocked on a decision this work cannot make.

| # | Finding | Severity | Effort |
|---|---|---|---|
| — | §2.1 Device-level verification loop | **Fixed** — Settings → Runtime environment | Closed |
| 2 | §1.1 `btoa`/`atob`/`TextEncoder` unverified on device | **High if wrong** — pairing breaks | Trivial to check once §2.1 exists |
| — | §2.3 Terminal RCE posture | **Decided** — accepted as-is, 2026-08-19 | Closed |
| 4 | §1.2 Terminal drops output past 64KB | Medium — silent data loss | Small |
| 5 | §1.4 `gate/` unlinted while verify implies coverage | Medium — false assurance | Small |
| 6 | §1.3 Shell tab fails silently | Medium | Trivial |
| 7 | §1.5 Terminal input unbound to owner | Low today | Small; folds into §2.3 |
| 8 | §1.6 Swallowed rejections | Low, diffuse | Medium |
| — | §2.2 Capability denominator | **Fixed** — undeclared groups excluded | Closed |
| — | §2.4 Phase 7 (bots) | Carried forward — unranked | Blocked on the upstream-fork decision, not on effort |

## 5. Deliberately not findings

- **The Gate crash** (`2be9643`) is fixed. Its cause — the outer catch calling
  `writeHead(500)` on an already-committed response — was a direct consequence
  of the streaming work committing SSE headers early. Worth noting only because
  the last line of defence was itself able to throw.
- **Hermes under-reporting `jobs_admin`** is upstream and already worked around
  by advertising from observed fronting.
- **`streamEvents` being a no-op on the Hermes backend** is correct, and
  deliberate — like `abort` throwing. An empty subscription that never yields
  is worse than an absent one.
