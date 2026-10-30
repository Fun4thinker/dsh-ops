/**
 * `read_files` executed inside the WSL distribution.
 *
 * One base64 tar batch carries every requested file losslessly, so the host
 * hashes exact bytes (native revisions are content SHA-256), decodes UTF-8
 * fatally, and slices the same physical-LF line ranges the native inspector
 * publishes — including the serialized-byte budget, truncated-line markers
 * and the per-file aggregate continuation fields.
 *
 * @module dsh-ops/file/wsl-read
 */
import { createHash } from 'node:crypto'
import { textLines, jsonSize, parseWslPath, MAX_FILE_BYTES, MAX_OUTPUT_BYTES } from './wsl.js'
import { packBatch, type WslChannel } from './wsl-delegate.js'

const NEXT_ACTION = 'Resume remaining files from nextIndex. Follow each file\'s nextOffset for more lines; '
  + 'for truncatedInLine use that file\'s hex inspection guidance.'
const HEX_RECOVERY = 'A line was cut by the output budget. Inspect this file with view=hex and page its '
  + '16-byte rows; nextOffset retains the incomplete line, so text paging alone cannot recover its suffix.'
const ENCODING_NEXT_ACTION = 'Use a dedicated document/binary reader, or inspect with view=hex; do not '
  + 'replace invalid bytes with lossy text.'

/** Run a native-shaped read_files request against the distribution's filesystem. */
export async function wslReadFiles(channel: WslChannel, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = Array.isArray(args.files) ? args.files as Record<string, unknown>[] : []
  if (requested.length < 1 || requested.length > 32) throw new Error('read_files accepts 1-32 files')
  for (const file of requested) {
    const offset = file.offset as number | undefined
    const limit = file.limit as number | undefined
    if ((offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1))
      || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000))) {
      throw new Error('read_files offset starts at 1 and limit is 1-10000')
    }
  }
  const paths = requested.map(file => file.path as string)
  const internals = paths.map(path => {
    // The delegation entry point already proved the distro matches.
    const internal = parseWslPath(path)?.internal
    if (internal === undefined) throw new Error('a requested file is not inside the delegated distribution')
    return internal
  })
  const rows = requested.map((file, index) => ({ relative: internals[index], internal: internals[index],
    display: '', bytes: 0, modified: null }))
  const batch = await packBatch(channel, rows)
  if (batch === null) throw new Error('read_files tar batch did not settle')
  if (batch.missing > 0) throw new Error('a requested file did not arrive in the archive')

  const value: Record<string, unknown> = {
    status: 'completed', phase: 'verify', changed: 0, matched: requested.length, failed: requested.length,
    complete: false, truncated: false, effectState: 'none', items: [], total: requested.length,
    nextIndex: requested.length, pending: requested.length, nextAction: NEXT_ACTION,
  }
  let room = MAX_OUTPUT_BYTES - (jsonSize(value) + 1)
  const items: unknown[] = []
  let failed = 0
  let complete = true
  let truncated = false
  const byName = new Map(batch.entries.map(entry => [entry.internal, entry.data]))
  for (const [index, file] of requested.entries()) {
    if (room < 1024) break
    const bytes = byName.get(internals[index])
    if (bytes === undefined) throw new Error('a requested file did not arrive in the archive')
    if (bytes.length > MAX_FILE_BYTES) throw new Error('file exceeds the native read budget')
    const display = `\\\\wsl.localhost\\${channel.distro}${internals[index].replaceAll('/', '\\')}`
    const item = inspect(display, bytes,
      typeof file.offset === 'number' ? file.offset : 1,
      typeof file.limit === 'number' ? file.limit : 200, room - 1)
    const size = jsonSize(item) + 1
    if (size > room) break
    room -= size
    if ((item as Record<string, unknown>).error !== undefined) failed += 1
    complete = complete && (item as Record<string, unknown>).complete === true
    truncated = truncated || (item as Record<string, unknown>).truncated === true
    items.push(item)
  }
  const returned = items.length
  complete = complete && returned === requested.length
  value.status = complete ? 'completed' : 'partial'
  value.complete = complete
  value.truncated = truncated || returned < requested.length
  value.matched = returned - failed
  value.failed = failed
  value.nextIndex = returned
  value.pending = requested.length - returned
  value.items = items
  if (complete) delete value.nextAction
  return value
}

/** One native-shaped inspect item for a text view, bounded by `budget` bytes. */
function inspect(display: string, bytes: Buffer, offset: number, limit: number, budget: number): Record<string, unknown> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { path: display, status: 'error', complete: false, items: [], error: {
      code: 'ERR_INVALID_ENCODING', phase: 'preflight', retryable: false, effectState: 'none',
      nextAction: ENCODING_NEXT_ACTION, message: 'File is not valid UTF-8' } }
  }
  const lines = textLines(text)
  const total = lines.length
  const facts = {
    revision: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...(Number.isFinite(total) ? { lineCount: total } : {}),
  }
  const skeleton: Record<string, unknown> = {
    status: 'completed', phase: 'verify', changed: 0, matched: total, skipped: offset - 1, failed: 0,
    complete: false, truncated: false, omitted: total, items: [], total,
    nextOffset: offset, nextAction: HEX_RECOVERY, ...facts, path: display,
  }
  let room = budget - (jsonSize(skeleton) + 1)
  const kept: unknown[] = []
  let used = 0
  let incompleteLine = false
  let stopped = false
  const start = offset - 1
  for (let index = start; index < Math.min(total, start + limit); index += 1) {
    const candidate: Record<string, unknown> = { path: display, line: index + 1, text: lines[index] }
    const cost = jsonSize(candidate) + 1
    if (used + cost <= room) {
      used += cost
      kept.push(candidate)
      continue
    }
    // Preserve a bounded prefix of the first line that does not fit, exactly
    // like the native budget, so a caller can still see the file is longer.
    const whole = lines[index]
    const marker: Record<string, unknown> = { path: display, line: index + 1, text: '',
      bytesTotal: whole.length, bytesOmitted: whole.length, truncatedInLine: true }
    const header = jsonSize(marker) + 1
    const remaining = room - used - header
    const prefix = textPrefix(whole, remaining)
    if (prefix !== '' && header <= room - used) {
      marker.text = prefix
      marker.bytesOmitted = whole.length - prefix.length
      kept.push(marker)
      incompleteLine = true
    }
    stopped = true
    break
  }
  const consumed = kept.length - (incompleteLine ? 1 : 0)
  skeleton.complete = !stopped && start + consumed >= total
  skeleton.truncated = stopped
  skeleton.omitted = total - (start + consumed)
  skeleton.nextOffset = offset + consumed
  skeleton.items = kept
  if (!incompleteLine) delete skeleton.nextAction
  return skeleton
}

/** Longest prefix whose JSON-escaped cost fits `budget` bytes (native `prefix`). */
function textPrefix(text: string, budget: number): string {
  let used = 0
  const characters = [...text]
  for (const [index, character] of characters.entries()) {
    used += encodedCost(character)
    if (used > budget) return characters.slice(0, index).join('')
  }
  return text
}

function encodedCost(character: string): number {
  const code = character.codePointAt(0) ?? 0
  if (character === '"' || character === '\\' || character === '\n' || character === '\r'
    || character === '\t' || character === '\b' || character === '\f') return 2
  if (code < 0x20) return 6
  return Buffer.byteLength(character, 'utf8')
}
