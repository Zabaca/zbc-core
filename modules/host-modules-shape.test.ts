import { describe, expect, test } from 'bun:test'
import { systemdUnitModule } from './systemd-unit/index'
import { hostFileModule } from './host-file/index'
import { dockerComposeStackModule } from './docker-compose-stack/index'
import { hostDirModule } from './host-dir/index'
import { hostSymlinkModule } from './host-symlink/index'
import { systemdMaskModule } from './systemd-mask/index'
import { withExec } from './host-exec/index'

/**
 * Shape guard for the host-converging modules (contributed from foundry,
 * 2026-08-03): they import '../../src/define-module', so this test breaks if
 * the core split layout ever moves the engine out from under them — and it
 * pins each module's converge identity (name + minimal valid config).
 */

describe('host-converging modules parse in the core layout', () => {
  test('systemd-unit', () => {
    expect(systemdUnitModule.name).toBe('systemd-unit')
    const parsed = systemdUnitModule.configSchema.parse({
      unit: 'x.service',
      content: '[Unit]\n',
    })
    expect(parsed.scope).toBe('user')
    expect(parsed.enableNow).toBe(true)
  })

  test('host-file requires exactly one content source', () => {
    expect(hostFileModule.name).toBe('host-file')
    expect(hostFileModule.configSchema.parse({ path: '/tmp/x', content: 'hi' }).mode).toBe('0644')
    expect(() => hostFileModule.configSchema.parse({ path: '/tmp/x' })).toThrow()
    expect(() =>
      hostFileModule.configSchema.parse({ path: '/tmp/x', content: 'a', secretKey: 'B' }),
    ).toThrow()
  })

  test('docker-compose-stack', () => {
    expect(dockerComposeStackModule.name).toBe('docker-compose-stack')
    expect(dockerComposeStackModule.configSchema.parse({ dir: '/srv/app' }).services).toEqual([])
  })
})

test('host-file creates secret-bearing files with the target mode from the first byte', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfile-'))
  try {
    const dest = path.join(dir, 'secret.env')
    const config = hostFileModule.configSchema.parse({
      path: dest,
      secretKey: 'TOKEN',
      mode: '0600',
    })
    await hostFileModule.apply(config, {
      secrets: { TOKEN: 'v' },
      imports: {},
      projectRoot: dir,
    })
    // No world-readable window: the file must be created 0600, not merely
    // chmod'ed to it after a default-umask write.
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── The host primitives (contributed from foundry, 2026-08-18) ──────────────
//
// Four more host-converging modules, promoted as one group because they are
// closed under their own imports: `host-dir` reaches the machine through
// `host-exec`, and the other two reach it through `node:fs` alone.
//
// `host-exec` is the reason this block is not just four more copies of the
// paragraph above. It is not a module — it exports no `defineModule` — it is
// the seam a test stands in front of, and it makes `host-dir` the FIRST core
// module to import a sibling module directory. Core's other nine import
// `../../src/define-module` and nothing else, so nothing here has ever pinned
// that a `../<module>` edge resolves at all. The `withExec` test below is that
// pin: it fails if the split ever flattens the modules directory, and it fails
// if `host-exec` is dropped from a copy-mode install.

describe('the host primitives parse in the core layout', () => {
  test('host-dir defaults its mode and refuses a path a shell would reinterpret', () => {
    expect(hostDirModule.name).toBe('host-dir')
    const parsed = hostDirModule.configSchema.parse({ path: '/srv/store', owner: 'app:app' })
    expect(parsed.mode).toBe('0755')
    // Relative: resolved against whatever cwd the apply ran in, so it succeeds
    // against the wrong directory rather than failing.
    expect(() =>
      hostDirModule.configSchema.parse({ path: 'srv/store', owner: 'app:app' }),
    ).toThrow()
    // The path is interpolated into `stat` and `chown`.
    expect(() =>
      hostDirModule.configSchema.parse({ path: '/srv/a;rm -rf /', owner: 'app:app' }),
    ).toThrow()
    // Three digits parse and read right, which is exactly why they are refused.
    expect(() =>
      hostDirModule.configSchema.parse({ path: '/srv/store', owner: 'app:app', mode: '755' }),
    ).toThrow()
    expect(() => hostDirModule.configSchema.parse({ path: '/srv/store', owner: 'app' })).toThrow()
  })

  test('host-symlink requires both ends absolute', () => {
    expect(hostSymlinkModule.name).toBe('host-symlink')
    const parsed = hostSymlinkModule.configSchema.parse({ path: '/home/u/.x', target: '/opt/x' })
    expect(parsed.target).toBe('/opt/x')
    expect(() => hostSymlinkModule.configSchema.parse({ path: '.x', target: '/opt/x' })).toThrow()
    // A link stores its target verbatim and resolves it against the LINK's
    // directory, not the cwd — so a relative target is a second rule for no gain.
    expect(() =>
      hostSymlinkModule.configSchema.parse({ path: '/home/u/.x', target: '../x' }),
    ).toThrow()
  })

  test('systemd-mask demands a unit suffix and a reason a stranger can act on', () => {
    expect(systemdMaskModule.name).toBe('systemd-mask')
    const reason = 'superseded by the pull-based collector; see the 2026-08 migration'
    expect(systemdMaskModule.configSchema.parse({ unit: 'x.service', reason }).unit).toBe(
      'x.service',
    )
    expect(() => systemdMaskModule.configSchema.parse({ unit: 'x', reason })).toThrow()
    // A masked unit is invisible until somebody wonders why a thing will not
    // start, so a one-word reason is refused by length.
    expect(() =>
      systemdMaskModule.configSchema.parse({ unit: 'x.service', reason: 'old' }),
    ).toThrow()
  })
})

test('host-dir converges through the host-exec seam, so the sibling edge resolves', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostdir-'))
  try {
    const target = path.join(dir, 'store')
    const commands: string[] = []
    // A small in-memory machine, not a call recorder: `stat` answers with the
    // owner the previous `chown` set, so applying twice sees the state the
    // first pass left behind and a no-op is a measurement rather than a guess.
    let owner = 'root:root'
    const fake = (command: string): string => {
      commands.push(command)
      if (command.startsWith('stat ')) return `${owner}\n`
      // `sudo chown <user>:<group> <path>` — the sudo is the module's, and
      // matching on the whole prefix is what caught this fake being wrong.
      const chown = /^sudo chown (?<owner>\S+) /.exec(command)
      if (chown) {
        owner = chown.groups!.owner!
        return ''
      }
      throw new Error(`unexpected command: ${command}`)
    }

    const config = hostDirModule.configSchema.parse({
      path: target,
      owner: 'app:app',
      mode: '0750',
    })
    const first = await withExec(fake, () =>
      hostDirModule.apply(config, { secrets: {}, imports: {}, projectRoot: dir }),
    )
    expect(first.changed).toBe(true)
    // The declared mode, not whatever the process umask allowed: `mkdirSync`'s
    // mode argument is masked, so a create alone lands at 0750 & ~umask.
    expect(fs.statSync(target).mode & 0o777).toBe(0o750)
    expect(commands.some((c) => c.startsWith('sudo chown '))).toBe(true)

    // Second apply: settled. The seam is what makes this observable — a real
    // `execSync` here would report the machine's owner, not the fake's.
    commands.length = 0
    const second = await withExec(fake, () =>
      hostDirModule.apply(config, { secrets: {}, imports: {}, projectRoot: dir }),
    )
    expect(second.changed).toBe(false)
    expect(commands.filter((c) => c.startsWith('sudo chown '))).toEqual([])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── A citation that belongs to another repository has to say so ─────────────
//
// The promoted files keep foundry's bare `ADR-NNNN` and ticket references
// rather than having them stripped, on the stated argument that "a reference a
// reader can go and find beats a rationale nobody can check". That argument
// only holds if the reader is told whose numbering it is. `ADR-0023` resolves
// to nothing here — and, worse than nothing, this repository is free to mint an
// ADR-0023 of its own tomorrow, at which point the citation reads as a live
// reference to the wrong document.
//
// The rule arrived as a sentence in a header comment and arrived half-kept:
// `host-exec/index.test.ts` cited ADR-0023 twice with nothing in the file
// naming foundry at all, and `host-exec/index.ts` had lost two citations in a
// paragraph rewrite. Both were invisible, because a policy written in prose has
// no failure surface. This is the same policy as a computation.
test('every file citing a bare ADR number names the repository those ADRs belong to', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')

  const sources = fs
    .readdirSync(import.meta.dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts'))
    .map((p) => ({ p, text: fs.readFileSync(path.join(import.meta.dir, p), 'utf8') }))

  // The walk itself, before anything is concluded from it: a mistyped root or a
  // changed readdir signature would make every claim below vacuously true.
  expect(sources.length).toBeGreaterThanOrEqual(10)

  const citing = sources.filter((s) => /ADR-\d{4}/.test(s.text)).map((s) => s.p)
  // Floor of three against four today. Not a count to keep in step — a file is
  // free to stop citing — but a filter that matched nothing must not read as a
  // clean sweep.
  expect(citing.length).toBeGreaterThanOrEqual(3)
  // Named because it is the file the guard was written for.
  expect(citing).toContain(path.join('host-exec', 'index.test.ts'))

  const unattributed = sources
    .filter((s) => /ADR-\d{4}/.test(s.text) && !/foundry/i.test(s.text))
    .map((s) => s.p)
  expect(unattributed).toEqual([])
})
