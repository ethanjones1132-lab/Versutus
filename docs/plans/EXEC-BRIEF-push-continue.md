# Execution brief — push on model final response (CONTINUING)

A prior run of this same task was interrupted mid-work. **G1 and G2 are already
done, tested, and verified — do not redo them, do not modify them.**

- `gate/core/push-tokens.mjs` + `gate/__tests__/push-tokens.test.mjs` — done, 11/11 passing.
- `gate/core/push-send.mjs` + `gate/__tests__/push-send.test.mjs` — done, 5/5 passing.
- Full `npm run verify` passes clean on the tree as it stands right now
  (468 suites, 4384 tests, 0 lint warnings in `gate`). If your first act finds
  otherwise, STOP and report — do not "fix" files outside your scope.

Execute the **remaining** steps of `docs/plans/2026-09-11-push-final-response.md`:

## Scope — implement ONLY these steps, in order

**GATE:** G3 (notifier), G4 (RPC on the paired device grant)

**APP:** A1 (tap router: add the `routine` kind and the new `reply` kind),
A2 (push-registration module), A3 (Android channels + foreground handler)

Import from G1/G2 (`push-tokens.mjs`, `push-send.mjs`) as the plan describes;
do not reimplement anything they already provide.

## Explicitly OUT of scope — do not implement

G5, G5b, G6, A4, A4b, A5, A6.

G5/G5b and A4/A4b depend on a `session.abort` RPC that does **not** exist on the
Gate. That is a separate, later slice — the operator has not asked for it yet.
Do not build that RPC, do not invent a substitute, do not work around it.

## Hard rules

- The plan is authoritative for the steps in scope. Do not redesign them.
- Each step lists its tests first. Write the tests, then the implementation.
- Gate tests: `cd gate && node --test __tests__/<file>`
- App tests: `npx jest __tests__/<file> --runInBand`
- After every step, run the **full** `npm run verify` — not just your new test
  file — before moving to the next step. It must stay green throughout. Never
  weaken a test, a lint rule, or the coverage ratchet to get green.
- If a test you write fails, first check whether the bug is in your test or in
  your implementation before concluding either. Do not paper over a failing
  assertion by loosening it without understanding why it failed.
- **Do NOT modify `package.json` and do NOT run `npm install`.**
- **Do NOT touch `README.md`.** That is step A6, deliberately last.
- Never describe this feature as "push" in any user-facing copy yet.
- If a step's premise is false — a file is not where the plan says, an API
  differs — STOP and report. Do not invent an API.
- Commit nothing. Leave all changes in the working tree.
- Touch only files the in-scope steps name, plus G1/G2's files as imports only.

## Report when done

Print a short summary: steps completed, files changed, test results, the final
`npm run verify` result, and anything you stopped on.
