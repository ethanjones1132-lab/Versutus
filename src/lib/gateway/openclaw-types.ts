// ─── OpenClaw wire protocol v4 (legacy adapter) ───────────────────
// Types for the OpenClaw WebSocket protocol. Kept separate from the
// Hermes API types so the salvaged OpenClaw adapter can compile
// against the post-migration codebase without polluting it.

export type GatewayFrame =
  | {
      type: 'req';
      id: string;
      method: string;
      params?: Record<string, unknown>;
    }
  | {
      type: 'res';
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: {
        code?: string;
        message?: string;
        details?: {
          code?: string;
          message?: string;
          requestId?: string;
          remediationHint?: string;
          requestedRole?: string;
          requestedScopes?: string[];
          approvedRoles?: string[];
          approvedScopes?: string[];
          reason?: string;
        };
      };
    }
  | {
      type: 'event';
      event: string;
      payload?: Record<string, unknown>;
    };

/**
 * One OpenClaw `chat` push frame.
 *
 * This is the VERIFIED dialect (docs/audit-bugs-architecture.md P1-1, from the
 * pre-migration handler): `state` is one of started/delta/final/error, the text
 * rides either on `deltaText` or nested under `message.content`, and an error
 * carries `errorMessage`. The union used to read 'streaming'|'complete'|'error'
 * with none of `runId`, `message` or `errorMessage` — vocabulary no handler
 * branch matched — while the frame reached the handler through an
 * `as ChatEventPayload` cast, so anything written against this type compiled and
 * then silently never settled a turn.
 */
export type ChatEventPayload = {
  sessionId?: string;
  /**
   * Which turn produced this frame. Present on every frame of an agentic run,
   * and the only thing that tells a stopped run's late frames from the run that
   * replaced it.
   */
  runId?: string;
  deltaText?: string;
  text?: string;
  message?: { content?: unknown };
  state?: 'started' | 'delta' | 'final' | 'error';
  errorMessage?: string;
  error?: string;
  command?: {
    input?: string;
    title?: string;
    raw?: string;
    status?: 'running' | 'complete' | 'error';
    ephemeral?: boolean;
    durationMs?: number;
  };
};
