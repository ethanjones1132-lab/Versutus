# Per-turn change list in a Versutus thread

**Status:** design note, no code. Branch `20261126-0745-versutus-vs-094-design-note-how-t`, master `90fcd70`.
Moves Versutus Play Store open testing / VS-T2 (turns finish, messages survive reconnects, errors say what to do).

**Problem.** A turn can edit files, but the thread cannot say what it changed. The only surface today is
session-wide and read-only (`src/components/chat/session-changes-sheet.tsx:51-84`), implemented by one
backend. This note defines what the app may show per turn, from where, and what it must never claim.

**Path shorthand.** `server.mjs`/`manifest.mjs` in `gate/core/`; the three `*.mjs` backends in
`gate/core/cli-environments/backends/`; `turn-journal.mjs` in `gate/core/turns/`; `types.ts`,
`messages.ts`, `chat-stream-delta.ts` in `src/lib/gateway/`; the sheet in `src/components/chat/`.

---

## 1. Source of truth per backend

### What exists in common

All three backends stream tool calls, and the start frame carries arguments when the backend provides
them: Claude `tool.input` (`claude-code.mjs:97`, `:116-119`), Codex `item.command`/`item.arguments`
(`codex.mjs:89-93`), OpenCode `state.input` (`opencode.mjs:611-621`). The app keeps them only as
`ChatToolCall.detail` (`types.ts:216-223`, parsed at `chat-stream-delta.ts:220-232`). History drops
the arguments at the Gate for all three (`opencode.mjs:125-127`, `claude-code.mjs:73-75`,
`codex.mjs:61-71`), and the app's history reader can only stringify `input` when present
(`messages.ts:259-288`). **Arguments, and therefore paths, are live-stream only; frame timestamps
survive only in the journal (`turn-journal.mjs:6-12`).**

### Per backend

**OpenCode.** The only backend with a real change feed: `/api/session/{id}/diff` yields structured
`path`/`status`/`additions`/`deletions`/`patch` (`opencode.mjs:1581-1624`), enabled for server major
>= 2 and treating a 404 as unsupported (`:1582-1583`, `:1592-1601`). **It is session-scoped, not
turn-scoped**: rows carry no turn id, so attribution is the app's job (section 2), labelled as
corroboration, not authorship.

**Claude.** Tool frames give `Write`/`Edit`/`MultiEdit`/`Bash` names and input, but `tool.output`
carries only `callId` and `isError` (`claude-code.mjs:104-110`) — not the result text. There is no
`getSessionChanges`; the route answers `{files: [], supported: false}` (`server.mjs:4697-4700`).

**Codex.** `item/started` gives commands/arguments (`codex.mjs:89-93`); `item/completed` gives a
status and possibly aggregated output (`:94-102`). No diff route, same `supported:false` fallback
(`server.mjs:4697-4700`). Shell output can name a path it read as easily as one it wrote.

**Plainly: no turn-scoped change data exists today.** OpenCode reports a *session* diff; Claude and
Codex report tool invocations. Any per-turn list is app inference, and must be presented as such.

### What it must not fabricate

- A path in `Read`, `Grep`, `Glob`, `search` or `cat` input is **not** a change. A `Write`/`Edit`
  path is *touched*; *changed* only when a diff corroborates it (OpenCode) — otherwise "touched",
  never "+N −M".
- Never derive `additions`/`deletions` from a tool name, a line count in args, or a hunch; counts
  exist only where the diff supplies them (`opencode.mjs:1618-1619`).
- Never turn a session diff row into "this turn changed it" without section 2's window evidence.
- Never show contents from tool input: `Write.input.content` is the whole file, and it must not be
  persisted or logged.

---

## 2. A per-turn window

### Identity already exists

`ChatMessage.turnId` ties a bubble to a Gate turn (`types.ts:256-265`); the Gate journals one file per
turn (`turn-journal.mjs:6-12`), replayable by `GET /v1/turns/{id}` and `/v1/turns/{id}/events`
(`server.mjs:275`, `:5274-5280`; `manifest.mjs:134`). Key every observation on it — not the bubble id
or the text.

### What the journal already gives you

- One file per turn, `<caller>/<turnId>.jsonl`: meta line 1, then one event per SSE frame
  (`turn-journal.mjs:6-12`).
- Meta carries `turnId`, `sessionId`, `backendId`, `status`, `startedAt`, `updatedAt`, `finishedAt`,
  `lastSeq` (`turn-journal.mjs:766-781`). That is the window, in the Gate's clock.
- `GET /v1/turns/{id}` returns meta, events and assembled text (`turn-journal.mjs:297`,
  `server.mjs:5289-5298`); `/events?after=<seq>` replays frames from a cursor
  (`server.mjs:5274-5283`). Prefer the cursor route: a full record can reach 2 MB
  (`turn-journal.mjs:23`).
- Retention: 7 days, 300 turns, 2 MB frames, 256 KB reply (`turn-journal.mjs:23-26`). It gives the
  **window and the replay**, never a file list, diff, or paths.

### Bounding a turn

**`turnId` decides attribution; time only orders and reconciles.**

1. **Observe at tool-call time.** On a write-like `tool.started`, append
   `{turnId, callId, tool, path, seenAt}` to the local record. This works live on all three backends
   and survives history because it is captured before the stream ends.
2. **Window** = `meta.startedAt` .. `meta.finishedAt` (or `updatedAt` while `running`,
   `turn-journal.mjs:766-781`). If the journal row is gone, fall back to the first and last observed
   frame `t` for that `turnId`; `ChatMessage.timestamp` (`types.ts:229`) is a last resort, since
   history rows may omit it.
3. **Corroborate (OpenCode only).** Snapshot `/api/session/{id}/diff` at turn start and end; the
   per-turn diff is the set difference by `path`, comparing status, additions, deletions and patch
   (`opencode.mjs:1581-1624`). No pre-snapshot means no attribution: show "session changed", never
   "this turn changed". Never diff contents to guess.

Worked example: `t0` start (`meta.startedAt`); `t1` `Edit` names `src/a.ts` → `evidence:'tool'`;
`t2` `Read` of `src/b.ts` → ignored; `t3` reconnect replays `after=lastSeq` and merges the same
`callId` (`turn-journal.mjs:17-21`); `t4` end, post-snapshot shows `src/a.ts` `+4 −1` → promoted to
`evidence:'diff'`. If another process edits `src/c.ts` in the window, it appears in the diff with no
watching call: caption it "changed during this turn", never "changed by this turn".

### Overlap, resume, reconnect

- **Overlap:** turns are normally serialized, but a scheduled run, group turn or voice turn can share
  the workspace. Windows are half-open `[start, end)`; each observation belongs to the `turnId` on
  its frame. Journal keys are caller + turn (`turn-journal.mjs:8`, `:660`) — never key on session.
- **Turn spanning a reconnect:** the journal is the source of truth for the window
  (`turn-journal.mjs:17-21`); replay `/v1/turns/{id}/events` from the last seq, merge by `callId`, keep
  one record. If the frames carry no arguments for this backend, paths missed offline stay unknown —
  never reconstruct them.
- **Resumed session / old turn:** if the entry aged out, render "change history expired" and offer
  the session sheet. Never recompute from reloaded history — its tool args are gone
  (`opencode.mjs:125-127`, `claude-code.mjs:73-75`, `codex.mjs:61-71`).

---

## 3. Payload cap

Store **paths plus a diff reference plus counts**, never contents.

```
TurnChangeRecord {
  v: 1, turnId, sessionId, backendId
  startedAt, endedAt
  files: [{ path, status: 'added'|'modified'|'deleted'|'unknown',
            additions?, deletions?, evidence: 'diff'|'tool', callIds: string[] }]
  truncated: boolean, omitted: number
}
```

- No `content`, no `patch`, no raw `detail`, no tool output. A **diff ref** (`sessionId` + path) is
  resolved on demand through the existing route: the Gate caps patches at 200 KB *per session*
  (`server.mjs:94`, `:4721`) and marks overflow `too_large` (`:4722`), which the sheet already
  understands (`session-changes-sheet.tsx:67-69,77-79`).
- Per-turn record caps: 200 paths, 32 KB serialized, path <= 512 chars. Soft truncation:
  `truncated: true`, `omitted: N`, UI shows "and N more files".
- Local persistence: the journal's 7-day/300-turn horizon, LRU beyond it; a missing record degrades
  to "Changes are unavailable for this turn", never a guessed list. Paths are workspace-relative
  before storing, with absolute paths stripped so a home directory cannot ride into logs.

---

## 4. The UX contract

### In the thread

After an assistant turn that has evidence, one quiet row under the bubble:
`3 files changed · +42 −9` (OpenCode with diff) or `2 files touched` (Claude/Codex, or OpenCode
without snapshots). Tapping opens a **turn-scoped** sheet in the existing visual language
(`session-changes-sheet.tsx:51-84`): `TURN REVIEW` / `Changes in this turn`, one row per path, patch on demand.

Copy rules: "changed" + counts only with `evidence:'diff'`; "touched" + no counts for tool-only
evidence (caption "The backend reports tool calls, not a diff"); unsupported/empty states reuse
`session-changes-sheet.tsx:55-57,61`; no row for a turn with no write-like call — absence is never a zero.

### Approve / reject, later

Today nothing to approve: the sheet is explicitly read-only (`session-changes-sheet.tsx:60`), and
only OpenCode produces a diff at all (`opencode.mjs:1581-1624`). This design adds **no** buttons and
no wording implying reversibility. If it ever ships, the contract is: a per-file decision made before
the next turn, applied by the backend that owns the working tree, recorded by the Gate against
`turnId`. No backend exposes a pending/reversible change set today (Claude and Codex answer
`supported:false`, `server.mjs:4697-4700`), so the UI stays read-only until one does; that backend
feature is out of scope here.

---

## 5. Test strategy

Future code is one pure module, `src/lib/chat/turn-changes.ts`. Its only impure seams are the stream
reducer (where `detail` already lands, `chat-stream-delta.ts:220-232`), the journal fetch, and local
storage. Tests use fixtures only: no network, no device, no Gate process.

1. `extractFileEvidence({backend, name, detail}) -> {paths, kind, confidence}`
   Fixture table, one row per backend:
   - Claude `Write {file_path:'src/a.ts', content:'…'}` → `write` at `src/a.ts`; the assertion also
     checks the result has no `content` key.
   - Claude `Read` / `Grep` / `Glob` → `[]`; `Bash 'cat src/a.ts'` → `[]`.
   - Codex `exec 'echo x > src/a.ts'` → weak `write`; plain `exec 'ls src'` → `[]`.
   - OpenCode `edit` with truncated JSON in `detail` → `[]`, never a half-parsed path; Windows
     `C:\repo\src\a.ts` normalizes to `src/a.ts`; duplicate paths in one call collapse once.
2. `boundTurn({messages, journalMeta}) -> {turnId, startedAt, endedAt} | null`
   `finishedAt` wins; `running` uses `updatedAt`; no timestamps → `null` (no window, no attribution);
   reconnect replay yields one window; a first frame earlier than `startedAt` clamps to it.
3. `mergeTurnEvidence(observations, diffBefore, diffAfter) -> TurnChangeRecord`
   Truth table: tool + diff → `evidence:'diff'` + counts; diff only → diff row flagged unattributed;
   tool only → `evidence:'tool'`, `status:'unknown'`, no counts; deleted; rename as delete+add;
   missing `diffBefore` → all tool-only; duplicate `callId` merges; replay twice is byte-identical.
4. `capTurnChanges(record, {maxPaths:200, maxBytes:32*1024})`
   Exact boundary, multi-byte UTF-8 measured in bytes, deterministic order, `omitted` count.
5. `toTurnChangeSummary(record) -> {label, tone}`
   "1 file changed · +1 −0", "2 files touched", "Diff too large", "and N more"; never "+0 −0".
6. `serializeTurnChangeRecord` / `parseTurnChangeRecord`
   Round trip, schema mismatch dropped, corrupt record dropped, key whitelist proving
   `content`/`patch`/`detail`/`output` can never be stored.
7. Gate tests only for what exists: the 200 KB cap marks `too_large` (`server.mjs:4721-4726`) and
   the unsupported answer (`:4697-4700`). No test for a backend feature that does not exist.

Property test: every `path` in any record from (1)-(3) must occur in a write-like call's args or a
diff row — this catches a future "helpful" inference.

---

## 6. Risks

**Inventing data.** The largest risk. Tool names are not a contract: an MCP tool can write anything;
`Bash` can write with `>`, `tee`, `sed -i`, `git checkout`, or a build script; `Write` content may be
identical to the existing file (no actual change). A write-like call can also fail after touching the
file: Claude's `tool.output` forwards only `callId`/`isError` (`claude-code.mjs:104-110`), so the
record must keep it as `touched` either way and never assert success. Mitigations: evidence labels,
"touched" wording, no counts without a diff, ignore unparseable input, property test in section 5.
If in doubt, show less: a missing row is recoverable, a wrong "changed" is not.

**Leaking file contents into logs.** `Write`/`Edit` input carries whole files and `tool.output` can
carry source. `ChatToolCall.detail` already holds arg text in memory
(`types.ts:222`, `chat-stream-delta.ts:226-230`); OpenCode even replaces it with partial snapshots
while a call runs (`opencode.mjs:615-619`). The turn record must extract paths and discard the rest
before any persistence or analytics; no `detail` in logs, crash reports, or the Gate. The existing
diff route is the only place content is shown, and it is capped (`server.mjs:94,4721`).

**Mis-attributing another process's change.** An IDE save, a git hook, a build, a vendor-code
generator, a subagent, or the user can edit during the turn window. OpenCode's before/after snapshots
will include those. The copy must say "changed in this session during this turn", list evidence per
path, and promote to "this turn" only when a write-like call names the path *and* the diff shows it.
Even then it is corroboration, not proof of authorship. Claude and Codex have no diff at all, so
their rows can never rise above "touched".

**Truncated arguments.** `detail` may be a partial JSON snapshot (`opencode.mjs:615-619`); a path cut
in half must yield no row, and an unparseable call is rejected whole.

**Journal/args gaps.** Args are live-only; a resumed turn cannot recover them. Retention differs from
any local store. Both degrade to "unavailable", never to reconstruction.

**Cap starvation.** The 200 KB limit is session-wide (`server.mjs:94`), so an early large file can push
a later turn's patch to `too_large` (`:4721-4722`). The per-turn sheet must keep showing the file row
with "diff too large" (`session-changes-sheet.tsx:77-79`), not drop it.

**Scope creep into approval.** Users will ask to reject a file, but no backend has that primitive
(`server.mjs:4697-4700`); the note stops at read-only.

---

## Open questions

1. Ship "files touched" for Claude/Codex, or keep the sheet OpenCode-only? (Recommendation: touched, labelled.)
2. Device-local observations, or a Gate route keyed by `turnId`? Local suffices for one device.
3. Is one extra OpenCode diff call at turn start affordable, or corroboration best-effort at end?
