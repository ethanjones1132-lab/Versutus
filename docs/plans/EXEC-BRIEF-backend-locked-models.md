# Execution brief — backend-locked model selection

Execute the implementation plan at
`docs/plans/2026-09-11-backend-locked-model-selection.md` in this repo.

Work through its 7 numbered steps in order. That plan is authoritative — it
was written after reading the actual code (not assumed), reviewed, and
approved. Do not redesign it and do not substitute a different approach. Its
"Decision" section explains why (client-side filter, no Gate change) — read it
before starting so you don't re-litigate a settled call.

## Hard rules

- Implement ONLY what that plan specifies. No extra refactoring, no unrelated
  cleanup, no drive-by fixes.
- Each step names its own verification — run it as you go, not only at the end.
- After all 7 steps, run the **full** `npm run verify` (config, `tsc --noEmit`,
  lint, Jest with the coverage ratchet, gate tests). It must pass. Never
  weaken a test, a lint rule, or the coverage ratchet to get green — the plan
  itself says the new test file should move the coverage ratchet the right
  way, not need it loosened.
- **Do NOT modify `package.json` and do NOT run `npm install`.** No new
  dependency is needed for any of these 7 steps.
- **Do NOT touch `gate/core/server.mjs` or any Gate protocol.** The plan's
  "Out of scope" section is explicit: this is an app-side-only fix.
- **Do NOT change `selectBackend`, `effectiveModel`, `withSelectedModel`, or
  `staleModelPin` semantics** — the plan documents why they are already
  correct and only need to be read, not modified.
- No backend-name branching anywhere. Capability gating stays exactly on
  `capabilitiesForBackend` (advertised capability), never a hard-coded
  "hermes" or "opencode" string.
- If a step's premise turns out to be false — a line number has drifted, a
  function signature differs from what the plan quotes — STOP and report
  exactly what you found. Do not invent a replacement approach.
- Commit nothing. Leave all changes in the working tree.
- Another workstream's files may show as already modified in `git status`
  (widget, push notifications) — those are unrelated completed work, not
  yours to touch or worry about. Touch only the files this plan's 7 steps name.

## Report when done

Print a short summary: steps completed, files changed, test results (including
the new `__tests__/backend-locked-models-test.ts`), the full `npm run verify`
result, and the manual-repro steps from "Final verification" that you were
able to confirm by reading/testing versus what needs a live two-backend Gate
to actually exercise by hand.
