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

/**
 * True when an answer is a web page rather than the JSON the app asked for.
 *
 * Checked BEFORE any parsing, on two independent signals: the content type a
 * proxy, portal or misrouted host declares, and — for hosts that never set
 * one — markup at the top of the body. A 200 here is not a success: a login
 * page, a 404 page or a captive portal all answer 2xx with HTML, and handing
 * that body to JSON.parse is what put parser text in the operator's caption.
 */
export function isHtmlAnswer(contentType: string | null | undefined, body: string): boolean {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/html') || type.includes('application/xhtml')) return true;
  return /^\s*<(!doctype|html|head|body|title|meta|link|script|style|form|div|span|table|h[1-6]|p|a|center|font|!--)/i.test(
    body,
  );
}

/** How much of a refused page may be quoted back to the operator. */
export const PAGE_SNIPPET_MAX_LENGTH = 120;

/**
 * A credential-shaped value visible in a page body: `password: …`,
 * `token=…`, `api-key: …`. Markup is stripped before this runs, so an
 * attribute value never reaches it — this covers the text a page actually
 * shows the reader.
 */
const CREDENTIAL_LIKE =
  /\b(password|passwd|pwd|token|secret|authorization|api[-_ ]?key|session[-_ ]?key|cookie)(\s*[:=]\s*)(\S+)/gi;

/**
 * The one bounded, single-line, operator-safe excerpt of a refused page:
 * scripts, styles and every tag (attributes included) are dropped, anything
 * credential-shaped is redacted, and the rest is cut to
 * `PAGE_SNIPPET_MAX_LENGTH`. Never the markup, never a dump.
 */
export function pageSnippet(body: string, maxLength = PAGE_SNIPPET_MAX_LENGTH): string {
  const visible = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(CREDENTIAL_LIKE, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (visible.length <= maxLength) return visible;
  return `${visible.slice(0, maxLength).trimEnd()}…`;
}

/**
 * The refusal shown when an answer was a web page: which request asked, what
 * status came back, what the page said (sanitised) and what to do next. This
 * is the whole user-visible outcome — never the markup, never a JSON parse
 * message, always a next step.
 */
export function messageForHtmlAnswer(
  method: string,
  path: string,
  status: number,
  body: string,
): string {
  const said = pageSnippet(body);
  return [
    `${method} ${path} answered HTTP ${status} with a web page instead of JSON.`,
    said ? `The page said: "${said}".` : '',
    'Check the gateway address: a login page, error page or captive portal answers instead of the gateway.',
  ]
    .filter(Boolean)
    .join(' ');
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
