/**
 * Minimal GNU tar reader for the WSL channel's batched file transport.
 *
 * The channel packs the requested files with
 * `tar --null --verbatim-files-from --no-recursion --format=gnu -P -c -f - -T -`
 * and base64-encodes the stream, so bytes cross `wsl.exe` losslessly and the
 * host can hash, decode and slice each file exactly as the native worker
 * would have over 9P. Only the record shapes that pipeline can produce are
 * parsed: ustar headers, GNU long names (`L`), and regular files.
 *
 * @module dsh-ops/file/wsl-tar
 */
export interface TarEntry { name: string; bytes: Buffer }

const HEADER = 512

function text(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start)
  return buffer.subarray(start, end === -1 || end > start + length ? start + length : end).toString('utf8')
}

function octal(buffer: Buffer, start: number, length: number): number {
  const raw = buffer.subarray(start, start + length)
  // GNU base-256 encoding marks high sizes with a 0x80 lead byte; the channel
  // caps files far below it, so treat it as corrupt rather than guess.
  if (raw[0] & 0x80) return -1
  const value = Number.parseInt(raw.toString('ascii').replace(/[\0 ]+$/, ''), 8)
  return Number.isFinite(value) ? value : -1
}

/**
 * Parse one base64-decoded tar archive into regular-file entries, in stream
 * order. GNU long-name (`L`) and pax (`x`) prologue records are folded into
 * the following entry; directories, links and other types are skipped.
 * Returns null when the stream is not a well-formed tar the channel produced.
 */
export function parseTar(buffer: Buffer): TarEntry[] | null {
  const entries: TarEntry[] = []
  let longName: string | undefined
  let paxName: string | undefined
  for (let offset = 0; offset + HEADER <= buffer.length;) {
    const block = buffer.subarray(offset, offset + HEADER)
    if (block.length !== HEADER) return null
    offset += HEADER
    if (block.every(byte => byte === 0)) break
    const nameField = text(block, 0, 100)
    const prefix = block[345] !== 0 ? text(block, 345, 155) : ''
    const typeflag = String.fromCharCode(block[156] || 0)
    const size = octal(block, 124, 12)
    if (size < 0 || offset + size > buffer.length) return null
    const data = buffer.subarray(offset, offset + size)
    offset += Math.ceil(size / HEADER) * HEADER
    if (typeflag === 'L') { longName = data.subarray(0, data.indexOf(0)).toString('utf8'); continue }
    if (typeflag === 'x') { paxName = paxPath(data); continue }
    if (typeflag !== '0' && typeflag !== '\0') { longName = undefined; paxName = undefined; continue }
    const name = longName ?? paxName ?? (prefix !== '' ? `${prefix}/${nameField}` : nameField)
    longName = undefined
    paxName = undefined
    if (name === '') return null
    entries.push({ name: name.replace(/^\/+/, ''), bytes: Buffer.from(data) })
  }
  return entries
}

/** Extract the value of a pax `path` record, if the archive carries one. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(32, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    if (record.startsWith('path=')) return record.slice(5)
    offset += length
  }
  return undefined
}
