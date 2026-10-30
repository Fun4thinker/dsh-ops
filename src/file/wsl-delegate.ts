/**
 * WSL delegation entry point and shared channel plumbing.
 *
 * `delegateWslFileTool` is the only symbol the host bridge calls. It resolves
 * to undefined for anything the native worker must keep answering: mutating
 * tools, non-WSL paths, mixed-distro paths, and every channel failure. When
 * it resolves, the returned value carries the same result shape the native
 * worker publishes for the same tool, with paths mapped back to UNC display
 * form and the paging/continuation contract intact.
 *
 * @module dsh-ops/file/wsl-delegate
 */
import { uncDisplay, parseWslPath, wslArgv, runWsl, walkOrder, hasHiddenComponent,
  internalDenyRoots, traversalDeny, digest, FIND_SCRIPT, LIST_SCRIPT, TAR_SCRIPT,
  MAX_ENTRIES, MAX_FILE_BYTES, type WslSpawner } from './wsl.js'
import { parseTar } from './wsl-tar.js'
import { wslGlob } from './wsl-glob.js'
import { wslGrep } from './wsl-grep.js'
import { wslReadFiles } from './wsl-read.js'

/** The read-only tools this channel can answer inside the distribution. */
export const WSL_DELEGATED_TOOLS = ['glob', 'grep', 'read_files'] as const

export interface WslDelegationInput {
  subprocess: WslSpawner
  tool: string
  /** Trusted worker arguments: every path is already the session's anchored UNC form. */
  args: Record<string, unknown>
  /** Trusted session cwd (UNC). */
  cwd: string
  scope: string
  denyRoots: readonly string[]
  signal?: AbortSignal
}

/** Everything one delegated call shares: distro identity, deny fence, spawn. */
export interface WslChannel {
  spawner: WslSpawner
  distro: string
  /** The UNC cwd passed to wsl.exe so interop resolves the working directory. */
  wslCwd: string
  scope: string
  denyRoots: readonly string[]
  deny(internal: string, relative: string): boolean
  signal?: AbortSignal
}

/** A delegation that must be answered by the native worker's own validation. */
export class DeferToNative extends Error {}

export interface WslFileRow {
  /** Path relative to the search root, '/'-separated, in native walk order. */
  relative: string
  internal: string
  display: string
  bytes: number
  modified: number | null
}

/**
 * Run one read-only tool inside the WSL distribution.
 *
 * @returns the tool result shaped like the native worker's, or undefined when
 * the caller must fall back to the native worker path. Never throws.
 */
export async function delegateWslFileTool(input: WslDelegationInput): Promise<Record<string, unknown> | undefined> {
  try {
    if (!(WSL_DELEGATED_TOOLS as readonly string[]).includes(input.tool)) return undefined
    const base = parseWslPath(input.cwd)
    if (!base) return undefined
    const targets = input.tool === 'read_files'
      ? (Array.isArray(input.args.files) ? input.args.files : []).map(file => (file as Record<string, unknown>)?.path)
      : [input.args?.path]
    if (targets.some(target => typeof target !== 'string')) return undefined
    const lowered = base.distro.toLowerCase()
    const parsed = targets.map(parseWslPath)
    if (parsed.some(location => location === undefined || location.distro.toLowerCase() !== lowered)) return undefined
    const denyRoots = internalDenyRoots(base.distro, input.denyRoots)
    const channel: WslChannel = {
      spawner: input.subprocess, distro: base.distro, wslCwd: input.cwd, scope: input.scope,
      denyRoots, signal: input.signal,
      deny: (internal, relative) => traversalDeny(denyRoots, internal, relative),
    }
    if (input.tool === 'glob') return await wslGlob(channel, input.args)
    if (input.tool === 'grep') return await wslGrep(channel, input.args)
    return await wslReadFiles(channel, input.args)
  } catch {
    // Any channel failure falls back to the existing native worker path, which
    // still answers correctly over 9P. Never a silent degradation: the native
    // result shape is identical, only slower.
    return undefined
  }
}

/** One fixed `find` walk inside the distribution, filtered the way the native walk is. */
export async function listFiles(channel: WslChannel, root: string, requireDirectory: boolean): Promise<{
  files: WslFileRow[]
  scanComplete: boolean
}> {
  const script = requireDirectory ? FIND_SCRIPT : LIST_SCRIPT
  const outcome = await runWsl(channel.spawner, wslArgv(channel.distro, ['sh', '-c', script, 'sh', root]),
    channel.wslCwd, undefined, channel.signal, 16 * 1024 * 1024)
  if (outcome.exitCode === 3) throw new DeferToNative('the native worker owns this path error')
  if (outcome.exitCode !== 0 && (outcome.exitCode !== 1 || outcome.stdout === '')) {
    throw new Error(`find exited ${outcome.exitCode}: ${outcome.stderr.slice(0, 200)}`)
  }
  const rows: WslFileRow[] = []
  for (const record of outcome.stdout.split('\0')) {
    if (record === '') continue
    const first = record.indexOf('\t')
    const second = first === -1 ? -1 : record.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const bytes = Number.parseInt(record.slice(0, first), 10)
    const time = Number.parseFloat(record.slice(first + 1, second))
    if (!Number.isFinite(bytes) || !Number.isFinite(time)) continue
    const relative = record.slice(second + 1)
    if (relative === '' || hasHiddenComponent(relative)) continue
    const internal = `${root.replace(/\/+$/, '')}/${relative}`
    if (channel.deny(internal, relative)) continue
    rows.push({ relative, internal, display: uncDisplay(channel.distro, internal), bytes, modified: time >= 0 ? Math.floor(time * 1000) : null })
  }
  // The walk order is a pure function of the listed paths, so sorting after
  // the filter keeps native ordinals stable without a second traversal.
  rows.sort((a, b) => walkOrder(a.relative, b.relative))
  const truncated = rows.length > MAX_ENTRIES
  return { files: truncated ? rows.slice(0, MAX_ENTRIES) : rows, scanComplete: outcome.exitCode === 0 && !truncated }
}

/** Pack the listed files into base64 tar batches, preserving walk order. */
export async function packBatches(channel: WslChannel, files: readonly WslFileRow[], maxBytesPerBatch: number): Promise<{
  batches: Array<Array<WslFileRow & { data: Buffer }>>
  skipped: Record<string, number>
}> {
  const batches: Array<Array<WslFileRow & { data: Buffer }>> = []
  const skipped: Record<string, number> = {}
  const note = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  let index = 0
  while (index < files.length) {
    if (files[index].bytes > MAX_FILE_BYTES) { note('oversized'); index += 1; continue }
    let total = 0
    const list: WslFileRow[] = []
    while (index < files.length && list.length < 256 && files[index].bytes <= MAX_FILE_BYTES
      && (list.length === 0 || total + files[index].bytes <= maxBytesPerBatch)) {
      total += files[index].bytes
      list.push(files[index])
      index += 1
    }
    const packed = await packBatch(channel, list)
    if (packed === null) throw new Error('tar batch did not settle')
    for (let absent = 0; absent < packed.missing; absent += 1) note('read-error')
    if (packed.entries.length === 0 && list.length > 0) throw new Error('tar batch produced no entries')
    batches.push(packed.entries)
  }
  return { batches, skipped }
}

export async function packBatch(channel: WslChannel, list: readonly WslFileRow[]): Promise<{
  entries: Array<WslFileRow & { data: Buffer }>
  missing: number
} | null> {
  const outcome = await runWsl(channel.spawner, wslArgv(channel.distro, ['sh', '-c', TAR_SCRIPT, 'sh']),
    channel.wslCwd, list.map(file => file.internal).join('\0') + '\0', channel.signal, 48 * 1024 * 1024)
  if (outcome.exitCode !== 0) return null
  const archive = parseTar(Buffer.from(outcome.stdout.replace(/\s+/g, ''), 'base64'))
  if (archive === null) return null
  const byName = new Map(archive.map(entry => [entry.name, entry]))
  const entries: Array<WslFileRow & { data: Buffer }> = []
  let missing = 0
  for (const file of list) {
    const entry = byName.get(file.internal.replace(/^\/+/, ''))
    if (!entry) { missing += 1; continue }
    entries.push({ ...file, data: entry.bytes })
  }
  return { entries, missing }
}

/** Structured SEARCH_STALE, identical to the native cursor's refusal. */
export function staleSearch(): Record<string, unknown> {
  return { status: 'error', error: {
    code: 'SEARCH_STALE', phase: 'preflight', retryable: false, effectState: 'none',
    message: 'Search continuation does not match the current query, authority or filesystem observation',
    nextAction: 'Discard the continuation and start a fresh bounded query; the cursor grants no authority.',
  } }
}

/** Validate a native-shaped `s1:<binding>:<snapshot>:<next>:<digest>` cursor. */
export function openCursor(args: Record<string, unknown>, binding: string): { offset: number; continuation?: string } {
  const raw = typeof args.continuation === 'string' ? args.continuation : undefined
  const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
  if (raw === undefined) return { offset }
  const parts = raw.split(':')
  if (raw.length > 256 || parts.length !== 5 || parts[0] !== 's1' || parts[1] !== binding
    || parts[2].length !== 64 || !/^[0-9a-f]+$/.test(parts[2])
    || digest(`s1:${parts[1]}:${parts[2]}:${parts[3]}`) !== parts[4]) throw new DeferToNative('stale cursor')
  const next = Number.parseInt(parts[3], 10)
  if (!Number.isInteger(next) || next < 0 || (offset !== 0 && offset !== next)) throw new DeferToNative('stale cursor')
  return { offset: next, continuation: raw }
}

/** The channel's continuation token; native callers revalidate it by shape only. */
export function continuationToken(binding: string, snapshot: string, next: number): string {
  const body = `s1:${binding}:${snapshot}:${next}`
  return `${body}:${digest(body)}`
}

/** Revalidated snapshot check after a fresh scan; a mismatch is a stale result. */
export function snapshotMismatch(cursor: { continuation?: string }, snapshot: string): boolean {
  return cursor.continuation !== undefined && cursor.continuation.split(':')[2] !== snapshot
}

/** The query identity a continuation must revalidate against. */
export const cursorBinding = (tool: string, args: Record<string, unknown>, channel: WslChannel, root: string): string =>
  digest([tool, Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'offset' && key !== 'continuation')),
    channel.distro, root, channel.scope, channel.denyRoots])

/** Output-budget page state shared by the search handlers. */
export function pageBudget(items: unknown[], maxBytes = 128 * 1024): (item: unknown) => boolean {
  let used = 8192
  return item => {
    const cost = Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8') + 1
    if (used + cost > maxBytes) return false
    used += cost
    items.push(item)
    return true
  }
}
