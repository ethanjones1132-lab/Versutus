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

export type ChatEventPayload = {
  sessionId?: string;
  deltaText?: string;
  text?: string;
  state?: 'streaming' | 'complete' | 'error';
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
