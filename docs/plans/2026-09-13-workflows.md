# Workflows — design and first slice (2026-09-13)

Phase B item 12. `FUTURE-ITEMS.md` ("Runs become Workflows") blocks the Activity/cron work
and was blocked by the slash-command regression, now fixed. This is the design, settled
before any build, with the first TDD slice named.

## Decisions

- **What a Workflow is.** A named, ordered list of steps: `Workflow { id, name, steps }`,
  each `WorkflowStep { id, prompt, botId? }`. A step is a run prompt for a Bot, so execution
  reuses the existing `/run` path rather than inventing a second executor.
- **Where they live.** App-side key-value storage per gateway
  (`versutus:workflows:<gatewayId>`), the P3/D5 discipline: no gateway route carries a
  workflow, and `/run` is already dispatched from the app. Per-gateway, not fleet-wide —
  a workflow names Bots that live on one gateway.
- **How a slash command references one.** `/workflow` lists; `/workflow <name>` runs the
  steps in order. Parameters: a step prompt may contain `{{input}}`, replaced by the text
  after `<name>`. This is the "reference and re-invoke" the item asks for.
- **What happens to runs.** `ActivityRun` history and `botId` attribution stay persisted;
  only the Activity *surface* changes (next item). `lib/fleet/scorecard.ts` keeps reading
  the same history.
- **Honest limits.** A workflow runs steps sequentially, client-side; a step's failure stops
  the workflow and names itself. It is not a server-side job and does not claim to be.

## Slice 1 (this session) — the definition and its store, pure

1. Failing Jest `__tests__/workflows-test.ts`: `workflowsFromUnknown` (junk reads as none,
   steps validated), `createWorkflow` (trimmed name, non-empty steps, unique id via an
   injected `makeId`), `renameWorkflow`/`deleteWorkflow`, `findWorkflow` by name (trimmed,
   case-insensitive), `applyWorkflowInput` (`{{input}}` substitution, no input leaves the
   placeholder), `workflowSummaryCopy`, and best-effort load/save per gateway.
2. Run it; it fails (module missing).
3. Implement `src/lib/gateway/workflows.ts`; run green.
4. `npm run verify` EXIT=0; commit.

## Slice 2 (next) — `/workflow` dispatch

`slash-commands.ts` gains `/workflow` (list) and `/workflow <name> [input]` (run the steps
through `context.runTask`, stopping at the first failure), with a source pin. No new
executor.

## Slice 3 (next) — Activity becomes cron

Remove run information from the Activity surface and make it a cron view, after Slice 2, so
the scorecard's persisted-history source is untouched.

### Slice 3a — hide the run surface (this session)

The Activity tab's first read is now scheduled work: `CronSection` is always on the tab, and
the run list, the start-a-run card and the post-run scorecards are hidden behind an explicit
"Show runs" control (default hidden). Nothing is deleted: `ActivityRun` history and its
`botId` attribution stay persisted, `lib/fleet/scorecard.ts` keeps reading the same history,
and every run-history component and test stays in the tree. Extraction of the run surface to
its own `/runs` destination is slice 3b.

1. Failing Jest `__tests__/activity-cron-view-test.ts`: the tab carries `showRuns` default
   false, the FlatList's data is the run rows only while `showRuns`, the start card is gated
   on `showRuns && runsSupported`, the scorecards are gated on `showRuns`, `CronSection` is
   rendered unconditionally, and a "Show runs" / "Hide runs" control flips it.
2. Run it; it fails (`showRuns` absent).
3. Implement the gate in `src/app/(tabs)/activity.tsx`.
4. Run; green. `npm run verify` EXIT=0; commit. Device/manual acceptance is PENDING-DEVICE.

## Acceptance

- **PENDING-DEVICE:** define a workflow, run it by name from the composer, and see its steps
  run in order.
