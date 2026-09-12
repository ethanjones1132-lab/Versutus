# Execution brief — Android widget

Execute the implementation plan at `docs/plans/2026-09-11-android-widget.md`.

Work through its numbered steps in order. That plan is authoritative: its approach
was reviewed and approved. Do not redesign it and do not substitute a different
approach.

## Hard rules

- Implement ONLY what that plan specifies. No extra refactoring, no unrelated
  cleanup, no drive-by fixes.
- After code changes run `npm run verify` (tsc --noEmit, lint, jest + coverage
  ratchet, gate tests). It must pass. If it fails, fix the cause — never weaken a
  test, a lint rule, or the coverage ratchet to get green.
- Do NOT run `expo prebuild`. Do NOT run gradle. Do NOT build an APK. Stop before
  device verification and report; the operator runs those steps.
- If a step's premise turns out to be false — a file is not where the plan says,
  an API differs, a package version does not exist — STOP and report what you
  found. Do not invent a replacement API and do not work around it silently.
- Commit nothing. Leave all changes in the working tree.
- Another agent may be working in this repo. Touch only files this plan names.

## Report when done

Print a short summary: which steps completed, which files changed, the
`npm run verify` result, and anything you had to stop on.
