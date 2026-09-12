# Execution brief — push on model final response (PARTIAL)

Execute **part** of the implementation plan at
`docs/plans/2026-09-11-push-final-response.md`.

## Scope — implement ONLY these steps, in order

**GATE:** G1 (token store), G2 (Expo send + receipts), G3 (notifier),
G4 (RPC on the paired device grant)

**APP:** A1 (tap router: add the `routine` kind and the new `reply` kind),
A2 (push-registration module), A3 (Android channels + foreground handler)

## Explicitly OUT of scope — do not implement

G5, G5b, G6, A4, A4b, A5, A6.

G5/G5b and A4/A4b depend on a `session.abort` RPC that **does not exist** on the
Gate today. That was verified. Those steps are a separate, later slice. Do not
build that RPC, do not invent a substitute, do not work around it. Stop at the
scope above.

## Hard rules

- The plan is authoritative for the steps in scope. Do not redesign them.
- Each step lists its tests first. Write the tests, then the implementation.
- Gate tests: `cd gate && node --test __tests__/<file>`
- App tests: `npx jest __tests__/<file> --runInBand`
- Then run `npm run verify`. It must pass. Never weaken a test, a lint rule, or
  the coverage ratchet to get green.
- **Do NOT modify `package.json` and do NOT run `npm install`.** Another agent
  owns dependency changes in this repo. Your steps need no new dependencies.
- **Do NOT touch `README.md`.** That is step A6 and is deliberately last, after
  the relay exists.
- Never describe this feature as "push" in any user-facing copy yet.
- If a step's premise is false — a file is not where the plan says, an API
  differs — STOP and report. Do not invent an API.
- Commit nothing. Leave all changes in the working tree.
- Touch only files the in-scope steps name.

## Report when done

Print a short summary: steps completed, files changed, test results, the
`npm run verify` result, and anything you stopped on.
