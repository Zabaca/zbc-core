import { afterEach, describe, expect, test } from 'bun:test'
import { cloudflareAccessModule, policyBody } from './index'

/**
 * Same pattern as `cloudflare-tunnel/index.test.ts`: the REAL `apply` runs
 * against a stubbed `globalThis.fetch` backed by an in-memory Cloudflare that
 * POST/PUT actually mutate, so "the second apply does not rotate" is an honest
 * assertion rather than a restatement of the stub.
 *
 * Nothing here touches the network.
 */

const ACCOUNT = 'acct-1'

interface World {
  tokens: Array<{ id: string; name: string; client_id: string }>
  apps: Array<{ id: string; name: string; domain: string }>
  policies: Array<{ id: string; name: string; appId: string; body: unknown }>
  calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>
  rotations: number
}

const emptyWorld = (): World => ({ tokens: [], apps: [], policies: [], calls: [], rotations: 0 })

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 })

function installFetch(world: World): void {
  let n = 1
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined
    world.calls.push({ method, url, body })
    const { pathname } = new URL(url)
    const B = `/client/v4/accounts/${ACCOUNT}`

    if (pathname === `${B}/access/service_tokens`) {
      if (method === 'GET') return ok(world.tokens)
      const t = {
        id: `svc-${n++}`,
        name: String(body?.name),
        client_id: 'cid.access',
        client_secret: 'SECRET-1',
      }
      world.tokens.push({ id: t.id, name: t.name, client_id: t.client_id })
      return ok(t)
    }
    const rot = pathname.match(new RegExp(`^${B}/access/service_tokens/([^/]+)/rotate$`))
    if (rot) {
      world.rotations++
      const t = world.tokens.find((x) => x.id === rot[1])!
      return ok({ ...t, client_secret: 'SECRET-2' })
    }
    if (pathname === `${B}/access/apps`) {
      if (method === 'GET') return ok(world.apps)
      const a = { id: `app-${n++}`, name: String(body?.name), domain: String(body?.domain) }
      world.apps.push(a)
      return ok(a)
    }
    const appOne = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)$`))
    if (appOne) {
      const a = world.apps.find((x) => x.id === appOne[1])!
      Object.assign(a, { name: body?.name, domain: body?.domain })
      return ok(a)
    }
    const pol = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)/policies$`))
    if (pol) {
      if (method === 'GET') return ok(world.policies.filter((p) => p.appId === pol[1]))
      const p = { id: `pol-${n++}`, name: String(body?.name), appId: pol[1]!, body }
      world.policies.push(p)
      return ok(p)
    }
    const polOne = pathname.match(new RegExp(`^${B}/access/apps/([^/]+)/policies/([^/]+)$`))
    if (polOne) {
      const p = world.policies.find((x) => x.id === polOne[2])!
      p.body = body
      return ok(p)
    }
    throw new Error(`stub has no route for ${method} ${url}`)
  }) as typeof fetch
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const ctx = { secrets: {}, imports: { tok: { tokenValue: 'api-token' } } }
const config = (over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  apiToken: { from: 'tok', output: 'tokenValue' },
  name: 'cedarpad workspace',
  domain: 'ws.cedarpad.com',
  serviceTokenName: 'cedarpad-worker',
  ...over,
})
const apply = (c: Record<string, unknown>) =>
  cloudflareAccessModule.apply(cloudflareAccessModule.configSchema.parse(c) as never, ctx as never)

describe('policyBody', () => {
  test('uses a non_identity decision — an identity policy rejects a token outright', () => {
    expect(policyBody('p', 'svc-1', '0s').decision).toBe('non_identity')
  })

  test('lists the token under include (OR), not require (AND)', () => {
    const b = policyBody('p', 'svc-1', '0s')
    expect(b.include).toEqual([{ service_token: { token_id: 'svc-1' } }])
    expect('require' in b).toBe(false)
  })
})

describe('apply', () => {
  test('creates token, app and policy, and surfaces the secret exactly once', async () => {
    const world = emptyWorld()
    installFetch(world)
    const out = await apply(config())

    expect(out.created).toBe(true)
    expect(out.changed).toBe(true)
    expect(out.clientId).toBe('cid.access')
    expect(out.clientSecret).toBe('SECRET-1')
    expect(world.apps[0]).toMatchObject({ name: 'cedarpad workspace', domain: 'ws.cedarpad.com' })
    expect(world.policies).toHaveLength(1)
    // The policy must name the token that was just created.
    expect((world.policies[0]!.body as { include: unknown }).include).toEqual([
      { service_token: { token_id: out.serviceTokenId } },
    ])
  })

  test('the second apply does NOT rotate — the Worker keeps the secret it holds', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(config())
    const out = await apply(config())

    expect(world.rotations).toBe(0)
    expect(out.created).toBe(false)
    expect(out.clientSecret).toBe('') // nothing to capture; the live one is unchanged
    expect(world.tokens).toHaveLength(1)
    expect(world.apps).toHaveLength(1)
    expect(world.policies).toHaveLength(1)
  })

  test('rotate: true mints a new secret, deliberately', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(config())
    const out = await apply(config({ rotate: true }))

    expect(world.rotations).toBe(1)
    expect(out.clientSecret).toBe('SECRET-2')
    expect(out.changed).toBe(true)
  })

  test('a changed domain updates the app in place rather than making a second one', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(config())
    const out = await apply(config({ domain: 'ws2.cedarpad.com' }))

    expect(world.apps).toHaveLength(1)
    expect(world.apps[0]!.domain).toBe('ws2.cedarpad.com')
    expect(out.changed).toBe(true)
  })

  test('session_duration defaults to 0s — a machine caller must never get a cookie', async () => {
    const world = emptyWorld()
    installFetch(world)
    await apply(config())
    const appCreate = world.calls.find((c) => c.method === 'POST' && c.url.endsWith('/access/apps'))
    expect(appCreate?.body).toMatchObject({ session_duration: '0s', enable_binding_cookie: false })
  })
})
