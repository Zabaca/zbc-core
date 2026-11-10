import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { createTestContext } from '../../src/testing'
import { d1Module } from './index'

/**
 * The real `apply`/`destroy`/`ready.probe` driven against a stubbed
 * `globalThis.fetch`, the way `../r2/index.test.ts` drives its module: what is
 * asserted is what reached the Cloudflare API.
 */

interface RecordedCall {
  method: string
  path: string
  query: string
  body?: Record<string, unknown>
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Stub the API with a fixed set of existing databases, recording every call. */
function installFetchStub(opts: {
  /** Existing databases, in listing order, as `[name, uuid]`. */
  databases?: Array<[string, string]>
  /** Page size the stub pretends to enforce, so pagination is exercised. */
  perPage?: number
  /** First-match override: `[payload, status]` short-circuits a route. */
  override?: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => [unknown, number] | undefined
}): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const call: RecordedCall = { method, path: url.pathname, query: url.search }
    if (init?.body) call.body = JSON.parse(init.body as string)
    calls.push(call)

    const respond = (result: unknown, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 })

    const overridden = opts.override?.(method, url.pathname, call.body)
    if (overridden) return new Response(JSON.stringify(overridden[0]), { status: overridden[1] })

    if (method === 'GET' && url.pathname.endsWith('/d1/database')) {
      const all = (opts.databases ?? []).map(([name, uuid]) => ({ name, uuid }))
      const perPage = opts.perPage ?? 100
      const page = Number(url.searchParams.get('page') ?? '1')
      const slice = all.slice((page - 1) * perPage, page * perPage)
      return respond(slice, {
        result_info: { page, total_pages: Math.max(1, Math.ceil(all.length / perPage)) },
      })
    }
    if (method === 'POST' && url.pathname.endsWith('/d1/database')) {
      return respond({ name: (call.body as { name: string }).name, uuid: 'new-uuid' })
    }
    return respond(null)
  }) as typeof fetch
  return calls
}

const ctx = () => createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' } })
const config = (over: Record<string, unknown> = {}) =>
  d1Module.configSchema.parse({ accountId: 'acct-1', databaseName: 'proj-prod', ...over })

const creates = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/d1/database'))

describe('apply converges', () => {
  test('an existing database is left alone, and its uuid is the output', async () => {
    const calls = installFetchStub({
      databases: [
        ['other', 'uuid-other'],
        ['proj-prod', 'uuid-1'],
      ],
    })
    const out = await d1Module.apply(config(), ctx())

    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
    expect(creates(calls)).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('a missing database is created, with the location hint when one is given', async () => {
    const calls = installFetchStub({ databases: [['other', 'uuid-other']] })
    const out = await d1Module.apply(config({ primaryLocationHint: 'wnam' }), ctx())

    expect(creates(calls)).toHaveLength(1)
    expect(creates(calls)[0]!.body).toEqual({ name: 'proj-prod', primary_location_hint: 'wnam' })
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'new-uuid' })
  })
})

/** The SQL of every query call the stub saw, in order. */
const sql = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path.endsWith('/query')).map((c) => (c.body as { sql: string }).sql)

describe('schema convergence', () => {
  test('statements run in order against the database that apply just resolved', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.apply(
      config({
        statements: [
          'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)',
          'CREATE INDEX IF NOT EXISTS users_id ON users (id)',
        ],
      }),
      ctx(),
    )

    expect(sql(calls)).toEqual([
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)',
      'CREATE INDEX IF NOT EXISTS users_id ON users (id)',
    ])
    expect(calls.find((c) => c.path.endsWith('/query'))!.path).toBe(
      '/client/v4/accounts/acct-1/d1/database/uuid-1/query',
    )
  })

  test('additiveColumns issue ALTER TABLE … ADD COLUMN', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )

    expect(sql(calls)).toEqual(['ALTER TABLE users ADD COLUMN nickname TEXT'])
  })

  test('a column that is already there is the success case — SQLite has no ADD COLUMN IF NOT EXISTS', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 7500, message: 'duplicate column name: nickname' }],
              },
              400,
            ]
          : undefined,
    })

    const out = await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
  })

  test('any OTHER error from an additive column still fails the apply', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 7500, message: 'no such table: users' }],
              },
              400,
            ]
          : undefined,
    })

    let error: Error | undefined
    try {
      await d1Module.apply(
        config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
        ctx(),
      )
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain('no such table: users')
  })
})

describe('listing', () => {
  test('a database on the second page is found, not re-created', async () => {
    const many: Array<[string, string]> = Array.from({ length: 150 }, (_, i) => [
      `db-${i}`,
      `uuid-${i}`,
    ])
    many[120] = ['proj-prod', 'uuid-120']
    const calls = installFetchStub({ databases: many, perPage: 100 })

    const out = await d1Module.apply(config(), ctx())

    expect(out.databaseId).toBe('uuid-120')
    expect(creates(calls)).toHaveLength(0)
  })
})

describe('destroy', () => {
  test('deletes the database by the uuid it looked up', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.destroy!(config(), ctx())

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.path).toBe('/client/v4/accounts/acct-1/d1/database/uuid-1')
  })

  test('an absent database is reported, not thrown', async () => {
    const calls = installFetchStub({ databases: [['other', 'uuid-other']] })
    await d1Module.destroy!(config(), ctx())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('a lookup that FAILS still throws — only the delete itself is forgiven', async () => {
    // Reporting "already gone" off the back of a 403 is the failure mode this
    // pins: the database is still there, and `zbc destroy` moved on.
    installFetchStub({
      override: (method, path) =>
        method === 'GET' && path.endsWith('/d1/database')
          ? [
              {
                success: false,
                result: null,
                errors: [{ code: 10000, message: 'Authentication error' }],
              },
              403,
            ]
          : undefined,
    })

    expect(d1Module.destroy!(config(), ctx())).rejects.toThrow('Account → D1: Edit')
  })
})

describe('a statement that fails inside a 200 envelope', () => {
  /**
   * D1 answers `/query` with an ARRAY of per-statement results, and a statement
   * can fail inside an envelope whose own `success` is true. Reading only the
   * envelope reports a converged schema that was never applied.
   */
  const perStatementFailure = (message: string) => ({
    databases: [['proj-prod', 'uuid-1'] as [string, string]],
    override: (method: string, path: string) =>
      method === 'POST' && path.endsWith('/query')
        ? ([
            {
              success: true,
              errors: [],
              result: [{ success: false, error: message, results: [] }],
            },
            200,
          ] as [unknown, number])
        : undefined,
  })

  test('fails the apply, naming what SQLite said', async () => {
    installFetchStub(perStatementFailure('no such table: users'))

    let error: Error | undefined
    try {
      await d1Module.apply(config({ statements: ['CREATE INDEX i ON users (id)'] }), ctx())
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain('no such table: users')
  })

  test('is still the duplicate-column success case when that is what it says', async () => {
    installFetchStub(perStatementFailure('duplicate column name: nickname'))

    const out = await d1Module.apply(
      config({ additiveColumns: [{ table: 'users', column: 'nickname', definition: 'TEXT' }] }),
      ctx(),
    )
    expect(out).toEqual({ databaseName: 'proj-prod', databaseId: 'uuid-1' })
  })
})

describe('readiness', () => {
  const outputs = { databaseName: 'proj-prod', databaseId: 'uuid-1' }

  test('a database that refuses a query is not ready', async () => {
    installFetchStub({
      databases: [['proj-prod', 'uuid-1']],
      override: (method, path) =>
        method === 'POST' && path.endsWith('/query')
          ? [{ success: false, result: null, errors: [{ code: 7400, message: 'not found' }] }, 404]
          : undefined,
    })

    let error: Error | undefined
    try {
      await d1Module.ready!.probe(outputs, config(), ctx())
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
  })

  test('a database that answers a query is ready, and the probe is the query the caller will make', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    await d1Module.ready!.probe(outputs, config(), ctx())

    expect(sql(calls)).toEqual(['SELECT 1'])
    expect(calls[0]!.path).toBe('/client/v4/accounts/acct-1/d1/database/uuid-1/query')
  })
})

describe('apiToken from an imported instance', () => {
  /** Every Authorization header the API saw, wrapped around the usual stub. */
  function recordTokens(): string[] {
    const tokens: string[] = []
    const stub = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('authorization') ?? '')
      return stub(input, init)
    }) as typeof fetch
    return tokens
  }
  const minted = () =>
    createTestContext({
      secrets: { CLOUDFLARE_API_TOKEN: 'tok' },
      imports: { 'deploy-token': { tokenValue: 'minted-tok', tokenId: 'tok-1' } },
    })
  const fromImport = { apiToken: { from: 'deploy-token', output: 'tokenValue' } }

  test('apply, destroy and the probe all use the imported value, not secrets.yaml', async () => {
    installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    const tokens = recordTokens()
    const c = minted()
    await d1Module.apply(config({ ...fromImport, statements: ['SELECT 1'] }), c)
    await d1Module.ready!.probe(
      { databaseName: 'proj-prod', databaseId: 'uuid-1' },
      config(fromImport),
      c,
    )
    await d1Module.destroy!(config(fromImport), c)

    expect(tokens.length).toBeGreaterThan(0)
    expect(new Set(tokens)).toEqual(new Set(['Bearer minted-tok']))
    expect(c.secretsRead).not.toContain('CLOUDFLARE_API_TOKEN')
  })

  test('omitted apiToken keeps the secrets.yaml fallback', async () => {
    installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    const tokens = recordTokens()
    await d1Module.apply(config(), ctx())
    expect(new Set(tokens)).toEqual(new Set(['Bearer tok']))
  })

  test('an apiToken naming an instance that is not imported fails before any call', async () => {
    const calls = installFetchStub({ databases: [['proj-prod', 'uuid-1']] })
    let error: Error | undefined
    try {
      await d1Module.apply(config({ apiToken: { from: 'ghost', output: 'tokenValue' } }), ctx())
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain('ghost')
    expect(calls).toHaveLength(0)
  })
})

/**
 * `migrationsDir`: a versioned history applied by wrangler's own migrator, on
 * this instance's apply, so a Worker that imports the database is deployed
 * only after its schema is there.
 *
 * A stub `wrangler` at `<projectRoot>/node_modules/.bin/wrangler` records its
 * argv, the credential it ran with and the config file it was handed (deleted
 * by the time apply returns, so the log is the only outside view of it).
 */
describe('migrationsDir', () => {
  const STUB = `#!/bin/sh
{
  printf '<<<CALL\\n'
  printf 'argv=%s\\n' "$*"
  printf 'token=%s\\n' "$CLOUDFLARE_API_TOKEN"
  printf 'account=%s\\n' "$CLOUDFLARE_ACCOUNT_ID"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--config" ]; then printf 'config=%s\\n' "$(cat "$arg")"; fi
    prev="$arg"
  done
  printf 'CALL>>>\\n'
} >> "$STUB_LOG"
if [ -n "$STUB_FAIL" ]; then echo "Migration 0002_bad.sql failed" >&2; exit 1; fi
if [ -n "$STUB_UP_TO_DATE" ]; then echo "✅ No migrations to apply!"; exit 0; fi
echo "Migrations to be applied: 0001_init.sql"
echo "✅ 0001_init.sql"
exit 0
`

  const roots: string[] = []
  afterEach(() => {
    delete process.env.STUB_LOG
    delete process.env.STUB_FAIL
    delete process.env.STUB_UP_TO_DATE
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  /** A project root with the stub wrangler and a migrations folder at `db/migrations`. */
  function project(): { root: string; log: string } {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'd1-mig-'))
    roots.push(root)
    fs.mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(join(root, 'node_modules', '.bin', 'wrangler'), STUB, { mode: 0o755 })
    fs.mkdirSync(join(root, 'db', 'migrations'), { recursive: true })
    fs.writeFileSync(join(root, 'db', 'migrations', '0001_init.sql'), 'CREATE TABLE t (id TEXT);\n')
    const log = join(root, 'calls.log')
    process.env.STUB_LOG = log
    return { root, log }
  }

  interface Run {
    argv: string[]
    token: string
    account: string
    config?: Record<string, unknown>
  }
  const runs = (log: string): Run[] =>
    fs.existsSync(log)
      ? [
          ...fs
            .readFileSync(log, 'utf8')
            .matchAll(
              /<<<CALL\nargv=(.*)\ntoken=(.*)\naccount=(.*)\n(?:config=([\s\S]*?)\n)?CALL>>>/g,
            ),
        ].map((m) => ({
          argv: m[1]!.split(' '),
          token: m[2]!,
          account: m[3]!,
          config: m[4] ? (JSON.parse(m[4]) as Record<string, unknown>) : undefined,
        }))
      : []

  test('wrangler applies the folder to the resolved database, by id, with this instance’s credential', async () => {
    const { root, log } = project()
    installFetchStub({ databases: [['northfield-forms', 'uuid-forms']] })
    await d1Module.apply(
      config({ databaseName: 'northfield-forms', migrationsDir: 'db/migrations' }),
      createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
    )

    const [run, ...rest] = runs(log)
    expect(rest).toHaveLength(0)
    expect(run!.argv.slice(0, 5)).toEqual([
      'd1',
      'migrations',
      'apply',
      'northfield-forms',
      '--remote',
    ])
    expect(run!.token).toBe('tok')
    expect(run!.account).toBe('acct-1')
    // The id is given, so wrangler uses it verbatim rather than looking the name up.
    expect(run!.config).toEqual({
      name: 'zbc-d1-migrations',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'northfield-forms',
          database_id: 'uuid-forms',
          migrations_dir: join(root, 'db', 'migrations'),
        },
      ],
    })
    // The throwaway config is gone afterwards.
    const configPath = run!.argv[run!.argv.indexOf('--config') + 1]!
    expect(fs.existsSync(configPath)).toBe(false)
  })

  test('a database created by this apply is migrated under its new id', async () => {
    const { root, log } = project()
    installFetchStub({ databases: [] })
    await d1Module.apply(
      config({ databaseName: 'northfield-forms', migrationsDir: 'db/migrations' }),
      createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
    )
    const d1 = runs(log)[0]!.config!.d1_databases as Array<Record<string, string>>
    expect(d1[0]!.database_id).toBe('new-uuid')
  })

  test('the history runs before the end-state statements', async () => {
    // A replayed `CREATE … IF NOT EXISTS` after the history is harmless; a
    // statement creating a table BEFORE a migration that creates it without
    // the guard would fail the migration.
    const { root, log } = project()
    let migratedFirst: boolean | undefined
    installFetchStub({
      databases: [['northfield-forms', 'uuid-forms']],
      override: (_method, p) => {
        if (p.endsWith('/query') && migratedFirst === undefined)
          migratedFirst = runs(log).length === 1
        return undefined
      },
    })
    await d1Module.apply(
      config({
        databaseName: 'northfield-forms',
        migrationsDir: 'db/migrations',
        statements: ['CREATE INDEX IF NOT EXISTS t_id ON t (id)'],
      }),
      createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
    )
    expect(migratedFirst).toBe(true)
  })

  test('a folder that is not there fails before anything is called', async () => {
    const { root, log } = project()
    const calls = installFetchStub({ databases: [] })
    const error = await d1Module
      .apply(
        config({ databaseName: 'northfield-forms', migrationsDir: 'db/nowhere' }),
        createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
      )
      .then(
        () => undefined,
        (e: Error) => e,
      )
    expect(error?.message).toContain('db/nowhere')
    expect(calls).toHaveLength(0)
    expect(runs(log)).toHaveLength(0)
  })

  test('a failed migration fails the apply, names the failure, and runs no statement after it', async () => {
    const { root } = project()
    process.env.STUB_FAIL = '1'
    const calls = installFetchStub({ databases: [['northfield-forms', 'uuid-forms']] })
    const error = await d1Module
      .apply(
        config({
          databaseName: 'northfield-forms',
          migrationsDir: 'db/migrations',
          statements: ['CREATE INDEX IF NOT EXISTS t_id ON t (id)'],
        }),
        createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
      )
      .then(
        () => undefined,
        (e: Error) => e,
      )
    expect(error?.message).toContain('0002_bad.sql')
    expect(sql(calls)).toEqual([])
  })

  /**
   * Adoption: a database made before this instance existed (by hand, by a
   * deploy script, by another module) whose history wrangler has already
   * applied. The instance must take it over as it is: found by name, never
   * created, never renamed, its id the output, and the migration step a no-op
   * that succeeds. What wrangler skips is wrangler's ledger's business; what
   * is asserted here is that the module itself writes nothing and does not
   * read "nothing to apply" as a failure.
   */
  test('an existing, already-migrated database is adopted: no create, same id, nothing applied', async () => {
    const { root, log } = project()
    process.env.STUB_UP_TO_DATE = '1'
    const calls = installFetchStub({
      databases: [
        ['northfield-other', 'uuid-other'],
        ['northfield-forms', 'uuid-live-forms'],
      ],
    })
    const out = await d1Module.apply(
      config({ databaseName: 'northfield-forms', migrationsDir: 'db/migrations' }),
      createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
    )

    expect(out).toEqual({ databaseName: 'northfield-forms', databaseId: 'uuid-live-forms' })
    // Every API call was a read: no create, no rename, no delete.
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    // Wrangler was asked once, about the live database by its live id.
    const [run, ...rest] = runs(log)
    expect(rest).toHaveLength(0)
    const d1 = run!.config!.d1_databases as Array<Record<string, string>>
    expect(d1[0]).toMatchObject({
      database_name: 'northfield-forms',
      database_id: 'uuid-live-forms',
    })
  })

  test('unset, wrangler is never run', async () => {
    const { root, log } = project()
    installFetchStub({ databases: [['northfield-forms', 'uuid-forms']] })
    await d1Module.apply(
      config({ databaseName: 'northfield-forms' }),
      createTestContext({ secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, projectRoot: root }),
    )
    expect(runs(log)).toHaveLength(0)
  })
})
