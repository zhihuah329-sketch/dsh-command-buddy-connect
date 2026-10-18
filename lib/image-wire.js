/**
 * Image translation for the OpenAI-shaped routes.
 *
 * ## Why this module exists
 *
 * Both the in-process pool route and the daemon route previously declared
 * `inputModalities: ['text']` and flattened message content to text, which
 * silently discarded every image the user attached. The pool route declared
 * image support but still dropped the bytes — worse than not declaring it,
 * because the model then answers as if it had seen a picture it never received.
 *
 * ## How an image reaches the wire
 *
 * A content block holds an `ImageAttachmentRef` — an identifier, not bytes. The
 * harness's `attachments` service turns that reference into a normalized
 * request version (`readImageRequest`), which is what a provider actually
 * accepts. This module wraps that call and emits the OpenAI `image_url` part the
 * upstream expects, with the whole conversion kept in one place so both routes
 * behave identically.
 *
 * @module buddy-connect/image-wire
 */

/** The request policy both routes use. */
const DEFAULT_POLICY = { maxPixels: 4_000_000, maxBytes: 4 * 1024 * 1024 }

/**
 * Convert one image block into an OpenAI `image_url` content part.
 *
 * @param block - a content block of type `image`.
 * @param attachments - the harness attachment service.
 * @param options - optional policy and cancellation.
 * @returns the wire part, or null when the bytes cannot be read.
 */
export async function imagePartOf(block, attachments, options = {}) {
  const ref = block?.attachment
  if (ref === undefined || ref === null) return null
  if (attachments === undefined || attachments === null
    || typeof attachments.readImageRequest !== 'function') {
    return null
  }
  try {
    const request = await attachments.readImageRequest(
      ref,
      options.policy ?? DEFAULT_POLICY,
      options.signal
    )
    if (request === undefined || request === null || request.data === undefined) return null
    const mediaType = request.mediaType ?? ref.mediaType ?? 'image/png'
    const base64 = Buffer.from(request.data).toString('base64')
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }
  } catch {
    // A missing or unreadable attachment must not fail the whole request: the
    // text still goes through, and the user sees the answer for their words.
    return null
  }
}

/**
 * Build the wire `content` for one message.
 *
 * A message whose content is all text is sent as a plain string, because some
 * upstream validators reject the array form when no image is present. A message
 * that carries images becomes the array form.
 *
 * @param content - typed content blocks.
 * @param attachments - the harness attachment service.
 * @param options - optional policy and cancellation.
 * @returns a string, an array of wire parts, or null when there is no content.
 */
export async function wireContentOf(content, attachments, options = {}) {
  const blocks = content ?? []
  const hasImage = blocks.some((b) => b !== null && typeof b === 'object' && b.type === 'image')
  const text = blocks
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text')
    .map((b) => b.text)
    .join('')

  if (!hasImage) return text.length === 0 ? null : text

  const parts = []
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const part = await imagePartOf(block, attachments, options)
    if (part !== null) parts.push(part)
  }
  // Every image failed to resolve; sending an empty array would be rejected.
  if (!parts.some((p) => p.type === 'image_url')) {
    return text.length === 0 ? null : text
  }
  return parts
}

/**
 * Whether a message list contains any image at all.
 *
 * Routes that cannot carry images need this to decide between "send as is" and
 * "let the harness project images into text placeholders".
 *
 * @param messages - the request messages.
 * @returns true when at least one image block is present.
 */
export function hasImages(messages) {
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block !== null && typeof block === 'object' && block.type === 'image') return true
    }
  }
  return false
}

export { DEFAULT_POLICY as IMAGE_POLICY }
