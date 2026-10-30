/**
 * `glob` executed inside the WSL distribution.
 *
 * One fixed `find` walk replaces the 9P traversal; ordering, glob matching,
 * paging and the continuation cursor reproduce the native result contract.
 *
 * @module dsh-ops/file/wsl-glob
 */
import { globMatch, digest, parseWslPath } from './wsl.js'
import { listFiles, openCursor, continuationToken, snapshotMismatch, staleSearch,
  cursorBinding, pageBudget, type WslChannel, type WslFileRow } from './wsl-delegate.js'

/** The native glob contract: a positive pattern, bounded limit, known modes. */
function validate(args: Record<string, unknown>): boolean {
  const limit = args.limit as number | undefined
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000)) return false
  const patterns = args.pattern
  if (!Array.isArray(patterns) || patterns.length === 0
    || !(patterns as unknown[]).every(pattern => typeof pattern === 'string')
    || (patterns as string[]).every(pattern => pattern.startsWith('!'))) return false
  const sort = args.sort
  if (sort !== undefined && !['path', 'modified'].includes(sort as string)) return false
  const outputMode = args.outputMode
  if (outputMode !== undefined && !['paths', 'details'].includes(outputMode as string)) return false
  return true
}

/** Run a native-shaped glob request against the distribution's filesystem. */
export async function wslGlob(channel: WslChannel, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!validate(args)) throw new Error('glob arguments failed native validation')
  const root = args.path as string
  const rootInternal = parseRoot(channel, root)
  const binding = cursorBinding('glob', args, channel, rootInternal)
  const cursor = openCursor(args, binding)
  const walked = await listFiles(channel, rootInternal, true)
  const patterns = args.pattern as string[]
  const files = walked.files.filter(file => globMatch(patterns, file.relative))
  const details = args.outputMode === 'details'
  const modifiedSort = args.sort === 'modified'
  if (modifiedSort) {
    const ranked = [...files].sort((a, b) => (b.modified ?? Number.NEGATIVE_INFINITY) - (a.modified ?? Number.NEGATIVE_INFINITY))
    return assemble(args, binding, cursor, ranked, walked.scanComplete, details)
  }
  return assemble(args, binding, cursor, files, walked.scanComplete, details)
}

function parseRoot(channel: WslChannel, root: string): string {
  const internal = parseWslPath(root)?.internal
  if (internal === undefined) throw new Error('glob path is not inside the delegated distribution')
  return internal
}

function assemble(
  args: Record<string, unknown>,
  binding: string,
  cursor: { offset: number; continuation?: string },
  files: readonly WslFileRow[],
  scanComplete: boolean,
  details: boolean,
): Record<string, unknown> {
  const snapshot = digest(files.map(file => [file.relative, file.bytes, file.modified]))
  if (snapshotMismatch(cursor, snapshot)) return staleSearch()
  const limit = typeof args.limit === 'number' ? args.limit : 100
  const page: unknown[] = []
  const budget = pageBudget(page)
  let outputCut = false
  for (const [ordinal, file] of files.entries()) {
    if (ordinal < cursor.offset || ordinal >= cursor.offset + limit) continue
    if (!budget(details ? { path: file.display, bytes: file.bytes, modified: file.modified } : file.display)) {
      outputCut = true
      break
    }
  }
  const items = page
  const next = cursor.offset + items.length
  const more = next < files.length
  const output: Record<string, unknown> = {
    status: 'completed', phase: 'verify', changed: 0, matched: files.length,
    skipped: cursor.offset, failed: 0,
    complete: scanComplete && !more && !outputCut,
    truncated: !scanComplete || more || outputCut,
    items, nextOffset: next,
  }
  if (scanComplete) {
    output.total = files.length
    output.omitted = files.length - next
  }
  output.scanComplete = scanComplete
  output.pageComplete = !outputCut
  output.scannedFiles = files.length
  output.skippedFiles = 0
  output.skipReasons = {}
  output.matchedObserved = files.length
  output.truncatedBy = outputCut ? 'output-budget' : more ? 'row-limit' : 'none'
  if (scanComplete) output.matchedTotal = files.length
  if (scanComplete && more && !outputCut && next > cursor.offset) {
    output.continuation = continuationToken(binding, snapshot, next)
  }
  if (!scanComplete || outputCut) {
    output.nextAction = 'Narrow path/glob or resolve the reported scan gaps, then start a fresh query. No stable continuation is available for an incomplete traversal.'
  }
  return output
}
