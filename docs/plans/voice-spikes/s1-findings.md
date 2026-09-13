# S1 findings — Codex realtime on the ChatGPT login (M1, 2026-09-13)

Capture: `s1-2026-09-13T06-31-13-883Z.jsonl`. Host: Windows 11, `codex-cli 0.147.0`,
`~/.codex/auth.json` `auth_mode: chatgpt`. Script:
`scripts/voice-spikes/s1-codex-realtime.mjs`. Both runs used the same synthetic
1 s 440 Hz tone at 24 kHz and 16 kHz.

## Headline

**Codex realtime does not run on the ChatGPT login.** The feature flag is required,
and with it `thread/realtime/start` resolves an empty result, but the conversation
is never prepared: the server emits `thread/realtime/error`
`"realtime conversation requires API key auth"` and a `codex_core::realtime_conversation`
diagnostic of the same. No `thread/realtime/started` notification ever arrives.

## Q1 — Does realtime start on the login, and is the flag required?

| Config | `thread/realtime/start` | Conversation |
|---|---|---|
| without `-c features.realtime_conversation=true` | error: `thread … does not support realtime conversation` | never starts |
| with `-c features.realtime_conversation=true` | resolves `{}` | `thread/realtime/error`: `realtime conversation requires API key auth` |

- The flag **is** required (without it the thread cannot do realtime at all).
- With the flag, startup is refused at the auth check. **No `thread/realtime/started`.**
- A `warning` notification confirms the flag enables an under-development feature.
- **Verdict: FAIL.** The ChatGPT subscription does not satisfy app-server realtime
  in 0.147.0; it is API-key-only. Mapping for `voice.capabilities`: `unavailable`
  (reason: "Codex realtime needs an API key; the ChatGPT login does not provide one"),
  not `over-allowance`.

## Q2 — Input rates and output format

- `thread/realtime/listVoices` succeeds: v1 `[juniper, maple, spruce, ember, vale,
  breeze, arbor, sol, cove]` (default `cove`); v2 `[alloy, ash, ballad, coral, echo,
  sage, shimmer, verse, marin, cedar]` (default `marin`).
- Input rate acceptance and output `sampleRate` are **UNKNOWN** — the conversation
  never ran, so `appendAudio` had nothing to accept (server logged "conversation is
  not running").

## Q3 — Delegation shape and `appendSpeech` fidelity

**UNKNOWN.** No conversation, so `clientManagedHandoffs` produced no delegation and
`appendSpeech` had no session ("failed to append realtime speech: conversation is
not running").

## Q4 — Can the model be kept from answering on its own?

**UNKNOWN.** No audio was produced at all.

## Q5 — Latency

- `thread/realtime/listVoices`: ~6 ms.
- `thread/realtime/start` request → error: ~8 ms.
- End-of-speech → transcript and `appendSpeech` → first audio: **UNKNOWN**.

## Q6 — What arrives when voice is unavailable or over allowance?

`thread/realtime/error` `{ "message": "realtime conversation requires API key auth" }`,
plus `codex_core::realtime_conversation: failed to prepare realtime conversation:
realtime conversation requires API key auth`. This is an auth/availability failure,
not an allowance failure. The `codex` engine's capability probe must report
`unavailable` for a ChatGPT-mode login.

## Consequence for the plan

Per decision 3 (§10): the `codex` engine **does not ship as a Bot voice** on this
build. The Gate-provider path's flagship is the `local` engine (M5); the `phone`
engine stays the fallback. M3 is not buildable as written unless Codex later
supports ChatGPT-login realtime over app-server; the capability probe (M3 task 3.4)
should be reduced to reporting this state and the engine being disabled.

## Repro

```
node scripts/voice-spikes/s1-codex-realtime.mjs
```
