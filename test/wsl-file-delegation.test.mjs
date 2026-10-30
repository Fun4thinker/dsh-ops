/**
 * WSL delegation for the read-only file tools.
 *
 * On Windows with an installed distribution the suite runs real behavior: it
 * creates fixtures inside the Linux filesystem through `wsl.exe`, then drives
 * the host bridge (`lib/file/worker.js`) with a WSL UNC session cwd and asserts
 * the tools execute through `wsl.exe -d <distro> -e ...` while returning the
 * native result shape with UNC display paths. Without wsl.exe or a distro the
 * suite is a named skip; the fallback test additionally proves the native
 * worker still answers when the channel is unavailable.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, skipSuite } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
import { invoke } from '../lib/file/worker.js'
import { parseWslPath, uncDisplay, walkOrder, globMatch } from '../lib/file/wsl.js'
import { delegateWslFileTool } from '../lib/file/wsl-delegate.js'

const label = 'wsl-file-delegation'
if (process.platform !== 'win32') skipSuite(label, 'wsl.exe is only available on Windows')
requireWorker(label)

await test('UNC roots map to distro-internal paths and back, case-insensitively', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\proj'),
    { distro: 'Ubuntu-22.04', internal: '/home/u/proj' })
  assert.equal(uncDisplay('Ubuntu-22.04', '/home/u/proj'), '\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\proj')
  assert.deepEqual(parseWslPath('//WSL$/Ubuntu/home/u'), { distro: 'Ubuntu', internal: '/home/u' })
  assert.deepEqual(parseWslPath('\\\\WSL.LOCALHOST\\Ubuntu\\home\\u'), { distro: 'Ubuntu', internal: '/home/u' })
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu/home/u'), { distro: 'Ubuntu', internal: '/home/u' })
  for (const value of ['C:\\x', '\\\\wsl.localhost\\Ubuntu', '\\\\other\\share\\x', 'relative', null, 42, '/home/u']) {
    assert.equal(parseWslPath(value), undefined, String(value))
  }
})

await test('walk order and glob matching reproduce the native traversal rules', () => {
  // Depth-first with sorted siblings: '/' ranks below every other character.
  const listed = ['c.txt', 'b/x', 'a.txt', 'b', 'src/z.ts', 'src/deep/a.ts']
  assert.deepEqual([...listed].sort(walkOrder),
    ['a.txt', 'b', 'b/x', 'c.txt', 'src/deep/a.ts', 'src/z.ts'])
  assert.ok(globMatch(['**/*.ts'], 'src/deep/a.ts'))
  assert.ok(!globMatch(['**/*.ts'], 'src/a.txt'))
  assert.ok(globMatch(['**/*', '!node_modules/**'], 'src/a.ts'))
  assert.ok(!globMatch(['**/*', '!node_modules/**'], 'node_modules/a.ts'))
})

function listDistro() {
  const probe = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8' })
  const name = probe.replace(/\0/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0]
  return name
}

const DISTRO = listDistro()
if (!DISTRO) skipSuite(label, 'no WSL distribution is installed')

const runInDistro = (script, ...args) =>
  execFileSync('wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', script, 'sh', ...args], { encoding: 'utf8' })
const b64 = content => Buffer.from(content).toString('base64')
const home = runInDistro('printf %s "$HOME"').trim()
const FIXTURE = `${home}/dsh-ops-wsl-fixtures-${process.pid}`
const UNC = `\\\\wsl.localhost\\${DISTRO}${FIXTURE.replaceAll('/', '\\')}`
const display = relative => `\\\\wsl.localhost\\${DISTRO}${`${FIXTURE}/${relative}`.replaceAll('/', '\\')}`
const execOf = () => ({ agent: { session: { id: 'wsl-file-delegation', header: { cwd: UNC } } },
  signal: new AbortController().signal })

try {
  runInDistro('mkdir -p "$1" "$1/src" "$1/node_modules"', FIXTURE)
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/a.txt`, b64('alpha\nbeta needle\ngamma\n'))
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/src/code.ts`, b64('const needle = 1\nplain line\n'))
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/notes.md`, b64('# needle here\nmore\n'))
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/.hidden`, b64('needle\n'))
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/node_modules/pkg.js`, b64('needle\n'))
  runInDistro('printf %s "$2" | base64 -d > "$1"', `${FIXTURE}/bin.dat`, Buffer.from([0xff, 0x00]).toString('base64'))
  runInDistro('touch "$1/.keep"', FIXTURE)

  async function withHost(mode) {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess)
      const sent = []
      const service = ctx.get('subprocess')
      const raw = service.spawn.bind(service)
      service.spawn = spec => { sent.push(spec); return raw(spec) }
      await ctx.plugin(inner => inner.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: UNC }) }))
      return { ctx, sent }
    } catch (error) {
      await shutdown(ctx)
      throw error
    }
  }

  await test('glob scans inside the distribution and maps results back to UNC paths', async () => {
    const { ctx, sent } = await withHost('read-only')
    try {
      const exec = execOf()
      const value = await invoke(ctx, WORKER, 'glob',
        { path: '.', pattern: ['**/*.txt', '**/*.ts', '**/*.md'] }, exec, exec.signal)
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(sent.length, 1, JSON.stringify(sent.map(spec => spec.argv)))
      assert.ok(sent[0].argv[0].toLowerCase().endsWith('wsl.exe'), JSON.stringify(sent[0].argv))
      assert.deepEqual(sent[0].argv.slice(1, 3), ['-d', DISTRO])
      assert.equal(sent[0].argv[3], '-e', 'the channel is data-driven argv, never a shell string')
      assert.deepEqual(value.items, ['a.txt', 'notes.md', 'src/code.ts'].map(display))
      assert.equal(value.complete, true)
      assert.equal(value.total, 3)
      assert.equal(value.matchedTotal, 3)
      assert.equal(value.scanComplete, true)
      assert.equal(value.truncatedBy, 'none')
      assert.equal(value.sandbox.boundary, 'trusted-native-file-operations')
      const details = await invoke(ctx, WORKER, 'glob',
        { path: '.', pattern: ['a.txt'], outputMode: 'details' }, exec, exec.signal)
      assert.equal(details.items[0].path, display('a.txt'))
      assert.equal(details.items[0].bytes, 'alpha\nbeta needle\ngamma\n'.length)
      assert.equal(typeof details.items[0].modified, 'number')
      const page = await invoke(ctx, WORKER, 'glob', { path: '.', pattern: ['**/*'], limit: 1 }, exec, exec.signal)
      assert.equal(page.items.length, 1)
      assert.equal(page.complete, false)
      assert.equal(page.nextOffset, 1)
      assert.equal(typeof page.continuation, 'string')
      const next = await invoke(ctx, WORKER, 'glob',
        { path: '.', pattern: ['**/*'], limit: 1, continuation: page.continuation }, exec, exec.signal)
      assert.equal(next.items.length, 1)
      assert.equal(next.nextOffset, 2)
      assert.equal(next.items[0], display('bin.dat'))
      assert.equal(page.items[0], display('a.txt'))
      const stale = await invoke(ctx, WORKER, 'glob',
        { path: '.', pattern: ['**/*'], limit: 1, continuation: 's1:bogus:0'.padEnd(64, '0') + ':1:x' }, exec, exec.signal)
      assert.equal(stale.error?.code ?? stale.error, 'SEARCH_STALE', JSON.stringify(stale))
    } finally { await shutdown(ctx) }
  })

  await test('grep finds fixture matches with UNC paths, line numbers and native modes', async () => {
    const { ctx, sent } = await withHost('read-only')
    try {
      const exec = execOf()
      const value = await invoke(ctx, WORKER, 'grep', { path: '.', pattern: 'needle' }, exec, exec.signal)
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(sent.length >= 2, true, 'one find walk plus at least one tar batch')
      assert.ok(sent[0].argv[0].toLowerCase().endsWith('wsl.exe'))
      assert.equal(value.matched, 3)
      assert.equal(value.total, 3)
      assert.deepEqual(value.items.map(item => [item.path, item.line, item.text]), [
        [display('a.txt'), 2, 'beta needle'],
        [display('notes.md'), 1, '# needle here'],
        [display('src/code.ts'), 1, 'const needle = 1'],
      ])
      const context = await invoke(ctx, WORKER, 'grep',
        { path: '.', pattern: 'needle', beforeContext: 1, afterContext: 1 }, exec, exec.signal)
      assert.equal(context.items[0].text, 'alpha\nbeta needle\ngamma')
      const folded = await invoke(ctx, WORKER, 'grep',
        { path: '.', pattern: 'NEEDLE', caseInsensitive: true }, exec, exec.signal)
      assert.equal(folded.matched, 3)
      const counts = await invoke(ctx, WORKER, 'grep',
        { path: '.', pattern: 'needle', outputMode: 'count' }, exec, exec.signal)
      assert.deepEqual(counts.items.map(item => [item.path, item.count]), [
        [display('a.txt'), 1], [display('notes.md'), 1], [display('src/code.ts'), 1],
      ])
      const summary = await invoke(ctx, WORKER, 'grep',
        { path: '.', pattern: 'needle', outputMode: 'summary' }, exec, exec.signal)
      assert.deepEqual({ files: summary.files, matches: summary.matches }, { files: 3, matches: 3 })
      assert.deepEqual(summary.items, [])
      const filter = await invoke(ctx, WORKER, 'grep',
        { path: '.', pattern: 'needle', glob: ['**/*.ts'] }, exec, exec.signal)
      assert.deepEqual(filter.items.map(item => item.path), [display('src/code.ts')])
    } finally { await shutdown(ctx) }
  })

  await test('read_files returns native-shaped items with exact revisions and encodings', async () => {
    const { ctx, sent } = await withHost('read-only')
    try {
      const exec = execOf()
      const content = 'alpha\nbeta needle\ngamma\n'
      const value = await invoke(ctx, WORKER, 'read_files',
        { files: [{ path: 'a.txt' }, { path: 'a.txt', offset: 2 }, { path: 'bin.dat' }] }, exec, exec.signal)
      assert.equal(value.status, 'partial', JSON.stringify(value))
      assert.equal(value.complete, false)
      assert.equal(value.matched, 2)
      assert.equal(value.failed, 1)
      assert.equal(value.total, 3)
      assert.equal(value.nextIndex, 3)
      assert.equal(value.items[0].status, 'completed')
      assert.equal(value.items[0].path, display('a.txt'))
      assert.equal(value.items[0].revision, createHash('sha256').update(content).digest('hex'))
      assert.equal(value.items[0].bytes, content.length)
      assert.equal(value.items[0].lineCount, 3)
      assert.equal(value.items[0].items[0].line, 1)
      assert.equal(value.items[0].items[0].text, 'alpha')
      assert.equal(value.items[0].complete, true)
      assert.equal(value.items[1].items[0].line, 2)
      assert.equal(value.items[1].items[0].text, 'beta needle')
      assert.equal(value.items[1].nextOffset, 4)
      assert.equal(value.items[1].complete, true, 'the offset page reaches the end of the file')
      assert.equal(value.items[2].status, 'error')
      assert.equal(value.items[2].error.code, 'ERR_INVALID_ENCODING')
      assert.ok(sent.every(spec => spec.argv[0].toLowerCase().endsWith('wsl.exe')), 'no native worker spawn')
    } finally { await shutdown(ctx) }
  })

  await test('an unavailable wsl.exe falls back to the native worker, visibly', async () => {
    process.env.DSH_OPS_WSL_EXE = 'wsl.exe-not-present-dsh-ops'
    const { ctx, sent } = await withHost('read-only')
    try {
      const exec = execOf()
      const value = await invoke(ctx, WORKER, 'grep', { path: '.', pattern: 'needle' }, exec, exec.signal)
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(value.matched, 3, JSON.stringify(value))
      assert.equal(sent.length, 2, JSON.stringify(sent.map(spec => spec.argv)))
      assert.ok(sent[0].argv[0].includes('not-present'), 'the channel was attempted first')
      assert.equal(sent[1].argv[0], WORKER, 'the native worker answered the fallback')
    } finally {
      delete process.env.DSH_OPS_WSL_EXE
      await shutdown(ctx)
    }
  })

  await test('mutating and single-file tools never enter the WSL channel', async () => {
    const { ctx, sent } = await withHost('workspace-write')
    try {
      const exec = execOf()
      // The native worker itself refuses mutations on a 9P filesystem
      // (LOCK_UNSUPPORTED) — the point here is only that the request went to
      // the worker binary, never to the WSL channel.
      const written = await invoke(ctx, WORKER, 'write_file',
        { path: 'created.txt', content: 'made\n', expectedRevision: 'absent' }, exec, exec.signal)
      assert.equal(written.status, 'error', JSON.stringify(written))
      assert.equal(written.error.code, 'LOCK_UNSUPPORTED', JSON.stringify(written))
      assert.equal(sent.length, 1)
      assert.equal(sent[0].argv[0], WORKER)
      const readBack = await invoke(ctx, WORKER, 'stat', { path: 'a.txt' }, exec, exec.signal)
      assert.equal(readBack.status, 'completed', JSON.stringify(readBack))
      assert.equal(readBack.revision, createHash('sha256').update('alpha\nbeta needle\ngamma\n').digest('hex'))
      assert.equal(sent.length, 2)
      assert.equal(sent[1].argv[0], WORKER)
      const refused = await delegateWslFileTool({
        subprocess: { spawn() { throw new Error('must not spawn') } }, tool: 'replace',
        args: { path: UNC, pattern: 'a', replacement: 'b' }, cwd: UNC, scope: 'unit', denyRoots: [],
      })
      assert.equal(refused, undefined)
    } finally { await shutdown(ctx) }
  })
} finally {
  try { runInDistro('rm -rf "$1"', FIXTURE) } catch { /* the fixture is under the distro home; best effort */ }
}

report(label)
