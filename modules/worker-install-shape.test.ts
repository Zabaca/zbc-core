import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cloudflareModule } from './cloudflare/index'
import { cloudflareAccessModule } from './cloudflare-access/index'
import { d1Module } from './d1/index'
import { queueModule } from './queue/index'
import { r2Module } from './r2/index'

/**
 * One whole install of a Worker-served app, as an install kit builds it: a
 * Worker behind a whole-host Access application, a nested application on one
 * path, a machine's door with its own service token, a guest path open to
 * everyone, a raw-mail bucket, a delivery-report queue, and a database with a
 * migration history. Every config below is the SHAPE such a kit produces; the
 * values are an invented company's.
 *
 * Each module's real `apply` runs, in the order `imports` would put them in,
 * against ONE stubbed Cloudflare account and a stub `wrangler`, and each
 * instance's outputs are handed to the Worker's instance as its imports. What
 * is asserted is what reached the API and wrangler: so a module that refused,
 * or silently dropped, a field this shape relies on fails here.
 *
 * The forms database and its files bucket are instances of their own (`d1`
 * with its migration history, `r2`), applied before the Worker that imports
 * them, and retained: they hold records no teardown may delete.
 */

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const HOST = 'space.northfield.example'
const TEAM = 'northfield.cloudflareaccess.com'
const DEPLOY_TOKEN = { secret: 'CLOUDFLARE_API_TOKEN' }
const DELIVERY_EVENTS = [
  'message.delivered',
  'message.deferred',
  'message.bounced',
  'message.failed',
  'message.rejected',
  'message.complained',
]

// ── One account, stubbed, that remembers what it was told ───────────────────

interface Account {
  org: { name: string; auth_domain: string }
  providers: Array<{ id: string; type: string; name: string }>
  apps: Array<Record<string, unknown> & { id: string; aud: string; domain: string; name: string }>
  policies: Array<Record<string, unknown> & { id: string; appId: string; name: string }>
  tokens: Array<{ id: string; name: string; client_id: string }>
  buckets: string[]
  queues: Array<{ queue_id: string; queue_name: string }>
  subscriptions: Array<Record<string, unknown> & { id: string }>
  databases: Array<{ name: string; uuid: string }>
  calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>
}

const account = (): Account => ({
  org: { name: 'Northfield Works', auth_domain: TEAM },
  providers: [{ id: 'idp-otp', type: 'onetimepin', name: '' }],
  apps: [],
  policies: [],
  tokens: [],
  buckets: [],
  queues: [],
  subscriptions: [],
  databases: [],
  calls: [],
})

const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 })

function installAccount(a: Account): void {
  let n = 1
  const aud = () => (n++).toString(16).padStart(64, '0')
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined
    a.calls.push({ method, path: url.pathname, body })
    const p = url.pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '')

    if (p === '/access/organizations') return ok(a.org)
    if (p === '/access/identity_providers') return ok(a.providers)
    if (p === '/access/service_tokens') {
      if (method === 'GET') return ok(a.tokens)
      const t = { id: `svc-${n++}`, name: String(body?.name), client_id: `cid-${n}.access` }
      a.tokens.push(t)
      return ok({ ...t, client_secret: 'minted-once' })
    }
    if (p === '/access/apps') {
      if (method === 'GET') return ok(a.apps)
      const app = { id: `app-${n++}`, aud: aud(), ...body } as Account['apps'][number]
      a.apps.push(app)
      return ok(app)
    }
    const appOne = p.match(/^\/access\/apps\/([^/]+)$/)
    if (appOne) {
      const app = a.apps.find((x) => x.id === appOne[1])!
      Object.assign(app, body)
      return ok(app)
    }
    const pol = p.match(/^\/access\/apps\/([^/]+)\/policies$/)
    if (pol) {
      if (method === 'GET') return ok(a.policies.filter((x) => x.appId === pol[1]))
      const made = { id: `pol-${n++}`, appId: pol[1]!, ...body } as Account['policies'][number]
      a.policies.push(made)
      return ok(made)
    }
    const polOne = p.match(/^\/access\/apps\/([^/]+)\/policies\/([^/]+)$/)
    if (polOne) {
      const found = a.policies.find((x) => x.id === polOne[2])!
      Object.assign(found, body)
      return ok(found)
    }
    if (p === '/r2/buckets') {
      if (method === 'GET') return ok({ buckets: a.buckets.map((name) => ({ name })) })
      a.buckets.push(String(body?.name))
      return ok({ name: body?.name })
    }
    if (p === '/queues') {
      if (method === 'GET') return ok(a.queues)
      const q = { queue_id: `q-${n++}`, queue_name: String(body?.queue_name) }
      a.queues.push(q)
      return ok(q)
    }
    if (p === '/event_subscriptions/subscriptions') {
      if (method === 'GET') return ok(a.subscriptions)
      const s = { id: `sub-${n++}`, ...body }
      a.subscriptions.push(s)
      return ok(s)
    }
    if (p === '/d1/database') {
      if (method === 'GET') return ok(a.databases, { result_info: { page: 1, total_pages: 1 } })
      const db = { name: String(body?.name), uuid: `db-${n++}` }
      a.databases.push(db)
      return ok(db)
    }
    if (/^\/d1\/database\/[^/]+\/query$/.test(p)) return ok([{ success: true }])
    throw new Error(`the stub account has no route for ${method} ${url.pathname}`)
  }) as typeof fetch
}

// ── A project root with a stub wrangler ─────────────────────────────────────

const WRANGLER = `#!/bin/sh
input="$(cat)"
{
  printf '<<<CALL\\n'
  printf 'argv=%s\\n' "$*"
  printf 'token=%s\\n' "$CLOUDFLARE_API_TOKEN"
  printf 'stdin=%s\\n' "$input"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--config" ]; then printf 'config=%s\\n' "$(cat "$arg")"; fi
    prev="$arg"
  done
  printf 'CALL>>>\\n'
} >> "$STUB_LOG"
if [ "$1" = "deploy" ]; then printf 'Uploaded northfield-space\\nDeployed northfield-space triggers (0.5 sec)\\n'; fi
if [ "$1" = "secret" ]; then printf 'Creating the secret for the Worker "northfield-space"\\nSuccess! Uploaded secret %s\\n' "$3"; fi
if [ "$1" = "d1" ]; then printf 'Migrations to be applied: 0001_forms.sql\\n'; fi
exit 0
`

interface WranglerCall {
  argv: string[]
  token: string
  stdin: string
  config?: Record<string, unknown>
}

function wranglerCalls(log: string): WranglerCall[] {
  if (!fs.existsSync(log)) return []
  const re = /<<<CALL\nargv=(.*)\ntoken=(.*)\nstdin=([\s\S]*?)\n(?:config=([\s\S]*?)\n)?CALL>>>/g
  return [...fs.readFileSync(log, 'utf8').matchAll(re)].map((m) => ({
    argv: m[1]!.split(' '),
    token: m[2]!,
    stdin: m[3]!,
    config: m[4] ? (JSON.parse(m[4]) as Record<string, unknown>) : undefined,
  }))
}

let root = ''
let log = ''
const realFetch = globalThis.fetch

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-shape-'))
  for (const bin of [
    path.join(root, 'node_modules', '.bin'),
    path.join(root, 'packages', 'space', 'node_modules', '.bin'),
  ]) {
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'wrangler'), WRANGLER, { mode: 0o755 })
  }
  fs.mkdirSync(path.join(root, 'packages', 'forms', 'migrations'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'packages', 'forms', 'migrations', '0001_forms.sql'),
    'CREATE TABLE form (id TEXT);\n',
  )
  log = path.join(root, 'wrangler.log')
  process.env.STUB_LOG = log
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.STUB_LOG
  fs.rmSync(root, { recursive: true, force: true })
})

const secrets = {
  CLOUDFLARE_API_TOKEN: 'deploy-token',
  FORMS_DATA_KEY: 'data-key-value',
  NORTHFIELD_FORMS_SEAL_KEY: 'seal-key-value',
  INBOX_VAPID_KEY: 'vapid-value',
}
const ctx = (imports: Record<string, unknown> = {}) => ({ secrets, imports, projectRoot: root })

// ── The shapes ──────────────────────────────────────────────────────────────

/** The whole host, for people: a month's session, a SameSite=Lax cookie. */
const spaceAccess = {
  name: 'Northfield space',
  accountId: ACCOUNT,
  apiToken: DEPLOY_TOKEN,
  teamDomain: TEAM,
  domain: HOST,
  policyName: 'Northfield people',
  emails: ['tessa@northfield.example', 'owen@northfield.example'],
  identityProviders: ['onetimepin'],
  sameSiteCookieAttribute: 'lax',
  sessionDuration: '720h',
}

/** One path under it, for people, with its own cookie so the two sessions stay apart. */
const formsAccess = {
  name: 'Northfield forms',
  accountId: ACCOUNT,
  apiToken: DEPLOY_TOKEN,
  teamDomain: TEAM,
  domain: `${HOST}/forms`,
  policyName: 'Northfield forms people',
  emails: ['tessa@northfield.example'],
  pathCookieAttribute: true,
  sessionDuration: '24h',
}

/** A machine's door: no people, a token minted once and never rotated, no cookie. */
const agentAccess = {
  name: 'Northfield agent door',
  accountId: ACCOUNT,
  apiToken: DEPLOY_TOKEN,
  teamDomain: TEAM,
  domain: `${HOST}/api/agent`,
  emails: [],
  serviceTokenName: 'northfield agent',
  rotate: false,
  sessionDuration: '0s',
}

/** A guest path: no sign-in at the edge, the Worker authenticates every request. */
const guestChat = {
  name: 'Northfield guest chat',
  accountId: ACCOUNT,
  apiToken: DEPLOY_TOKEN,
  teamDomain: TEAM,
  domain: `${HOST}/w/*`,
  bypass: true,
  emails: [],
  policyName: 'Northfield guests',
  sessionDuration: '24h',
  appLauncherVisible: false,
}

const rawMail = { accountId: ACCOUNT, bucketName: 'northfield-inbox-raw' }
const formsFiles = { accountId: ACCOUNT, bucketName: 'northfield-forms-files' }
const formsDb = {
  accountId: ACCOUNT,
  databaseName: 'northfield-forms',
  migrationsDir: 'packages/forms/migrations',
}
const delivery = {
  accountId: ACCOUNT,
  queueName: 'northfield-delivery',
  subscriptions: [
    {
      name: 'northfield-sending',
      zoneId: 'f'.repeat(32),
      domain: 'northfield.example',
      events: DELIVERY_EVENTS,
    },
  ],
}

const worker = {
  workdir: 'packages/space',
  accountId: ACCOUNT,
  build: {
    command:
      "env SPACE_DECLARATION='../installs/northfield/declaration.json' sh -c 'echo built > built.txt'",
  },
  workerSecrets: [
    'FORMS_DATA_KEY',
    { name: 'FORMS_SEAL_KEY', secret: 'NORTHFIELD_FORMS_SEAL_KEY' },
    'INBOX_VAPID_KEY',
  ],
  workerVars: [
    { name: 'CF_ACCESS_AUD', from: 'space-access', output: 'aud' },
    { name: 'CF_ACCESS_AUD_FORMS', from: 'space-forms-access', output: 'aud' },
    { name: 'CF_ACCESS_AUD_AGENT', from: 'space-agent-access', output: 'aud' },
    { name: 'INBOX_ACCESS_CLIENT_ID', from: 'space-agent-access', output: 'clientId' },
    { name: 'GMAIL_PUSH_ENDPOINT', value: 'https://push.northfield.example/api/gmail/push' },
  ],
}

// ── The proof ───────────────────────────────────────────────────────────────

describe('an install kit’s shapes are accepted by zbc’s modules', () => {
  test('every config validates, with nothing it relies on stripped', () => {
    const access = [spaceAccess, formsAccess, agentAccess, guestChat].map((c) =>
      cloudflareAccessModule.configSchema.parse(c),
    )
    expect(access[0]!.sameSiteCookieAttribute).toBe('lax')
    expect(access[1]!.pathCookieAttribute).toBe(true)
    expect(access[2]!.serviceTokenName).toBe('northfield agent')
    expect(access[3]!.bypass).toBe(true)
    expect(access.map((c) => c.apiToken)).toEqual([
      DEPLOY_TOKEN,
      DEPLOY_TOKEN,
      DEPLOY_TOKEN,
      DEPLOY_TOKEN,
    ])

    expect(queueModule.configSchema.parse(delivery).subscriptions[0]!.events).toEqual(
      DELIVERY_EVENTS,
    )
    expect(d1Module.configSchema.parse(formsDb).migrationsDir).toBe('packages/forms/migrations')
    expect(r2Module.configSchema.parse(rawMail).bucketName).toBe('northfield-inbox-raw')

    const w = cloudflareModule.configSchema.parse(worker)
    expect(w.workerSecrets).toEqual(worker.workerSecrets)
    expect(w.workerVars).toEqual(worker.workerVars)
    expect(w.build?.command).toBe(worker.build.command)
  })

  test('applied in import order, it provisions everything and deploys the Worker last, wired', async () => {
    const a = account()
    installAccount(a)

    // What the Worker imports, applied first, as `imports` orders them.
    const outputs: Record<string, Record<string, unknown>> = {}
    outputs['inbox-raw'] = await r2Module.apply(r2Module.configSchema.parse(rawMail), ctx())
    outputs['space-forms-files'] = await r2Module.apply(
      r2Module.configSchema.parse(formsFiles),
      ctx(),
    )
    outputs['space-forms-db'] = await d1Module.apply(d1Module.configSchema.parse(formsDb), ctx())
    outputs['inbox-delivery'] = await queueModule.apply(
      queueModule.configSchema.parse(delivery),
      ctx(),
    )
    for (const [name, config] of [
      ['space-access', spaceAccess],
      ['space-forms-access', formsAccess],
      ['space-agent-access', agentAccess],
      ['space-guest-chat', guestChat],
    ] as const) {
      outputs[name] = await cloudflareAccessModule.apply(
        cloudflareAccessModule.configSchema.parse(config),
        ctx(),
      )
    }
    const migrated = wranglerCalls(log).length
    const out = await cloudflareModule.apply(
      cloudflareModule.configSchema.parse(worker),
      ctx(outputs),
    )

    // The two buckets, the queue and its subscription, the database.
    expect(a.buckets.toSorted()).toEqual(['northfield-forms-files', 'northfield-inbox-raw'])
    expect(a.queues.map((q) => q.queue_name)).toEqual(['northfield-delivery'])
    expect(a.subscriptions).toHaveLength(1)
    expect(a.subscriptions[0]).toMatchObject({
      name: 'northfield-sending',
      source: { type: 'email.sending', zone_id: 'f'.repeat(32), domain: 'northfield.example' },
      destination: { type: 'queues.queue', queue_id: outputs['inbox-delivery']!.queueId },
      events: DELIVERY_EVENTS,
    })
    expect(a.databases.map((d) => d.name)).toEqual(['northfield-forms'])

    // The migration ran on the database's own apply, before the Worker's.
    const [migration] = wranglerCalls(log)
    expect(migrated).toBe(1)
    expect(migration!.argv.slice(0, 5)).toEqual([
      'd1',
      'migrations',
      'apply',
      'northfield-forms',
      '--remote',
    ])
    expect(migration!.token).toBe('deploy-token')
    expect((migration!.config!.d1_databases as Array<Record<string, string>>)[0]).toMatchObject({
      database_id: outputs['space-forms-db']!.databaseId,
      migrations_dir: path.join(root, 'packages', 'forms', 'migrations'),
    })

    // The four Access applications, each with what its shape is for.
    const app = (domain: string) => a.apps.find((x) => x.domain === domain)!
    expect(app(HOST)).toMatchObject({
      same_site_cookie_attribute: 'lax',
      path_cookie_attribute: false,
      session_duration: '720h',
    })
    expect(app(`${HOST}/forms`)).toMatchObject({
      path_cookie_attribute: true,
      session_duration: '24h',
    })
    expect('same_site_cookie_attribute' in app(`${HOST}/forms`)).toBe(false)
    expect(app(`${HOST}/api/agent`)).toMatchObject({ session_duration: '0s' })
    expect(app(`${HOST}/w/*`)).toMatchObject({ app_launcher_visible: false })
    const policyOf = (domain: string) => a.policies.filter((x) => x.appId === app(domain).id)
    expect(policyOf(HOST)).toEqual([
      expect.objectContaining({ name: 'Northfield people', decision: 'allow' }),
    ])
    expect(policyOf(`${HOST}/api/agent`)).toEqual([
      expect.objectContaining({ name: 'northfield agent service token', decision: 'non_identity' }),
    ])
    expect(policyOf(`${HOST}/w/*`)).toEqual([
      expect.objectContaining({
        name: 'Northfield guests',
        decision: 'bypass',
        include: [{ everyone: {} }],
      }),
    ])
    expect(a.tokens.map((t) => t.name)).toEqual(['northfield agent'])

    // The Worker: built, then deployed with the imported values as vars.
    expect(fs.readFileSync(path.join(root, 'packages', 'space', 'built.txt'), 'utf8').trim()).toBe(
      'built',
    )
    const deploy = wranglerCalls(log)
      .slice(migrated)
      .find((c) => c.argv[0] === 'deploy')!
    const vars = deploy.argv.filter((_, i) => deploy.argv[i - 1] === '--var')
    expect(vars).toEqual([
      `CF_ACCESS_AUD:${outputs['space-access']!.aud}`,
      `CF_ACCESS_AUD_FORMS:${outputs['space-forms-access']!.aud}`,
      `CF_ACCESS_AUD_AGENT:${outputs['space-agent-access']!.aud}`,
      `INBOX_ACCESS_CLIENT_ID:${outputs['space-agent-access']!.clientId}`,
      'GMAIL_PUSH_ENDPOINT:https://push.northfield.example/api/gmail/push',
    ])
    expect(String(outputs['space-access']!.aud)).toMatch(/^[0-9a-f]{64}$/)
    expect(deploy.token).toBe('deploy-token')

    // Secrets by stdin, under the name the code reads, from the key sops holds.
    const pushed = wranglerCalls(log)
      .filter((c) => c.argv[0] === 'secret')
      .map((c) => [c.argv[2], c.stdin])
    expect(pushed).toEqual([
      ['FORMS_DATA_KEY', 'data-key-value'],
      ['FORMS_SEAL_KEY', 'seal-key-value'],
      ['INBOX_VAPID_KEY', 'vapid-value'],
    ])
    expect(deploy.argv.join(' ')).not.toContain('seal-key-value')
    expect(out.workerName).toBe('northfield-space')
  })

  test('the second apply of every provisioning instance creates nothing', async () => {
    const a = account()
    installAccount(a)
    const once = async () => {
      await r2Module.apply(r2Module.configSchema.parse(rawMail), ctx())
      await d1Module.apply(d1Module.configSchema.parse(formsDb), ctx())
      await queueModule.apply(queueModule.configSchema.parse(delivery), ctx())
      for (const config of [spaceAccess, formsAccess, agentAccess, guestChat]) {
        await cloudflareAccessModule.apply(cloudflareAccessModule.configSchema.parse(config), ctx())
      }
    }
    await once()
    const before = a.calls.length
    await once()
    const writes = a.calls.slice(before).filter((c) => c.method === 'POST' || c.method === 'DELETE')
    expect(writes).toEqual([])
  })

  test('as instances: the records’ database and bucket are retained, and the Worker imports them', () => {
    // The instance files a kit writes. The two stores that hold records carry
    // `retain`, so no `zbc destroy` of the environment can delete them; the raw
    // mail bucket, the queue and the Access applications are left as they are.
    const files = r2Module.instance({ name: 'space-forms-files', config: formsFiles, retain: true })
    const db = d1Module.instance({ name: 'space-forms-db', config: formsDb, retain: true })
    const raw = r2Module.instance({ name: 'inbox-raw', config: rawMail })
    const queue = queueModule.instance({ name: 'inbox-delivery', config: delivery })
    const space = cloudflareModule.instance({
      name: 'space',
      config: worker,
      imports: [raw, queue, files, db],
    })

    expect(files.retain).toBe(true)
    expect(db.retain).toBe(true)
    expect(files._definition.destroy).toBeUndefined()
    expect(db._definition.destroy).toBeUndefined()
    // The modules still delete for every instance that does not opt out.
    expect(raw._definition.destroy).toBeDefined()
    expect(space.imports.map((i) => i.name)).toEqual([
      'inbox-raw',
      'inbox-delivery',
      'space-forms-files',
      'space-forms-db',
    ])
    // Neither store is wired through `cloudflare`: the Worker's own settings
    // bind both by name, which needs no key on the deploying module.
    const parsed = cloudflareModule.configSchema.parse(worker)
    expect(parsed.bindings).toEqual([])
    expect(parsed.r2Bindings).toEqual([])
  })
})
