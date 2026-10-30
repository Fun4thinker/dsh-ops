/**
 * `grep` executed inside the WSL distribution.
 *
 * The fixed `find` walk replaces the 9P traversal, and the walked files are
 * packed into base64 tar batches so bytes arrive losslessly. Matching uses a
 * compiled regular expression over the decoded text with the native result
 * contract: per-line hits, physical-LF context excerpts, per-file ordinal
 * paging, skip accounting, and an `s1:` continuation cursor.
 *
 * @module dsh-ops/file/wsl-grep
 */
import { textLines, digest, globMatch, parseWslPath } from './wsl.js'
import { listFiles, packBatches, openCursor, continuationToken, snapshotMismatch, staleSearch,
  cursorBinding, pageBudget, type WslChannel, type WslFileRow } from './wsl-delegate.js'

interface GrepRecord { row: WslFileRow; hits: number }

const BATCH_BYTES = 8 * 1024 * 1024

function validate(args: Record<string, unknown>): boolean {
  if (typeof args.pattern !== 'string' || args.pattern === '') return false
  const limit = args.limit as number | undefined
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000)) return false
  for (const field of ['beforeContext', 'afterContext'] as const) {
    const value = args[field] as number | undefined
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 32)) return false
  }
  const outputMode = args.outputMode
  if (outputMode !== undefined && !['content', 'files_with_matches', 'count', 'summary'].includes(outputMode as string)) return false
  return true
}

/** Compile with Unicode semantics; anything JS cannot compile defers to native. */
const compile = (pattern: string, flags: string): RegExp => new RegExp(pattern, `${flags}u`)

/** Run a native-shaped grep request against the distribution's filesystem. */
export async function wslGrep(channel: WslChannel, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!validate(args)) throw new Error('grep arguments failed native validation')
  const rootInternal = parseWslPath(args.path as string)?.internal
  if (rootInternal === undefined) throw new Error('grep path is not inside the delegated distribution')
  const binding = cursorBinding('grep', args, channel, rootInternal)
  const cursor = openCursor(args, binding)
  const pattern = args.pattern as string
  const multiline = args.multiline === true
  const caseInsensitive = args.caseInsensitive === true
  const content = args.outputMode === undefined || args.outputMode === 'content'
  const summary = args.outputMode === 'summary'
  const fileMode = args.outputMode === 'files_with_matches' || args.outputMode === 'count'
  const lineNumbers = args.lineNumbers !== false
  const before = typeof args.beforeContext === 'number' ? args.beforeContext : 0
  const after = typeof args.afterContext === 'number' ? args.afterContext : 0
  const limit = typeof args.limit === 'number' ? args.limit : 100
  const offset = cursor.offset
  const flags = `${caseInsensitive ? 'i' : ''}${multiline ? 'm' : ''}`
  let lineMatcher: RegExp | undefined
  let spanMatcher: RegExp | undefined
  try {
    lineMatcher = multiline ? undefined : compile(pattern, flags)
    spanMatcher = multiline ? compile(pattern, `${flags}g`) : undefined
  } catch {
    throw new Error('grep pattern failed native compilation')
  }

  const walked = await listFiles(channel, rootInternal, false)
  const filter = Array.isArray(args.glob) ? (args.glob as unknown[]).map(String) : []
  const files = filter.length === 0 ? walked.files : walked.files.filter(file => globMatch(filter, file.relative))
  const records: GrepRecord[] = []
  const skipReasons: Record<string, number> = {}
  const note = (reason: string, times = 1) => { skipReasons[reason] = (skipReasons[reason] ?? 0) + times }
  const page: unknown[] = []
  const budget = pageBudget(page)
  let outputCut = false
  let matchCount = 0
  let fileCount = 0

  const { batches, skipped } = await packBatches(channel, files, BATCH_BYTES)
  for (const [reason, times] of Object.entries(skipped)) note(reason, times)
  for (const batch of batches) {
    let previous = 0
    let line = 1
    for (const entry of batch) {
      let text: string
      try {
        // A fresh fatal decoder per file: no state can leak between entries.
        text = new TextDecoder('utf-8', { fatal: true }).decode(entry.data)
      } catch {
        note('invalid-encoding')
        records.push({ row: entry, hits: 0 })
        continue
      }
      if (text === '') { records.push({ row: entry, hits: 0 }); continue }
      const lines = textLines(text)
      const excerpt = (startLine: number, endLine: number): string =>
        lines.slice(Math.max(0, startLine - 1 - before), Math.min(lines.length, endLine + after)).join('\n')
      let hits = 0
      // A match is only materialized when its global ordinal lands on the page;
      // counters still track every hit the native exact scan would report.
      const pushMatch = (startLine: number, endLine: number): void => {
        const ordinal = matchCount + hits
        hits += 1
        if (!content || ordinal < offset || ordinal >= offset + limit || outputCut) return
        if (!budget({ path: entry.display, line: lineNumbers ? startLine : 0, text: excerpt(startLine, endLine) })) {
          outputCut = true
        }
      }
      if (multiline && spanMatcher) {
        spanMatcher.lastIndex = 0
        for (let found = spanMatcher.exec(text); found !== null; found = spanMatcher.exec(text)) {
          if (found[0].length === 0 && spanMatcher.lastIndex === found.index) spanMatcher.lastIndex += 1
          if (found.index >= text.length && text.endsWith('\n')) break
          line += countNewlines(text, previous, found.index)
          previous = found.index
          pushMatch(line, line + countNewlines(text, found.index, found.index + found[0].length))
        }
      } else if (lineMatcher) {
        for (const [index, lineText] of lines.entries()) {
          if (lineMatcher.test(lineText)) pushMatch(index + 1, index + 1)
        }
      }
      records.push({ row: entry, hits })
      if (hits > 0) {
        matchCount += hits
        fileCount += 1
        if (fileMode && !outputCut && fileCount - 1 >= offset && fileCount - 1 < offset + limit) {
          const item = args.outputMode === 'count' ? { path: entry.display, count: hits } : { path: entry.display }
          if (!budget(item)) outputCut = true
        }
      }
    }
  }

  const itemTotal = summary ? 0 : content ? matchCount : fileCount
  return assemble(binding, cursor, records, skipReasons, matchCount, fileCount, itemTotal,
    page, outputCut, walked.scanComplete, summary, offset)
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let index = from; index < to && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function assemble(
  binding: string,
  cursor: { offset: number; continuation?: string },
  records: readonly GrepRecord[],
  skipReasons: Record<string, number>,
  matchCount: number,
  fileCount: number,
  itemTotal: number,
  page: readonly unknown[],
  outputCut: boolean,
  scanComplete: boolean,
  summary: boolean,
  offset: number,
): Record<string, unknown> {
  const snapshot = digest(records.map(record => [record.row.relative, record.hits, record.row.bytes]))
  if (snapshotMismatch(cursor, snapshot)) return staleSearch()
  const next = offset + page.length
  const more = next < itemTotal
  const output: Record<string, unknown> = {
    status: 'completed', phase: 'verify', changed: 0, matched: matchCount,
    skipped: offset, failed: 0,
    complete: scanComplete && !more && !outputCut,
    truncated: !scanComplete || more || outputCut,
    items: summary ? [] : [...page], nextOffset: next,
  }
  if (scanComplete) {
    output.total = itemTotal
    output.omitted = itemTotal - next
  }
  if (summary) {
    output.files = fileCount
    output.matches = matchCount
  }
  output.scanComplete = scanComplete
  output.pageComplete = !outputCut
  output.scannedFiles = records.length
  output.skippedFiles = Object.values(skipReasons).reduce((total, count) => total + count, 0)
  output.skipReasons = skipReasons
  output.matchedObserved = matchCount
  output.truncatedBy = outputCut ? 'output-budget' : more ? 'row-limit' : 'none'
  if (scanComplete) output.matchedTotal = matchCount
  if (scanComplete && more && !outputCut && next > offset) {
    output.continuation = continuationToken(binding, snapshot, next)
  }
  if (!scanComplete || outputCut) {
    output.nextAction = 'Narrow path/glob or resolve the reported scan gaps, then start a fresh query. No stable continuation is available for an incomplete traversal.'
  }
  return output
}
