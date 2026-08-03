import { afterEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cloudflareModule } from './index'

/**
 * End-to-end resolver tests for the cloudflare module.
 *
 * These exercise the REAL `apply`, not `resolveWorkerValue` in isolation: a stub
 * `wrangler` binary is dropped at `<workdir>/node_modules/.bin/wrangler` (which
 * `resolveWrangler` prefers over `bunx`), so every wrangler invocation — the
 * `deploy` and each `secret put` — is recorded to a log file. The tests assert
 * on what actually reached wrangler: `--var` flags on the deploy call, secret
 * values piped via stdin, and — for the fail-fast contract — that a bad
 * reference throws WITHOUT wrangler ever being run (no half-applied worker).
 */

/**
 * POSIX-sh stub. Records each call (argv + stdin) to $STUB_LOG, and for `deploy`
 * prints a `Deployed … triggers` line + a *.workers.dev URL so the module's
 * success-theater guard and URL parse both pass.
 */
const STUB_WRANGLER = `#!/bin/sh
input="$(cat)"
{
  printf '<<<CALL\\n'
  printf 'argv=%s\\n' "$*"
  printf 'token=%s\\n' "$CLOUDFLARE_API_TOKEN"
  printf 'stdin=%s\\n' "$input"
  printf 'CALL>>>\\n'
} >> "$STUB_LOG"
if [ "$1" = "deploy" ]; then
  printf 'Total Upload: 1 KiB / gzip: 1 KiB\\n'
  printf 'Deployed my-worker triggers (1.23 sec)\\n'
  printf 'https://my-worker.workers.dev\\n'
fi
exit 0
`

interface WranglerCall {
  argv: string[]
  token: string
  stdin: string
}

/** Parse the stub's log into an ordered list of `{ argv, token, stdin }` calls. */
function parseCalls(log: string): WranglerCall[] {
  const calls: WranglerCall[] = []
  const re = /<<<CALL\nargv=(.*)\ntoken=(.*)\nstdin=([\s\S]*?)\nCALL>>>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(log)) !== null) {
    calls.push({ argv: m[1].length ? m[1].split(' ') : [], token: m[2], stdin: m[3] })
  }
  return calls
}

const createdRoots: string[] = []

afterEach(() => {
  delete process.env.STUB_LOG
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Run `apply` against a fresh stubbed workdir; capture calls even on throw. */
async function runApply(opts: {
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  /** Replace the secrets map entirely (no default CLOUDFLARE_API_TOKEN). */
  bareSecrets?: Record<string, string>
  imports?: Record<string, unknown>
}): Promise<{ result?: { deployUrl: string }; error?: Error; calls: WranglerCall[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-stub-'))
  createdRoots.push(root)
  const binDir = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(binDir, { recursive: true })
  const stubPath = path.join(binDir, 'wrangler')
  fs.writeFileSync(stubPath, STUB_WRANGLER, { mode: 0o755 })
  fs.chmodSync(stubPath, 0o755)

  const logPath = path.join(root, 'calls.log')
  process.env.STUB_LOG = logPath

  // Parse through the schema so defaults (workerSecrets/workerVars → []) and the
  // union validation apply exactly as the engine would.
  const config = cloudflareModule.configSchema.parse({
    workdir: '.',
    accountId: 'acct-1',
    ...opts.config,
  })
  const ctx = {
    secrets: opts.bareSecrets ?? { CLOUDFLARE_API_TOKEN: 'cf-token', ...opts.secrets },
    imports: opts.imports ?? {},
    projectRoot: root,
  }

  let result: { deployUrl: string } | undefined
  let error: Error | undefined
  try {
    result = (await cloudflareModule.apply(config, ctx)) as { deployUrl: string }
  } catch (e) {
    error = e as Error
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  return { result, error, calls: parseCalls(log) }
}

const deployCall = (calls: WranglerCall[]) => calls.find((c) => c.argv[0] === 'deploy')
const secretCalls = (calls: WranglerCall[]) =>
  calls.filter((c) => c.argv[0] === 'secret' && c.argv[1] === 'put')

describe('cloudflare apply — sanity', () => {
  test('the stub binary is actually invoked (deploy + URL parsed)', async () => {
    const { result, error, calls } = await runApply({})
    expect(error).toBeUndefined()
    expect(result?.deployUrl).toBe('https://my-worker.workers.dev')
    expect(deployCall(calls)).toBeDefined()
    expect(secretCalls(calls)).toHaveLength(0)
  })
})

describe('cloudflare apply — plain-name resolution (secrets.yaml)', () => {
  test('workerSecrets plain name → secret put with value piped via stdin', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: ['MY_SECRET'] },
      secrets: { MY_SECRET: 's3cr3t' },
    })
    expect(error).toBeUndefined()
    const secrets = secretCalls(calls)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].argv).toEqual(['secret', 'put', 'MY_SECRET'])
    expect(secrets[0].stdin).toBe('s3cr3t')
    // Secret value never rides on the deploy command line.
    expect(deployCall(calls)?.argv.join(' ')).not.toContain('s3cr3t')
  })

  test('workerVars plain name → --var NAME:VALUE on the deploy call', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: ['PUBLIC_CFG'] },
      secrets: { PUBLIC_CFG: 'hello' },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    const i = deploy!.argv.indexOf('--var')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(deploy!.argv[i + 1]).toBe('PUBLIC_CFG:hello')
    expect(secretCalls(calls)).toHaveLength(0)
  })
})

describe('cloudflare apply — import-reference resolution (ctx.imports)', () => {
  test('workerVars { name, from, output } → resolved value as --var under NAME', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: [{ name: 'DB_URL', from: 'main-db', output: 'databaseUrl' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io', authToken: 'tok' } },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    const i = deploy!.argv.indexOf('--var')
    // A colon-bearing value (libsql:// URL) must survive intact after NAME:.
    expect(deploy!.argv[i + 1]).toBe('DB_URL:libsql://x.turso.io')
  })

  test('workerSecrets { name, from, output } → secret put NAME with value via stdin', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: [{ name: 'DB_TOKEN', from: 'main-db', output: 'authToken' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io', authToken: 'tok-123' } },
    })
    expect(error).toBeUndefined()
    const secrets = secretCalls(calls)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].argv).toEqual(['secret', 'put', 'DB_TOKEN'])
    expect(secrets[0].stdin).toBe('tok-123')
    // An imported auth token must not leak onto the deploy command line.
    expect(deployCall(calls)?.argv.join(' ')).not.toContain('tok-123')
  })
})

describe('cloudflare apply — apiToken from an imported instance', () => {
  test('apiToken { from, output } → wrangler runs with the imported value, not secrets.yaml', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'deploy-token', output: 'tokenValue' } },
      imports: { 'deploy-token': { tokenValue: 'minted-tok', tokenId: 'tok-1' } },
    })
    expect(error).toBeUndefined()
    const deploy = deployCall(calls)
    expect(deploy?.token).toBe('minted-tok')
  })

  test('omitted apiToken keeps the secrets.yaml fallback', async () => {
    const { error, calls } = await runApply({})
    expect(error).toBeUndefined()
    expect(deployCall(calls)?.token).toBe('cf-token')
  })

  test('apiToken referencing an instance not in imports → fail-fast, no wrangler', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'ghost', output: 'tokenValue' } },
      imports: {},
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost')
    expect(error!.message).toContain('apiToken')
    expect(calls).toHaveLength(0)
  })

  test('apiToken referencing an output the instance does not emit → fail-fast', async () => {
    const { error, calls } = await runApply({
      config: { apiToken: { from: 'deploy-token', output: 'missing' } },
      imports: { 'deploy-token': { tokenValue: 'minted-tok' } },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('missing')
    expect(error!.message).toContain('deploy-token')
    expect(calls).toHaveLength(0)
  })

  test('no apiToken config and no CLOUDFLARE_API_TOKEN secret → clear error, no wrangler', async () => {
    const { error, calls } = await runApply({ bareSecrets: {} })
    expect(error).toBeDefined()
    expect(error!.message).toContain('CLOUDFLARE_API_TOKEN')
    expect(calls).toHaveLength(0)
  })
})

describe('cloudflare apply — hard errors are fail-fast (no wrangler runs)', () => {
  test('reference to an instance not in imports throws, naming both', async () => {
    const { error, calls } = await runApply({
      config: { workerVars: [{ name: 'X', from: 'ghost', output: 'y' }] },
      imports: {},
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost')
    expect(error!.message).toContain('X')
    expect(error!.message).toContain('imports')
    expect(calls).toHaveLength(0) // fail-fast: wrangler never ran
  })

  test('reference to an output the instance does not emit throws, naming both', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: [{ name: 'X', from: 'main-db', output: 'missing' }] },
      imports: { 'main-db': { databaseUrl: 'libsql://x.turso.io' } },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('missing')
    expect(error!.message).toContain('main-db')
    // Regression guard: a bad workerSecrets ref must NOT deploy first.
    expect(calls).toHaveLength(0)
  })

  test('plain name missing from secrets.yaml throws before deploy', async () => {
    const { error, calls } = await runApply({
      config: { workerSecrets: ['NOPE'] },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('NOPE')
    expect(error!.message).toContain('secrets.yaml')
    expect(calls).toHaveLength(0)
  })
})

// Guard: the stub must be a POSIX-sh script so spawnSync can exec it directly.
test('stub wrangler is executable on this platform', () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-probe-'))
  try {
    const p = path.join(probe, 'wrangler')
    fs.writeFileSync(p, STUB_WRANGLER, { mode: 0o755 })
    fs.chmodSync(p, 0o755)
    const out = execSync(`STUB_LOG=/dev/null ${p} deploy`, { encoding: 'utf8' })
    expect(out).toMatch(/Deployed\s+\S+\s+triggers/)
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})
