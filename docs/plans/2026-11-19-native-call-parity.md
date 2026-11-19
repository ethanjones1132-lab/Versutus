# Native call parity

Ethan’s decision overrides D3 in the November 7 bar: “a hands-free call is just another input and output channel into the same agent session as typed chat.” Do not disable capabilities or refuse a turn because the backend cannot ask for every action. Do surface the backend’s requests, use the 30-second Gate deadline, and record the outcomes.

- Route both call engines through the normal scoped adapter. Keep the voice marker at the Gate and pass it upstream where the transport accepts it. Regression checks compare session, model, text and tool settings.
- Keep the native permission wires and register only voice-specific decision context. Check that a native request waits and that approve, deny and expiry are recorded.
- Stop manufacturing notices or history for native turns. Register media grants before connect; reconcile projected rows against newly persisted history, never an older identical turn.
- Use a phone-free harness on the real Gate to verify the same thread and its timing. Compare warm worker synthesis separately from model latency. Check the actual handset attach and playout on A54.

Edit-only in this checkout; no tests, builds, Git or live backend requests in the editing session. Keep existing operator configuration and the published Hermes range until the coordinator verifies the PC’s authenticated v0.23 path.

## Native paths and limits

| Backend | Send and permission path | Reference |
|---|---|---|
| Hermes | Use the existing profile’s `/v1/chat/completions` SSE with `X-Hermes-Session-Id`. On an approval event, respond on that profile’s `/v1/runs/{id}/approval` with `once` or `deny`, including the canonical request ID and execution generation when supplied. No extra request in front of the prompt. A valid native request is the per-turn indication that it can be bridged. | [v0.23 API](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/website/docs/user-guide/features/api-server.md), [approval settings](https://hermes-agent.nousresearch.com/docs/user-guide/security/#approval-modes), [ACP toolset](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/#what-hermes-exposes-in-acp-mode) |
| OpenCode | Use the normal server’s agent selection, model catalog and session. The event feed parks on `permission.asked`; the Gate answers the exact session/request with `once` or `reject` after a tap or expiry. | [V2 API](https://opencode.ai/docs/api#tag-permission), [Gate’s V1/V2 wire notes](../opencode-backend-contract.md) |
| Codex | Preload the original thread with `thread/resume`, start with its own approval/sandbox settings, and answer the app-server’s exec and patch requests. A permissions grant is turn-scoped. | [App Server](https://developers.openai.com/codex/app-server/#approvals), [thread/start and resume](https://developers.openai.com/codex/app-server/#start-or-resume-a-thread) |
| Claude Code | Use one `--print` child per turn, as typed chat did before parity. Both channels resume the same transcript with `--resume` or bind a new reservation with `--session-id`, keeping the same agent, model, settings and MCP tool. The Gate shares one permission listener per environment and gives voice turns their own short-lived endpoint credentials. A normal result is only final once the process exits and stdout is drained. | [CLI resume](https://code.claude.com/docs/en/headless#continue-conversations), [permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions) |

ACP has separate toolset selection and cannot be assumed to attach to an API-owned transcript with the same gateway model. Hermes manual mode is not “ask on all writes”; a regular `write_file` may not ask at all. Similarly, OpenCode allow rules, Codex in-policy operations and Claude Code auto-approved calls do not become approval requests because the user is on a call. Gate does not install policies or fall back to a weaker agent to catch these cases.

## Coordinator

1. Run the edit-only validation suite: `npx tsc --noEmit`, `npm run lint`, `npx jest`, `npm run test:gate`, `npm run test:voice-worker`, and the Kotlin unit tests.
2. Stop the normal Gate service (leave the native Hermes/OpenCode gateways reachable). The harness starts the checkout Gate on loopback using the normal Gate home and acquires its instance lock. Pass a disposable **existing native chat** for each backend; the named Bot’s `Bot Chat` is used when `--session` is omitted and that exact title is found.
3. Run once for each of `hermes`, `opencode`, `codex`, and `claude-code`. Use `codex` for `--bot` on a configurable Codex thread. Add `--backend-id` if several configured environments match, and `--model` only if the typed composer would send it:

   ```text
   node scripts/voice-live-backend.mjs --backend hermes --bot BOT --session SESSION --typed-baseline --text "Reply in one sentence containing Northstar." --expect Northstar
   ```

   Repeat without `--typed-baseline` to measure a cold backend. The baseline submits a real typed turn before the call; do not point this at a conversation you do not want to change.
4. In a disposable workspace that asks for the chosen tool, run the three outcomes (each run makes a fresh directory inside an existing scratch root):

   ```text
   node scripts/voice-live-backend.mjs --backend hermes --bot BOT --session SESSION --approval-test --scratch-root SCRATCH --decision deny
   node scripts/voice-live-backend.mjs --backend hermes --bot BOT --session SESSION --approval-test --scratch-root SCRATCH --decision expire
   node scripts/voice-live-backend.mjs --backend hermes --bot BOT --session SESSION --approval-test --scratch-root SCRATCH --decision approve
   ```

   Repeat for the other adapters with their native ask policy. When ordinary file creation does not ask, use `--text` to name a *single* native tool that is already configured to ask for this harmless write, e.g. a disposable `trust: untrusted` write-capable MCP fixture on Hermes’s gateway. Do not approve unrelated actions. If nothing asks, the harness fails and reports whether the marker already exists; it never counts “the model didn’t try” as a denial pass. The first PCM in approval runs may be the approval prompt; use ordinary replies for reply-audio latency.
5. Before claiming Hermes v0.23 support, on the actual named profile check authenticated `GET /v1/capabilities` for `features.approval_events` and `endpoints.run_approval`; run the tagged v0.23 smoke and all three outcomes above. Verify a real SSE approval is emitted from `POST /v1/chat/completions` and the POST to its profile’s run approval endpoint accepts the wire identity. Verify the working model and both native history rows. Do not widen the advertised range on the strength of the fake.
6. Compare `voice.tts` `workerQueueMs`, `synthToPcmMs`, and `effectToWorkerPcmMs` with commit-to-PCM. The incident’s Hermes engine was ready after 208 ms at attach (about nine seconds before commit), and device playback followed first PCM by roughly 14 ms. The 20.3 s was between asking for speech and getting PCM from the Gate, not the quiet backend’s time to first token or the phone’s playback delay. The old logs cannot distinguish worker queue/CPU contention, Kokoro synthesis, or stdio delay. Warm-up precedes `voice.ready`; the new timings split those intervals on the next run.
7. On A54, open consecutive calls on the same and different threads; confirm `t=call` sequence one is folded without an `expected=1 got=2` gap. Call, tap Approve/Deny, let a request expire, check the spoken prompt and expiry, hang up, and compare the chat against the conversation. Check both PC audio and phone-engine calls; measure real microphone EoS to audible playback, barge-in and reconnect with the handset.
