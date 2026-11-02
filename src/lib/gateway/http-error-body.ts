export function messageFromHttpErrorBody(errorText: string, status: number): string {
  const fallback = errorText || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(errorText) as { message?: unknown; error?: unknown };
    if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    const nested = parsed?.error as { message?: unknown } | string | undefined;
    if (nested && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message.trim();
    }
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // not JSON
  }
  // A web page is not a message. A proxy, captive portal or an SPA catch-all can
  // answer with HTML; pasting that markup into the operator's caption hides the
  // real fault. Name the status and the fact that a page came back instead.
  if (errorText.trim().startsWith('<')) {
    return `The gateway or something in front of it answered HTTP ${status} with a web page instead of JSON.`;
  }
  return fallback;
}

/** The Gate's machine-readable code for a refusal, when its body carries one. */
export function errorCodeFromHttpBody(errorText: string): string | undefined {
  try {
    const parsed = JSON.parse(errorText) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  } catch {
    // not JSON
  }
  return undefined;
}
