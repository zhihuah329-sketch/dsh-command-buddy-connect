/**
 * Parsing the daemon's log response.
 *
 * ## Why this is its own module
 *
 * The route does not answer with an array. It answers with
 * `{"text": "<whole log as one newline-joined string>"}`. A reader that only
 * accepted arrays therefore fell through to `[]` and reported "The daemon log is
 * empty" against a file of hundreds of kilobytes — turning the single most
 * useful diagnostic in this plugin into a dead end.
 *
 * Keeping the shape handling here, free of any framework import, makes it
 * testable without the harness packages installed.
 *
 * @module dsh-command-buddy-connect/log-parse
 */

/** Narrow an unknown value to a trimmed non-empty string, or a fallback. */
export function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Split a newline-joined log blob into entry records.
 *
 * The daemon writes `2026-10-19T02:12:32.697+00:00 号池切换 cn en HTTP 429`.
 * The category is the first whitespace-delimited word after the timestamp; the
 * rest is the detail. A line that does not match is kept whole rather than
 * dropped, because a partially understood log is still worth reading.
 *
 * @param blob - the log text.
 * @returns entry records.
 */
export function parseLogLines(blob) {
  const out = []
  for (const line of String(blob).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+([^\s]+)\s*(.*)$/.exec(trimmed)
    if (match === null) {
      out.push({ detail: trimmed })
      continue
    }
    out.push({
      time: match[1],
      kind: match[2],
      ...(match[3].length === 0 ? {} : { detail: match[3] })
    })
  }
  return out
}

/**
 * Turn whatever the daemon's log route answered into a list of entry-like rows.
 *
 * Four shapes are accepted, most specific first: an array of records, an array
 * hidden under `logs`/`entries`, and the newline-joined `text` blob.
 *
 * @param raw - the decoded response body, of unknown shape.
 * @returns a list of entry-like values.
 */
export function normalizeLogRows(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.logs)) return raw.logs
  if (Array.isArray(raw?.entries)) return raw.entries
  const blob = stringOr(raw?.text ?? raw?.log ?? raw?.lines, undefined)
  if (blob === undefined) return []
  return parseLogLines(blob)
}
