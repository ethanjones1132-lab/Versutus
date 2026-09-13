# Budgets with hard stops (2026-09-13)

Phase B item 5, `FUTURE-ITEMS.md` D5. **Verified state first:** no enforcing pre-run check
exists. The "caps" in `scorecards-section.tsx` (`botSpendCapCopy`) and `scorecard.ts` are
read-width and text budgets, not spend caps; nothing checks a Bot's spend before
`executeRun`. So this is a build.

## Shape

- **Where a cap lives:** this device's key-value storage, keyed gateway + Bot, the same
  discipline as P3's session labels. No gateway route carries a budget.
- **The ledger:** the spend read the app already folds (`readBotSpend` /
  `botSpendRows`) gives each Bot's `costUsd`.
- **The hard stop:** the run-start path (`runTask`, `gateway-provider.tsx`) checks the cap
  before `executeRun`. Over cap: the run does not start and names the reason.
- **Honest limit:** enforcement is client-side — it governs runs started from this app.
  A failed spend read is unknown, not "over", so it allows the run and says so; the cap is
  not a server quota and the copy says so.

## Steps

1. Failing Jest `__tests__/budgets-test.ts` for `src/lib/gateway/budgets.ts`:
   `budgetKey` (gateway + Bot, path-safe), `botBudget`/`setBotBudget` (a blank or
   non-positive cap clears the entry), `budgetsFromUnknown` (junk reads as none),
   `evaluateBudget` (under/absent/over, `overBy`, a named reason), and
   `checkBotBudget` (an unreadable spend read is allowed, not over).
2. Run it; it fails (module missing).
3. Implement `budgets.ts` (best-effort storage, like session labels).
4. Run green.
5. Wire the guard into `runTask` before `executeRun` (only when the client can read Bot
   sessions and the Bot has a cap), and add the per-Bot cap editor to
   `SpendPerBotSection` with an optional `budgets` + `onSetBudget` pair, fed from
   `src/app/gateway/spend.tsx`.
6. `npm run verify` EXIT=0; commit the plan, then the code.

## Acceptance

- **PENDING-DEVICE:** a Bot with a cap over its spend refuses a `/run` and names the cap;
  raising the cap lets the next run start.
