# CHARTER — Versutus sprint 2026-09-23-ui-overhaul

Read every iteration. **Outranks BACKLOG, ROADMAP, and prompts.**

## Mission (CORRECTED 2026-09-24)

Ship the **structural** ChatGPT/Claude/Grok-class shell locked in `docs/visual-direction-2026-09.md`, as corrected by `docs/ui-audit-claude-2026-09-24.md`.

Palette landing was necessary and is largely done. **Recolour is not the mission anymore.** Peers look expensive because they remove chrome. We restructure Chat (messages, composer, header, stage, sheets) so Versutus does the same.

North star: dark quiet stage; **assistant text is the hero**; chrome disappears; ≤3 taps from Chat.

## Priority order (each turn — top Ready item that fits)

1. **Message layout** — assistant unboxed on stage; user soft grey no border; tools/thinking → one quiet expandable line
2. **Pill composer** — single pill; `+` left; mic→send; no chip row / floating terminal on thread
3. **One-row header** — back · title+model subtitle · one menu
4. **Strip background + borders** — flat stage; widen surface steps; delete drifting art; drop hairline-everywhere
5. **Swipeable sheets** — grab handle + dismiss gesture on BaseSheet
6. **Only after human decides** — drawer / kill bottom tabs
7. Residuals: plain-language copy, secondary text AA (`#8A8F98`), avatar≠status mint, Regular 400 body, 150–250ms fade+rise motion

## Explicit non-goals / forbidden

- **Any** “read X as brand violet” / residual recolour iteration
- ErrorCard-only / honesty-only unless ship-blocker
- New product surfaces / feature families
- Shipping metallic gold until distinct from warning amber
- Weakening the verify gate
- Touching free-mimo checkout (PAUSED) or Daedalus

## Base

- Branch `sprint/2026-09-23-ui-overhaul`
- Worktree `/Users/charlottehughes/code/Versutus/.worktrees/ui-overhaul`
- Sprint is **PAUSED** as of 2026-09-24 ~21:50 ET pending backlog rewrite to this charter
- Never push `master`. Never merge without human ask.

## Git ownership (CRITICAL)

- Model never runs `git commit`, `git push`, `git add`, `git reset`, or `git rebase`.
- Driver owns staging, verify, commit, push.
- Edit files. Write `.sprint/SUBJECT.txt`. Stop.

## Gate

- `bash .sprint/verify-gate.sh` → `EXIT=$?` (never pipe). Must be 0.
- Never weaken: no skip, no eslint-disable abuse, no deleted tests, no lowered coverage.

## Shape

- One BACKLOG item per commit, scoped to the structural priorities above.
- Prefer multi-file work **within one item’s stated scope**.
- Evidence with `file:line` from this worktree.
- Visual check: prefer `/dev/audit` mock or native; note `/dev/preview` web crash (`Keyboard.metrics`) is known on master.

## Models / ladder

- Iterate: `opencode/mimo-v2.6-flash-free` → space-bunny → OpenRouter free
- Seed/refill audit: DeepSeek V4.1 Flash via Hermes (operator-run) — must seed **structural** Ready items from this charter, not violet residuals
