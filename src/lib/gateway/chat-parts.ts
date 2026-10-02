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

/**
 * The one turn's image budget, counted in the characters of the `data:` URLs
 * the attachments are kept as.
 *
 * A base64 string is about a third larger than the JPEG it carries, and the
 * bytes are alive in three places at once — the composer's staged list, the user
 * message the send copies them into, and the single request body that carries
 * them all or none of them. A camera-roll photo straight off a modern phone is
 * megabytes, so four of them is tens of megabytes of Hermes strings on the
 * operator's low-memory device; past this budget an image is REFUSED rather
 * than held, and the caller is told so rather than finding out at send time.
 */
export const MAX_CHAT_ATTACHMENT_CHARS = 8 * 1024 * 1024;

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

/** What one pick cost: the attachments to stage, and how many were refused. */
export type ChatAttachmentPick = {
  attachments: ChatAttachment[];
  /**
   * Images dropped because the turn's budget was already spent. A refusal is
   * never silent — the caller says which pictures did not make it.
   */
  refused: number;
};

/** The characters one staged attachment is holding in this process. */
export function attachmentChars(attachments: ChatAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.uri.length, 0);
}

/**
 * Map picker assets to attachments, capping the count AND the bytes, dropping
 * junk. A picker asset that carries `base64` becomes a data URL, because a
 * provider cannot fetch a `file://`/`blob:` URI the phone holds.
 *
 * `existing` is what is already staged and `spent` what those attachments hold,
 * so one turn's budget is enforced across every pick rather than per pick: a
 * second pick that would push the turn past `MAX_CHAT_ATTACHMENT_CHARS` refuses
 * the rest instead of doubling what this phone is holding.
 */
export function chatAttachmentsFromPicker(
  assets: unknown,
  existing: number = 0,
  spent: number = 0,
): ChatAttachmentPick {
  const picked: ChatAttachmentPick = { attachments: [], refused: 0 };
  if (!Array.isArray(assets)) return picked;
  const room = Math.max(0, MAX_CHAT_ATTACHMENTS - existing);
  const seen = new Set<string>();
  let held = spent;
  for (const asset of assets) {
    if (picked.attachments.length >= room) break;
    const record = asset && typeof asset === 'object' ? (asset as Record<string, unknown>) : {};
    const uri = text(record.uri);
    const mimeType = text(record.mimeType) ?? text(record.mime_type);
    const base64 = text(record.base64);
    const url = base64 && mimeType ? `data:${mimeType};base64,${base64}` : uri;
    if (!url || seen.has(url)) continue;
    if (mimeType && !IMAGE_MIME.test(mimeType)) continue;
    // An image the turn cannot carry is not staged at all — holding it until
    // Send is what put megabytes of strings on a phone that had to survive the
    // picker — and it is counted, so the operator hears about it.
    if (held + url.length > MAX_CHAT_ATTACHMENT_CHARS) {
      picked.refused += 1;
      continue;
    }
    seen.add(url);
    held += url.length;
    picked.attachments.push({
      kind: 'image',
      uri: url,
      mimeType,
      name: text(record.fileName) ?? text(record.name),
    });
  }
  return picked;
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
