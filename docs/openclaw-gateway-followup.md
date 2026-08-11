# OpenClaw Gateway Follow-Up Backlog

Date: 2026-06-21
Workspace: `C:\Users\ethan\Versutus`

## Purpose

This document captures the remaining work after the initial OpenClaw gateway connection, Home dashboard, and chat slash-command integration. It is intended as the follow-up implementation checklist for making the gateway feel seamless, compact, and fully integrated into the chat-first Versutus experience.

## Current Implemented State

- Gateway connection and pairing now use the stored device token path rather than repeatedly asking for a setup token.
- Home has moved toward a post-onboarding gateway dashboard with saved gateways, active gateway state, reachability, and capability groups.
- Chat has a slash-command execution path through `sendChatInput`.
- Chat composer shows compact slash suggestions once the user types `/`.
- Chat slash commands now create compact local command messages with running, complete, and error states.
- Slash command messages can expose expandable raw JSON details when a command returns structured gateway data.
- Slash command results now prefer compact command-specific summaries for health, status, sessions, channels, usage, cost, stability, logs, model auth, plugins, approvals, memory, skills, environments, and cron.
- Raw slash command details now scroll inside the chat bubble so large gateway responses do not break the compact view.
- `/models` now supports compact filters such as `available`, `all`, `provider <name>`, and `search <query>`.
- `/model set` and `/model fallbacks` now show diff-style previews before writes and validate requested model IDs against `models.list` when the gateway can respond.
- `/model routing`, `/model agent <id>`, and `/model set-agent <agent-id> <model-id>` are now available for model routing and per-agent model configuration from Chat.
- The Tools tab is now focused on the live shell and no longer duplicates curated Gateway RPC or Agent command panels.
- The Chat composer placeholder now advertises `Message or /command`.
- A gateway command smoke harness is available at `npm run smoke:gateway-commands`.
- The slash-command registry includes:
  - `/help`
  - `/health`
  - `/status`
  - `/sessions`
  - `/channels`
  - `/usage`
  - `/cost`
  - `/stability`
  - `/logs`
  - `/models`
  - `/model`
  - `/model auth`
  - `/model routing`
  - `/model agent <agent-id>`
  - `/model set <model-id> --confirm`
  - `/model set-agent <agent-id> <model-id> --confirm`
  - `/model fallbacks <ids> --confirm`
  - `/config`
  - `/config <path>`
  - `/config schema [path]`
  - `/plugins`
  - `/approvals`
  - `/memory`
  - `/skills`
  - `/env`
  - `/cron`
  - `/agent status`
  - `/stop`
  - `/rpc <method> [json]`
- Home command execution was removed, so Home is closer to gateway state and capability visibility rather than a command launcher.
- TypeScript validation passed with `npx tsc --noEmit`.
- The local web route `http://localhost:8083/chat` returned HTTP 200 during smoke testing.

## Audit Findings

### P1: Tools Still Duplicates Gateway Commands

Status: completed in Phase 1.

The Tools screen previously exposed explicit command panels:

- `Gateway RPC`
- `Raw request`
- `Agent commands`

This conflicts with the product direction that gateway commands should live naturally in the Chat window. Home no longer has the quick-command panel, but Tools still behaves like a second command center.

Follow-up:

- Keep `/rpc` in Chat as the raw gateway escape hatch.
- If advanced diagnostics return to Tools later, keep them read-only and clearly separate from curated commands.

### P1: Slash Command Messages Are Local-Only

Slash command results are appended locally to the chat message list. They are not persisted to gateway chat history. A history reload can remove those command messages.

Follow-up options:

- Persist command messages to the gateway session as app/system messages if OpenClaw supports it.
- Add an app-side local command transcript store keyed by gateway/session.
- If intentionally ephemeral, render them as ephemeral command output with clear UI treatment.

Recommended:

- Persist a compact command event locally first.
- Later add gateway-side persistence if an appropriate OpenClaw method exists.

### P1: Not All Commands Were Live-Smoked

Status: partially completed in Phase 2.

The command registry was built from the advertised OpenClaw method descriptors and targeted handler inspection. A bounded smoke harness now exists, but the live Windows OpenClaw CLI gateway call path timed out for every safe method in the current shell validation run.

Follow-up:

- Re-run `npm run smoke:gateway-commands` once the live gateway call path is responsive from this shell.
- Verify method params and result shapes for every safe command in Chat after the CLI smoke is green.
- Mark commands as `verified`, `unverified`, or `experimental`.

### P2: No Busy State For Slash Commands

Status: completed in Phase 1 for the primary Chat flow.

Slash commands now create a local pending command message and block overlapping slash-command sends while the command is running.

Follow-up:

- Consider adding cancellation for long-running non-agent commands.
- Consider showing command duration and retry affordances.

### P2: Model List Formatting May Be Expensive

Status: completed in Phase 1 for filtering and extended in Phase 2.

The `/models` formatter now filters by known fields before raw JSON is generated for expandable details.

Completed:

- `/models available`
- `/models all`
- `/models provider <provider>`
- `/models search <query>`

### P2: Lint Is Not Clean

`npm run lint` now runs after Expo configured ESLint, but fails on existing lint issues:

- React set-state-in-effect rule in Chat.
- React set-state-in-effect rule in Terminal.
- Reanimated shared-value immutability warnings.
- Existing preview chip shared-value immutability warnings.
- Web color scheme hydration effect.
- Gateway reachability effect.
- One unused import in message bubble.
- Array type style warnings.

Follow-up:

- Decide whether to adopt the Expo-generated ESLint config as authoritative.
- Fix lint in a dedicated cleanup pass.
- Avoid mixing lint cleanup with gateway feature work unless the lint issue blocks a release.

### P3: Composer Placeholder Does Not Advertise Commands

Status: completed in Phase 1.

The chat composer placeholder now says `Message or /command`.

Follow-up:

- Add a small command affordance button if visual density allows.

## Remaining Gateway Features And Integrations

### Chat Command Integration

- Move all curated command execution into Chat.
- Remove duplicate command panels from Tools.
- Add slash-command loading/error states.
- Add slash-command result persistence or explicit ephemeral treatment.
- Add command output cards or compact formatted views.
- Add expandable raw JSON per command result.
- Add command aliases and fuzzy discovery.
- Add command history/autocomplete.
- Add confirmation UI for write/destructive commands instead of requiring only `--confirm`.
- Add permission-aware unavailable states in `/help`.

### Gateway Capability Catalog

- Replace static capability counts with a live descriptor snapshot.
- Surface missing scopes, unavailable methods, and warmup states.
- Distinguish:
  - supported by gateway
  - available to current device scope
  - currently healthy
  - not configured
  - experimental
- Add capability groups for:
  - Chat
  - Agent
  - Terminal
  - Sessions
  - Channels
  - Approvals
  - Config
  - Plugins
  - Logs
  - Voice/Talk
  - Diagnostics
  - Models
  - Cron
  - Environments
  - Skills
  - Artifacts
  - Tools
  - Devices
  - Nodes

### Gateway Management

- Verify add/select/delete gateway flows on web and native variants.
- Make deleting active gateway disconnect and clear active state without silently activating another gateway.
- Ensure selecting a gateway activates it without routing to Chat.
- Add gateway rename/edit from Home.
- Add gateway token/pairing repair action.
- Add gateway export/import if multiple devices will share profiles.
- Add stale gateway cleanup UX.

### Reachability And Health

- Keep inactive gateway probes timeout-bounded.
- Cache probe results with visible `checkedAt`.
- Add manual refresh per gateway.
- Distinguish HTTP health reachability from WebSocket auth readiness.
- Add warmup handling for OpenClaw health/status lag.
- Add better errors for:
  - unreachable host
  - gateway reachable but auth rejected
  - gateway reachable but pairing required
  - gateway warming
  - Tailscale Serve reachable but backend down

### Pairing And Device Auth

- Add in-app device approval flow if OpenClaw exposes safe device pair methods.
- Show approved scopes and role after pairing.
- Add scope upgrade request handling.
- Add expired/revoked token repair path that does not ask for another setup token when a stored token is still valid.
- Add a pairing/debug command such as `/device`.
- Add local device identity display in Settings and Chat diagnostics.

### Sessions

Currently implemented:

- `/sessions` calls `sessions.list`.

Still missing:

- `/session current`
- `/session get <id>`
- `/session resolve <key>`
- `/session usage <id>`
- `/session abort <id>` with confirmation
- `/session compact <id>` with confirmation
- `/session restore <id>` with confirmation
- `/session messages <id>`
- Session selection from Chat.
- Session-aware command persistence.

### Channels

Currently implemented:

- `/channels` calls `channels.status`.

Still missing:

- `/channel start <name>` with confirmation
- `/channel stop <name>` with confirmation
- `/channel logout <name>` with confirmation
- Channel account status formatting.
- Discord/Telegram-specific summaries.
- Channel warmup/probe state.
- Channel error remediation.

### Approvals

Currently implemented:

- `/approvals` reads `exec.approvals.get`.

Still missing:

- Pending exec approval list.
- Resolve/approve/deny exec approval requests.
- Plugin approval request list.
- Plugin approval resolve/deny.
- Node approval variants.
- Approval policy editing with base hash and confirmation.
- Human-readable approval policy summary.

### Config

Currently implemented:

- `/config`
- `/config <path>`
- `/config schema [path]`
- `/model`
- `/model set <model-id> --confirm`
- `/model fallbacks <ids> --confirm`

Still missing:

- Safer model picker UI in Chat.
- Per-agent model configuration.
- Model routing policy display.
- Model fallback validation against available catalog.
- Config diff preview before patch.
- Restart-required display with next action.
- Config rollback or last-known-good display.
- Controlled editing for non-model config paths.

### Models

Currently implemented:

- `/models`
- `/model`
- `/model auth`
- `/model set`
- `/model fallbacks`

Still missing:

- `/models available`
- `/models provider <provider>`
- `/models search <query>`
- `/model agent <agent-id>`
- `/model set-agent <agent-id> <model-id>`
- `/model auth logout <provider>` with confirmation
- Provider auth state formatting.
- Model context/token/cost display if available.
- Model validation before config patch.

### Plugins

Currently implemented:

- `/plugins` calls `plugins.uiDescriptors`.

Still missing:

- Plugin list formatting.
- Plugin enabled/disabled status.
- Plugin sessions/actions.
- Plugin approval flows.
- Plugin config summaries.
- Plugin install/update/remove if supported and safe.

### Tools

Still missing:

- Tools catalog browsing.
- Effective tools for active agent/session.
- Tool invocation through controlled slash commands.
- Tool permission summary.
- Tool deny/allow visibility.
- Tool safety labels.

### Logs And Diagnostics

Currently implemented:

- `/logs [limit]`
- `/health`
- `/status`
- `/stability`
- `/memory`

Still missing:

- Log cursor pagination.
- Log severity filtering.
- Log copy/export.
- Gateway boot/warmup timeline.
- Health versus status versus channels summary.
- Diagnostic bundles.
- Memory dream diary/backfill/reset commands should remain hidden unless explicitly advanced and confirmed.

### Voice, Talk, And VoiceWake

OpenClaw advertises Talk and VoiceWake methods, but Versutus does not yet expose them.

Still missing:

- `/talk catalog`
- `/talk config`
- `/talk mode`
- Talk session create/join/close.
- Audio append/start/end/cancel flows.
- Talk tool-result submission.
- `/voicewake`
- `/voicewake routing`
- VoiceWake set/routing set with confirmation.
- Native audio permission and recording UX.
- Web audio fallback strategy.

### Cron

Currently implemented:

- `/cron` calls `cron.status`.

Still missing:

- Cron list.
- Cron run history.
- Cron add/update/remove with confirmation.
- Manual cron run with confirmation.
- Cron error formatting.

### Environments

Currently implemented:

- `/env` calls `environments.status`.

Still missing:

- Environment list.
- Per-environment status details.
- Environment variables/secrets health summary.
- Missing dependency remediation.

### Skills

Currently implemented:

- `/skills` calls `skills.status`.

Still missing:

- Skill detail.
- Skill search.
- Skill bins.
- Skill install/update flows with confirmation.
- Skill proposal flows.
- Skill security verdict summaries.

### Artifacts

Still missing:

- Artifact list.
- Artifact get.
- Artifact download/open.
- Chat attachment rendering for artifact outputs.
- Safe local file opening.

### Agents

Still missing:

- Agent list.
- Active agent identity.
- Agent file list/get/set.
- Agent create/update/delete with confirmation.
- Agent wait/status helpers.
- Per-agent model/tool/capability summary.

### Nodes

Still missing:

- Node list/describe.
- Node presence.
- Node invoke with scoped commands.
- Node pair approve/reject/remove.
- Node pending drain/ack/enqueue.
- Node rename.

### Devices

Still missing:

- Device pair list.
- Device pair approve/reject/remove.
- Device token rotate/revoke.
- Device scope/role summary.

### Native Platform Variants

Still missing:

- Verify web, iOS, and Android route variants after command integration.
- Ensure native settings/add screens remain in sync with web variants.
- Avoid iOS-only crashes from unsupported web/native component mixing.
- Check command suggestion wrapping on mobile widths.
- Check keyboard avoidance with the suggestion strip open.

## Recommended Implementation Order

### Phase 1: Make Chat The Command Center

Status: mostly complete.

- Completed: remove command panels from Tools.
- Completed: keep Tools focused on terminal/shell.
- Completed: add command busy state.
- Completed: add compact command output treatment.
- Completed: add expandable raw JSON.
- Completed: change composer placeholder to `Message or /command`.
- Completed: clearly mark command results as local ephemeral output.
- Remaining: true persistence for local command events if desired.

### Phase 2: Verify And Harden Safe Commands

Status: partially complete.

- Completed: build a safe command smoke test list.
- Completed: add `npm run smoke:gateway-commands`.
- Completed: replace raw JSON-first outputs with compact summaries for safe command families.
- Blocked: live CLI smoke currently times out for every gateway method from this shell, even with bounded per-call timeouts.

Smoke list:

  - `/health`
  - `/status`
  - `/sessions`
  - `/channels`
  - `/usage`
  - `/cost`
  - `/stability`
  - `/logs`
  - `/models`
  - `/model`
  - `/model auth`
  - `/config`
  - `/plugins`
  - `/approvals`
  - `/memory`
  - `/skills`
  - `/env`
  - `/cron`

Follow-up:

- Re-run the smoke harness with a responsive gateway call path.
- Run each green command once from the Chat composer to verify UI result formatting.
- Add command verification metadata after live smoke results are known.

### Phase 3: Model Configuration Polish

Status: partially complete.

- Completed: add model search/filter.
- Completed: validate model IDs against `/models` for default model and fallback writes when the gateway can return a catalog.
- Completed: add diff preview before `/model set`.
- Completed: add diff preview before `/model fallbacks`.
- Completed: add `/model routing`.
- Completed: add `/model agent <agent-id>` and `/model agents`.
- Completed: add `/model set-agent <agent-id> <model-id> --confirm`.
- Completed: show restart queued/required state after config writes when the gateway returns it.

Still remaining:

- Add a true model picker UI in Chat instead of typed IDs only.
- Validate fallback/model choices against provider auth readiness, not just catalog presence.
- Add rollback or last-known-good config display.
- Add richer token/context/cost details if `models.list` exposes them consistently.
- Live-smoke the config patch paths against the Windows gateway once the gateway call path is responsive from this shell.

### Phase 4: Management And Safety

- Add approval flows.
- Add channel start/stop/logout with confirmation.
- Add session abort/compact/restore with confirmation.
- Add device and pairing management.
- Add clear scope-aware command availability.

### Phase 5: Advanced Gateway Capabilities

- Add Talk and VoiceWake support.
- Add tools catalog/effective views.
- Add artifacts.
- Add cron management.
- Add environments/skills details.
- Add agents/nodes/devices as advanced command families.

## Validation Checklist

- `npx tsc --noEmit`
- `npm run smoke:gateway-commands`
- `npm run lint` after deciding how to handle the new Expo ESLint rules
- Web smoke at `http://localhost:8083/chat`
- Live Windows OpenClaw gateway smoke:
  - connect
  - reconnect without setup token
  - run safe slash commands
  - model read
  - model set confirmation flow
  - reload chat history and verify expected command output behavior
- Mobile-width visual check for command suggestions.
- Native route smoke for iOS/Android variants.

## Latest Validation

> **SUPERSEDED IN PART — 2026-08-10: live gateway path is CONFIRMED WORKING.**
>
> First real end-to-end message sent from the phone to Hermes with a streamed response rendered back in Chat. This proves transport, bearer auth, session resolution, candidate/discovery, and SSE delta rendering all working together over the wire.
>
> The `0/18 timed out` result below was almost certainly a **shell-environment failure of the smoke harness**, not a product failure. Re-run `npm run smoke:gateway-commands` from an environment matching the working path before trusting its output again.
>
> Still unproven, and not to be claimed in a demo:
>
> - **Approvals from the phone.** `resolveApproval` exists in the client with no UI wired to it. This remains the P0 killer feature.
> - **Off-tailnet remote.** No relay, no push, no background SSE — a backgrounded app misses everything.
> - **Multi-agent.** Still one chat, one session, one agent.
> - **Tests.** Still zero automated tests; lint still red.
> - **TLS.** `shouldUseTlsForHost` still returns false, so the bearer token rides plaintext inside the tunnel. WireGuard is doing the encryption, not the app.
> - **The "pinned" fingerprint label verifies nothing.** Do not show it to a client.
> - **Docs drift.** README still documents OpenClaw WS v4; the code speaks Hermes HTTP/SSE.
>
> Effect: operator demos are now genuinely possible. Before this, a demo would have been mocks.

- Passed: `npx tsc --noEmit`.
- Passed: `http://localhost:8083/chat` returned HTTP 200 after Phase 3 model-command changes.
- Failed with existing lint debt: `npm run lint`.
- Completed but failed live gateway calls: `npm run smoke:gateway-commands`.
  - Result: 0 passed, 0 scope-limited, 18 failed.
  - Failure mode: every safe `openclaw gateway call` timed out from this shell.
- Web route probe: port `8083` is listening under Node, but `http://localhost:8083/chat` timed out from PowerShell during this pass.

## Important Files

- `src/context/gateway-provider.tsx`
- `src/lib/gateway/client.ts`
- `src/lib/gateway/dashboard.ts`
- `src/lib/gateway/slash-commands.ts`
- `src/app/(tabs)/chat.tsx`
- `src/components/chat/chat-composer.tsx`
- `src/components/chat/message-bubble.tsx`
- `src/app/(tabs)/terminal.tsx`
- `src/components/gateway/gateway-home-dashboard.tsx`
- `src/components/gateway/gateway-capabilities.tsx`
- `src/components/gateway/compact-gateway-list.tsx`
- `src/hooks/use-gateway-reachability.ts`
- `src/app/gateway/settings.tsx`
- `src/app/gateway/add.tsx`

## Notes

- Keep Windows OpenClaw as the source of truth for this integration.
- Prefer bounded probes and graceful unknown states because gateway health/status can lag during warmup.
- Keep destructive/write commands hidden from default suggestions unless the user is already typing the command family.
- Require explicit confirmation for config, channel, session, approval, device, node, plugin, and agent mutations.
- Treat Chat as the primary interaction surface. Settings should remain advanced configuration. Home should remain gateway state and selection.
