// Only trusted adapter code (not a config value or an HTTP request) can attest
// that it intercepts tools or keeps the inaccessible classes out of the turn.
export const TAP_GATED_VOICE_TOOLS = Symbol('tap-gated voice tools');
export const VOICE_POLICY_REFUSAL_CODE = 'voice_approval_policy_unavailable';
export const VOICE_POLICY_REFUSAL = 'Use typed chat because this call can’t ask before every action.';
export const VOICE_TYPED_TOOLS = 'Use typed chat for actions that aren’t available in this call.';

export function requireVoiceTurnPolicy(backend) {
  if (backend?.[TAP_GATED_VOICE_TOOLS] !== true) {
    throw Object.assign(new Error(VOICE_POLICY_REFUSAL), { code: VOICE_POLICY_REFUSAL_CODE });
  }
}

// A restricted child must never resume a typed runtime. Give it a bounded
// copy of the conversation as text instead; no tools, file parts or role
// overrides are copied. The caller can supply recent voice-only messages.
export function restrictedVoicePrompt({ history = [], recent = [], text, soul } = {}) {
  const earlier = [...history, ...recent].filter(({ role }) => role === 'assistant' || role === 'user')
    .slice(-12).map(({ role, content }) => ({
      role, text: (Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '')).slice(-1_200),
    }));
  return `${soul ? `Bot instructions:\n${soul}\n\n` : ''}`
    + `${earlier.length ? `Earlier conversation:\n${JSON.stringify(earlier)}\n\n` : ''}`
    + `User's latest message:\n${text ?? ''}`;
}
