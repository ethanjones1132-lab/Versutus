# Versutus voice

How Versutus talks on screen. Every user-facing string — labels, empty states,
errors, confirmations, accessibility labels — follows this page. The visual
language lives in `docs/design-language-nocturne-2026-09.md`; this is the same
discipline applied to words.

The goal is the voice of a well-funded team: calm, specific, and never wider
than the screen.

## The seven rules

1. **Calm, not theatrical.** "Can't reach your computer." Never "Connection
   lost!" or "Oops!".
2. **What happened, then one next step.** "Couldn't connect. Check the address
   and key, then try again." One instruction, not every possible failure.
3. **Only claim what is known.** "Connected" means the transport is up. It never
   implies a model will answer. An unknown readiness is not a warning — say
   nothing rather than narrate the unknown.
4. **The operator's words, not ours.** No acronyms, environment variables, ids
   or versions in the main view. Technical detail lives behind "Details",
   Diagnostics, or a copyable block.
5. **Warmth is for greetings.** "Good evening." never appears in an error, an
   approval, or a security explanation.
6. **Say it once.** One instruction per state. Helper text that repeats the
   empty state below it is a defect.
7. **Write for 375 px.** Labels are two to four words; help is one sentence.

## Term map

Internal term → what the screen says.

| Internal | On screen |
|---|---|
| gateway (the thing) | your computer, or **Versutus Gate** when naming the product |
| gateway profile | saved gateway |
| API key / `API_SERVER_KEY` | gateway key |
| RPC | commands |
| capability | feature |
| manifest | setup details |
| endpoint | address |
| listen key | kept out of the main view (the roster shows "No listen key" on the Bot) |
| session | conversation |
| routine | scheduled task |
| pairing | approve this phone |
| token | access key (technical view only) |
| profile | **Bot** (never "profile" alone) |

**Bot** stays as it is. "Agent" and "profile" are not used on screen. See
`CONTEXT.md` for the domain meaning behind each term.

## Patterns

- **Error:** `[what happened]. [one next step].` Keep the values the operator
  entered. Field errors sit next to the field.
- **Empty:** what is missing, and the one action that fills it.
- **Loading:** a short verb — "Connecting to Atlas…" — never the internal
  sequence.
- **Confirm:** name the object and the consequence; buttons name outcomes
  ("Remove", not "OK").
- **Destructive:** say what is deleted and whether it comes back.

## Deliberately kept

The roster already had the voice to match, and these stay:

- "Good evening"
- "Your team"
- "Talk to any model, no Bot in between"

## Checking it

`__tests__/copy-guard-test.ts` fails on `API_SERVER_KEY`, `RPC`, `vshowcase`, a
dangling `" - "` separator, or the word "profile" in the user-facing strings of
the priority screens. Add a screen to its list when it joins the priority set —
the guard is only as wide as the list.
