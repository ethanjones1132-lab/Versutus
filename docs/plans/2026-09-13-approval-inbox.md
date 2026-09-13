# D1 — Approval inbox with policies and audit

Operator continuation 2026-09-13 08:01 item 1: build the missing Gate substrate,
then the app surface, one slice at a time. Fail closed (ADR 0008 discipline).

Today the Gate has a per-environment `ApprovalService` (`approvals.mjs`) that
holds pending approvals and a risk **class**, but nothing lists them over RPC and
the class never reaches the app: `runTask`'s `onApprovalRequired(runId, prompt)`
carries the run **prompt** (`runs.ts:42`). The app can only decide an approval it
happened to hold open, so there is no inbox and no policy.

## Slices

### Slice 1 — Gate: pending-approval list and class (node tests)

Files in play:
- `gate/core/cli-environments/approvals.mjs` — `ApprovalService` gains `list()`
  and a `createdAt` stamp; every pending row carries its class (`type`),
  `runId`, `environmentId`, `operation` and the one-line `summary`.
- `gate/core/cli-environments/supervisor.mjs` — `requestConsent` passes
  `runId` + the `APPROVAL_SUMMARY` line into `normalize`.
- `gate/core/approvals/rpc.mjs` (new) — `createApprovalRpc({ approvals })`:
  - `approvals.pending` (paired device required) → `{ approvals: [...] }` with
    the public row shape (never the raw request bag).
  - `approval.approve` / `approval.deny` (paired device required) → decide by
    `approvalId`; unknown id is `404 unknown_approval`, absent id is
    `400 invalid_request`.
- `gate/core/server.mjs` — build `approvalRpc` from `environmentService.approvals`
  and spread `approvalRpc.methods` into `gatewayMethods`, so the manifest
  advertises `approvals.pending` / `approval.approve` / `approval.deny`.
- `gate/__tests__/approval-rpc.test.mjs` (new) — red first:
  1. `approvals.pending` returns a pending entry with its class and summary.
  2. deciding through `approval.approve` resolves the waiting run.
  3. `approval.deny` fails closed for an unknown class/id.
  4. a read-only operation never appears (auto-approved, never pending).
  5. the list never exposes the raw `request` object.

### Slice 2 — App: policy engine + durable audit (pure, jest)

Files in play:
- `src/lib/gateway/approval-policy.ts` (new):
  - `APPROVAL_CLASSES`, `normalizeApprovalClass(raw)` — map the Gate's
    `type`/`action`/`risk` strings; anything unrecognized is `unknown`.
  - `AUTO_APPROVABLE_CLASSES = ['read']` — **only** read-only may be auto-approved.
  - `approvalPolicyKey`, `approvalPoliciesFromUnknown`, `loadApprovalPolicies`,
    `saveApprovalPolicies`, `setApprovalPolicy` — opt-in per gateway + Bot,
    key-value storage, mirroring `budgets.ts`.
  - `approvalPolicyDecision({ policy, class, botId })` → `{ decision: 'approve' |
    'ask', reason }`. Fail closed: no policy → ask; destructive/unknown/callback
    classes → ask; only an explicit per-Bot opt-in auto-approves `read`.
  - `approvalAuditFromUnknown`, `loadApprovalAudit`, `recordApprovalDecision`,
    `approvalAuditCap` — durable decisions (class, Bot, decision, source),
    newest first, capped.
- `__tests__/approval-policy-test.ts` (new) — red first: class normalization,
  unknown fails closed, read auto-approves only when opted in, a destructive
  class never auto-approves even when opted in, audit round-trips and caps.

### Slice 3 — App: surface + wiring

Files in play:
- `src/lib/gateway/approvals.ts` (new) — pure row shape from
  `approvals.pending` (`approvalRowsFromUnknown`) and the inbox copy.
- `src/context/gateway-provider.tsx` — `onApprovalRequired` learns the class
  (`event.data.action`/`risk`) and consults the policy: an opted-in read-only
  class resolves immediately through the existing resolver and records an audit
  line; everything else shows the card and records the decision. Expose
  `pendingApprovals` (Gate list) + `refreshPendingApprovals` + `decideApproval`.
- `src/components/activity/approval-inbox.tsx` (new) — lists the Gate's pending
  approvals with their class and summary, with Approve / Deny per row; renders
  nothing when the method is unavailable.
- `src/app/(tabs)/activity.tsx` — mount the inbox above the run-approval card.
- `__tests__/approval-inbox-test.ts` (new) — row parsing + copy + a source pin
  that Activity mounts the inbox.

## Verification

`npm run verify` (`FINISHED verify EXIT=0`) before every commit; single gate
test with `cd gate; node --test "__tests__/approval-rpc.test.mjs"`.

## Honest limits

Enforcement is client-side and advisory: the Gate's own `ApprovalService`
auto-approves only `read`, and the app's policy can only ever *add* decisions for
the one class the Gate already treats as safe. The inbox covers approvals the
Gate holds (CLI environment runs); chat-adapter approvals remain per-run until a
backend reports a class on the run-status contract.
