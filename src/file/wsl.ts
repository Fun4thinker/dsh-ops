/**
 * WSL delegation channel: UNC detection, path mapping and data-driven execution.
 *
 * When a session's cwd (and every operation path) lives under
 * `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`, the read-only file
 * tools route their scans through the Linux distribution instead of the 9P
 * filesystem. The channel is data-driven only: every command is a fixed
 * program with all variable data passed as argv elements or stdin, never
 * interpolated into a shell string.
 *
 * Any channel failure (wsl.exe missing, distro absent, command error) throws
 * {@link WslChannelFailure}; the caller then falls back to the existing native
 * worker, which still answers correctly over 9P. That fallback is deliberate:
 * it is slower, never wrong, and never silent — the native result shape is
 * identical either way.
 *
 * @module dsh-ops/file/wsl
 */
import { createHash } from 'node:crypto'

/** Shared worker constants, mirrored from `native/crates/ops-protocol`. */
export const MAX_ENTRIES = 100_000
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 128 * 1024

/** Elevated set of fixed scripts the channel executes; data never enters them. */
export const FIND_SCRIPT = 'test -d "$1" || exit 3\n'
  + 'exec find "$1" -maxdepth 128 \\( -type d \\( -name .git -o -name .dsh-ops -o -name node_modules '
  + '-o -name target -o -name .venv \\) -prune \\) -o \\( -type f -printf \'%s\\t%T@\\t%P\\0\' \\)'
export const LIST_SCRIPT = 'exec find "$1" -maxdepth 128 \\( -type d \\( -name .git -o -name .dsh-ops '
  + '-o -name node_modules -o -name target -o -name .venv \\) -prune \\) -o \\( -type f -printf \'%s\\t%T@\\t%P\\0\' \\)'
export const TAR_SCRIPT = 'exec tar --null --verbatim-files-from --no-recursion --format=gnu -P -c -f - -T - | base64'

/** Structural projection of the host subprocess service the channel needs. */
export interface WslOutputReader { readFrom(offset: number): { text: string; lossy: boolean } }
export interface WslSpawner {
  spawn(spec: { argv: string[]; cwd: string; graceMs: number; signal?: AbortSignal;
    stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } } }): {
    done: Promise<{ exitCode?: number | null; signal?: unknown }>
    collected: { stdout?: WslOutputReader | null; stderr?: WslOutputReader | null }
  }
}

/** A channel failure the caller answers by running the existing native worker. */
export class WslChannelFailure extends Error {}

export interface WslLocation { distro: string; internal: string }

/**
 * Parse a WSL UNC root into its distribution and distro-internal path.
 *
 * `\\wsl.localhost\Ubuntu\home\x` and its forward-slash, `wsl$` and any-case
 * spellings all map to `{ distro: 'Ubuntu', internal: '/home/x' }`. Anything
 * else — including the bare `\\wsl.localhost\Ubuntu` share root — is not
 * delegable and returns undefined.
 */
export function parseWslPath(value: unknown): WslLocation | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)(?:[\\/]+([^\\/]+))?([^]*)$/i.exec(value)
  if (!match || match[1] === undefined) return undefined
  const rest = match[2].replace(/^[\\/]+/, '')
  if (rest === '') return undefined
  return { distro: match[1], internal: `/${rest.replace(/[\\/]+/g, '/')}` }
}

/** Map a distro-internal absolute path back to its canonical UNC display form. */
export function uncDisplay(distro: string, internal: string): string {
  return `\\\\wsl.localhost\\${distro}${internal.replaceAll('/', '\\')}`
}

/** The wsl.exe executable, overridable so a suite can simulate its absence. */
export function wslExecutable(): string {
  return process.env.DSH_OPS_WSL_EXE || 'wsl.exe'
}

/** Build one data-driven `wsl.exe -d <distro> -e <argv>` invocation. */
export function wslArgv(distro: string, command: readonly string[]): string[] {
  return [wslExecutable(), '-d', distro, '-e', ...command]
}

/**
 * Run one command inside the distribution through the host subprocess service.
 *
 * Throws {@link WslChannelFailure} for spawn-level failures (service missing,
 * output readers unavailable, truncation, interruption). A nonzero exit code
 * is returned as data so callers decide between a structured error and a
 * fallback per command.
 */
export async function runWsl(
  spawner: WslSpawner,
  argv: readonly string[],
  cwd: string,
  input: string | undefined,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<{ exitCode: number | null | undefined; stdout: string; stderr: string }> {
  signal?.throwIfAborted?.()
  let handle: ReturnType<WslSpawner['spawn']>
  try {
    handle = spawner.spawn({
      argv: [...argv], cwd, graceMs: 1000, signal,
      stdio: { stdin: { data: input ?? '' }, stdout: { maxBytes }, stderr: { maxBytes: 16 * 1024 } },
    })
  } catch (error) {
    throw new WslChannelFailure(`Delegated command could not start: ${(error as Error)?.message ?? error}`)
  }
  if (!handle?.done || !handle.collected?.stdout || !handle.collected?.stderr) {
    throw new WslChannelFailure('Delegated command output readers are unavailable.')
  }
  const outcome = await handle.done
  if (signal?.aborted || outcome.signal) throw new WslChannelFailure('Delegated command was interrupted.')
  const stdout = handle.collected.stdout.readFrom(0)
  if (stdout.lossy) throw new WslChannelFailure('Delegated command output exceeded the collection budget.')
  return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: handle.collected.stderr.readFrom(0).text }
}

/**
 * Depth-first walk order: siblings sorted, '/' ranking below every other
 * character. This reproduces the native worker's sorted pre-order traversal,
 * so result ordinals and paging match the 9P path.
 */
export function walkOrder(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index)
    const b = right.charCodeAt(index)
    if (a === b) continue
    if (a === 47) return -1
    if (b === 47) return 1
    return a - b
  }
  return left.length - right.length
}

/** Whether any relative component is hidden; the native walk excludes these. */
export function hasHiddenComponent(relative: string): boolean {
  return relative.split('/').some(component => component.startsWith('.'))
}

/** Component-level glob matching, ported from the native `glob_match`. */
export function globMatch(patterns: readonly string[], value: string): boolean {
  const positives = patterns.filter(pattern => !pattern.startsWith('!'))
  const included = positives.length === 0 || positives.some(pattern => matchGlob(pattern, value))
  const excluded = patterns.some(pattern => pattern.startsWith('!') && matchGlob(pattern.slice(1), value))
  return included && !excluded
}

function matchGlob(pattern: string, value: string): boolean {
  return globSegments(pattern.replace(/^\.\//, '').split('/'), value.split('/'))
}

function globSegments(pattern: readonly string[], value: readonly string[]): boolean {
  if (pattern.length === 0) return value.length === 0
  if (pattern[0] === '**') return globSegments(pattern.slice(1), value)
    || (value.length > 0 && globSegments(pattern, value.slice(1)))
  return value.length > 0 && segmentMatch(pattern[0], value[0]) && globSegments(pattern.slice(1), value.slice(1))
}

function segmentMatch(pattern: string, value: string): boolean {
  let pi = 0
  let vi = 0
  let star = -1
  let mark = 0
  while (vi < value.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern.charCodeAt(pi) === value.charCodeAt(vi)
      || asciiLower(pattern[pi]) === asciiLower(value[vi]))) { pi += 1; vi += 1 }
    else if (pi < pattern.length && pattern[pi] === '*') { star = pi; pi += 1; mark = vi }
    else if (star >= 0) { pi = star + 1; mark += 1; vi = mark }
    else return false
  }
  while (pi < pattern.length && pattern[pi] === '*') pi += 1
  return pi === pattern.length
}

const asciiLower = (character: string): string =>
  character >= 'A' && character <= 'Z' ? String.fromCharCode(character.charCodeAt(0) + 32) : character

/**
 * Per-file credential names the native worker refuses during traversal,
 * ported from `ops-protocol`'s fixed expression (case-insensitive).
 */
const CREDENTIAL_NAMES = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(\.|$)|[^/]*credentials[^/]*\.(json|ya?ml|ini)$|service-account[^/]*\.json$|\.env(\.|$))/i
export const isCredentialName = (relative: string): boolean => CREDENTIAL_NAMES.test(relative)

/** Internalize the host deny roots that live in this same distribution. */
export function internalDenyRoots(distro: string, denyRoots: readonly string[]): string[] {
  const lowered = distro.toLowerCase()
  const roots: string[] = []
  for (const root of denyRoots) {
    const parsed = parseWslPath(root)
    if (parsed && parsed.distro.toLowerCase() === lowered) roots.push(parsed.internal.replace(/\/+$/, ''))
  }
  return roots
}

/** One traversal deny verdict: root identity, credential names, or neither. */
export function traversalDeny(denyRoots: readonly string[], internal: string, relative: string): boolean {
  return denyRoots.some(root => internal === root || internal.startsWith(`${root}/`)) || isCredentialName(relative)
}

/** Stable digests for continuation binding and scan snapshots. */
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')

/**
 * Physical LF-delimited lines, matching Rust `str::lines`: splits on `\n`,
 * strips one trailing `\r`, and never counts a phantom final empty line.
 */
export function textLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Serialized UTF-8 cost of one candidate, as the native output budget counts it. */
export const jsonSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
