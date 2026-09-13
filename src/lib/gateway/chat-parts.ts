// ─── Multimodal chat content parts ────────────────────────────────────────
// P1: a composer attachment becomes an OpenAI-shaped content part. The shape
// is deliberately OpenAI's `{ type: 'image_url', image_url: { url } }`, which
// the Gate's provider path already forwards verbatim. Attachments are gated on
// the selected model DECLARING image input; with no declaration the attach
// control stays hidden rather than sending an image a text model will reject.

export type ChatAttachment = {
  kind: 'image';
  /** A data: URL (native) or blob: URL (web) the model can fetch. */
  uri: string;
  mimeType?: string;
  name?: string;
};

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One turn's cap, so a paste cannot balloon the request body. */
export const MAX_CHAT_ATTACHMENTS = 4;

const IMAGE_MIME = /^image\//i;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Parse a stored attachment; anything not an image with a uri is dropped. */
export function chatAttachmentFromUnknown(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const uri = text(record.uri);
  if (!uri) return null;
  const mimeType = text(record.mimeType) ?? text(record.mime_type);
  if (mimeType && !IMAGE_MIME.test(mimeType)) return null;
  return {
    kind: 'image',
    uri,
    mimeType,
    name: text(record.name) ?? text(record.fileName),
  };
}

/**
 * Map picker assets to attachments, capping the count and dropping junk. A
 * picker asset that carries `base64` becomes a data URL, because a provider
 * cannot fetch a `file://`/`blob:` URI the phone holds.
 */
export function chatAttachmentsFromPicker(assets: unknown, existing: number = 0): ChatAttachment[] {
  if (!Array.isArray(assets)) return [];
  const room = Math.max(0, MAX_CHAT_ATTACHMENTS - existing);
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const asset of assets) {
    if (out.length >= room) break;
    const record = asset && typeof asset === 'object' ? (asset as Record<string, unknown>) : {};
    const uri = text(record.uri);
    const mimeType = text(record.mimeType) ?? text(record.mime_type);
    const base64 = text(record.base64);
    const url = base64 && mimeType ? `data:${mimeType};base64,${base64}` : uri;
    if (!url || seen.has(url)) continue;
    if (mimeType && !IMAGE_MIME.test(mimeType)) continue;
    seen.add(url);
    out.push({ kind: 'image', uri: url, mimeType, name: text(record.fileName) ?? text(record.name) });
  }
  return out;
}

/**
 * The wire content for one message. No attachments keeps the plain string the
 * text-only path has always sent; attachments become parts, text first.
 */
export function buildChatContent(
  text: string,
  attachments: ChatAttachment[] = [],
): string | ChatContentPart[] {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  const parts: ChatContentPart[] = [];
  if (trimmed) parts.push({ type: 'text', text: trimmed });
  for (const attachment of attachments) {
    parts.push({ type: 'image_url', image_url: { url: attachment.uri } });
  }
  return parts;
}

/**
 * Whether a model DECLARES image input. Only explicit capabilities count —
 * an absent/unknown declaration is false, so the attach control fails closed.
 */
export function supportsImageInput(
  model: { capabilities?: unknown; input_modalities?: unknown } | null | undefined,
): boolean {
  if (!model) return false;
  const signals = [
    ...(Array.isArray(model.capabilities) ? model.capabilities : []),
    ...(Array.isArray(model.input_modalities) ? model.input_modalities : []),
  ].map((value) => String(value).trim().toLowerCase());
  return signals.some((signal) => signal === 'image' || signal === 'vision' || signal === 'input_image');
}
