import { afterEach, describe, expect, test } from 'bun:test'
import { cloudflareTokenModule, deriveS3Credentials } from './index'

/**
 * End-to-end tests for the cloudflare-token module.
 *
 * These exercise the REAL `apply`/`destroy` against a stubbed `globalThis.fetch`
 * that implements the Cloudflare account-owned-token endpoints from declarative
 * per-test state (permission groups, existing tokens, zones). Every HTTP call is
 * recorded, so tests assert on what actually reached the API: resolved
 * permission-group ids, resource scoping, roll-on-converge, and — for the
 * fail-fast contract — that a bad reference never mutates anything.
 */

interface RecordedCall {
  method: string
  url: string
  body?: Record<string, unknown>
  authorization?: string
}

interface StubState {
  permissionGroups?: Array<{ id: string; name: string; scopes: string[] }>
  existingTokens?: Array<{ id: string; name: string }>
  zones?: Record<string, string>
  createdValue?: string
  rolledValue?: string
  /** First-match override: return a CF envelope to short-circuit a route. */
  override?: (method: string, url: string) => unknown | undefined
}

const realFetch = globalThis.fetch

function installFetchStub(state: StubState): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const envelope = (result: unknown) => ({ success: true, errors: [], result })

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: RecordedCall = { method, url, authorization: headers['Authorization'] }
    if (init?.body) call.body = JSON.parse(init.body as string)
    calls.push(call)

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status })

    const overridden = state.override?.(method, url)
    if (overridden !== undefined) return respond(overridden)

    const u = new URL(url)
    const path = u.pathname

    if (method === 'GET' && path.endsWith('/tokens/permission_groups')) {
      return respond(envelope(state.permissionGroups ?? []))
    }
    if (method === 'GET' && path === '/client/v4/zones') {
      const name = u.searchParams.get('name') ?? ''
      const id = state.zones?.[name]
      return respond(envelope(id ? [{ id, name }] : []))
    }
    if (method === 'GET' && /\/accounts\/[^/]+\/tokens$/.test(path)) {
      return respond(envelope(state.existingTokens ?? []))
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/tokens$/.test(path)) {
      return respond(envelope({ id: 'tok-new', value: state.createdValue ?? 'created-value' }))
    }
    if (method === 'PUT' && /\/tokens\/[^/]+\/value$/.test(path)) {
      return respond(envelope(state.rolledValue ?? 'rolled-value'))
    }
    if (method === 'PUT' && /\/tokens\/[^/]+$/.test(path)) {
      return respond(envelope({ id: path.split('/').pop() }))
    }
    if (method === 'DELETE' && /\/tokens\/[^/]+$/.test(path)) {
      return respond(envelope({ id: path.split('/').pop() }))
    }
    return respond({ success: false, errors: [{ message: `no stub route: ${method} ${path}` }], result: null })
  }) as typeof fetch

  return { calls }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const GROUPS = [
  { id: 'pg-workers', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'pg-r2', name: 'Workers R2 Storage Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'pg-dns', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
]

async function runApply(opts: {
  config?: Record<string, unknown>
  secrets?: Record<string, string>
  state?: StubState
}): Promise<{ result?: Record<string, string>; error?: Error; calls: RecordedCall[] }> {
  const stub = installFetchStub({ permissionGroups: GROUPS, ...opts.state })
  const config = cloudflareTokenModule.configSchema.parse({
    accountId: 'acct-1',
    tokenName: 'zbc-test-token',
    permissions: ['Workers Scripts Write'],
    ...opts.config,
  })
  const ctx = {
    secrets: { CLOUDFLARE_ROOT_TOKEN: 'root-tok', ...opts.secrets },
    imports: {},
    projectRoot: '/tmp',
  }
  let result: Record<string, string> | undefined
  let error: Error | undefined
  try {
    result = (await cloudflareTokenModule.apply(config, ctx)) as Record<string, string>
  } catch (e) {
    error = e as Error
  }
  return { result, error, calls: stub.calls }
}

const byMethod = (calls: RecordedCall[], method: string, urlPart: string) =>
  calls.filter((c) => c.method === method && c.url.includes(urlPart))

describe('cloudflare-token apply — create path', () => {
  test('no existing token → POST with resolved permission-group ids + account resource', async () => {
    const { result, error, calls } = await runApply({
      state: { createdValue: 'v-created' },
    })
    expect(error).toBeUndefined()
    const posts = byMethod(calls, 'POST', '/accounts/acct-1/tokens')
    expect(posts).toHaveLength(1)
    const body = posts[0].body as {
      name: string
      policies: Array<{
        effect: string
        permission_groups: Array<{ id: string }>
        resources: Record<string, unknown>
      }>
    }
    expect(body.name).toBe('zbc-test-token')
    expect(body.policies).toHaveLength(1)
    expect(body.policies[0].effect).toBe('allow')
    expect(body.policies[0].permission_groups).toEqual([{ id: 'pg-workers' }])
    expect(body.policies[0].resources).toEqual({ 'com.cloudflare.api.account.acct-1': '*' })
    expect(result?.tokenId).toBe('tok-new')
    expect(result?.tokenValue).toBe('v-created')
    // No roll on the create path — the create response already returned the value.
    expect(byMethod(calls, 'PUT', '/value')).toHaveLength(0)
  })

  test('every API call carries the root token as a Bearer', async () => {
    const { calls } = await runApply({})
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.authorization).toBe('Bearer root-tok')
  })

  test('S3 credentials derived from token: access key = id, secret = sha256(value)', async () => {
    const { result } = await runApply({ state: { createdValue: 'v-created' } })
    const expected = deriveS3Credentials('tok-new', 'v-created')
    expect(result?.s3AccessKeyId).toBe('tok-new')
    expect(result?.s3SecretAccessKey).toBe(expected.s3SecretAccessKey)
    // sha256 is deterministic hex, 64 chars
    expect(result?.s3SecretAccessKey).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('cloudflare-token apply — converge path', () => {
  test('existing token → PUT policies then roll value; rolled value in outputs', async () => {
    const { result, error, calls } = await runApply({
      state: {
        existingTokens: [{ id: 'tok-1', name: 'zbc-test-token' }],
        rolledValue: 'v-rolled',
      },
    })
    expect(error).toBeUndefined()
    expect(byMethod(calls, 'POST', '/tokens')).toHaveLength(0)
    const updates = byMethod(calls, 'PUT', '/tokens/tok-1')
    // One policies update + one roll
    expect(updates.some((c) => c.url.endsWith('/tokens/tok-1'))).toBe(true)
    expect(updates.some((c) => c.url.endsWith('/tokens/tok-1/value'))).toBe(true)
    expect(result?.tokenId).toBe('tok-1')
    expect(result?.tokenValue).toBe('v-rolled')
  })

  test('a different token with another name does not converge — creates fresh', async () => {
    const { calls } = await runApply({
      state: { existingTokens: [{ id: 'tok-9', name: 'unrelated' }] },
    })
    expect(byMethod(calls, 'POST', '/tokens')).toHaveLength(1)
  })
})

describe('cloudflare-token apply — zone scoping', () => {
  test('zone-scoped permission + zones → zone ids resolved, zone resources on own policy', async () => {
    const { error, calls } = await runApply({
      config: { permissions: ['Workers Scripts Write', 'DNS Write'], zones: ['cedarpad.com'] },
      state: { zones: { 'cedarpad.com': 'zone-1' } },
    })
    expect(error).toBeUndefined()
    const zoneLookups = byMethod(calls, 'GET', '/zones?name=cedarpad.com')
    expect(zoneLookups).toHaveLength(1)
    const body = byMethod(calls, 'POST', '/tokens')[0].body as {
      policies: Array<{ permission_groups: Array<{ id: string }>; resources: Record<string, unknown> }>
    }
    expect(body.policies).toHaveLength(2)
    const accountPolicy = body.policies.find((p) => p.permission_groups[0].id === 'pg-workers')
    const zonePolicy = body.policies.find((p) => p.permission_groups[0].id === 'pg-dns')
    expect(accountPolicy?.resources).toEqual({ 'com.cloudflare.api.account.acct-1': '*' })
    expect(zonePolicy?.resources).toEqual({ 'com.cloudflare.api.account.zone.zone-1': '*' })
  })

  test('zone-scoped permission WITHOUT zones → all zones of the account (nested resource)', async () => {
    const { error, calls } = await runApply({
      config: { permissions: ['DNS Write'] },
    })
    expect(error).toBeUndefined()
    const body = byMethod(calls, 'POST', '/tokens')[0].body as {
      policies: Array<{ resources: Record<string, unknown> }>
    }
    expect(body.policies).toHaveLength(1)
    expect(body.policies[0].resources).toEqual({
      'com.cloudflare.api.account.acct-1': { 'com.cloudflare.api.account.zone.*': '*' },
    })
  })

  test('unknown zone name → hard error naming it, token never created', async () => {
    const { error, calls } = await runApply({
      config: { permissions: ['DNS Write'], zones: ['ghost.example'] },
      state: { zones: {} },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('ghost.example')
    expect(byMethod(calls, 'POST', '/tokens')).toHaveLength(0)
  })
})

describe('cloudflare-token apply — hard errors are fail-fast', () => {
  test('missing root secret → throws, zero HTTP calls', async () => {
    const stub = installFetchStub({ permissionGroups: GROUPS })
    const config = cloudflareTokenModule.configSchema.parse({
      accountId: 'acct-1',
      tokenName: 't',
      permissions: ['Workers Scripts Write'],
    })
    let error: Error | undefined
    try {
      await cloudflareTokenModule.apply(config, { secrets: {}, imports: {}, projectRoot: '/tmp' })
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toContain('CLOUDFLARE_ROOT_TOKEN')
    expect(stub.calls).toHaveLength(0)
  })

  test('unknown permission name → hard error naming it and the knowns, no mutation', async () => {
    const { error, calls } = await runApply({
      config: { permissions: ['Workers Scripts Write', 'Time Travel'] },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('Time Travel')
    expect(byMethod(calls, 'POST', '/tokens')).toHaveLength(0)
    expect(byMethod(calls, 'PUT', '/tokens')).toHaveLength(0)
  })

  test('CF error envelope → throws with the API message', async () => {
    const { error } = await runApply({
      state: {
        override: (method, url) =>
          method === 'POST' && url.includes('/tokens')
            ? { success: false, errors: [{ message: 'quota exceeded' }], result: null }
            : undefined,
      },
    })
    expect(error).toBeDefined()
    expect(error!.message).toContain('quota exceeded')
  })

  test('token value never appears in console output', async () => {
    const logged: string[] = []
    const realLog = console.log
    console.log = (...args: unknown[]) => logged.push(args.join(' '))
    try {
      await runApply({ state: { createdValue: 'super-secret-value' } })
    } finally {
      console.log = realLog
    }
    expect(logged.join('\n')).not.toContain('super-secret-value')
  })
})

describe('cloudflare-token destroy', () => {
  test('existing token → DELETE by looked-up id', async () => {
    const stub = installFetchStub({
      permissionGroups: GROUPS,
      existingTokens: [{ id: 'tok-1', name: 'zbc-test-token' }],
    })
    const config = cloudflareTokenModule.configSchema.parse({
      accountId: 'acct-1',
      tokenName: 'zbc-test-token',
      permissions: ['Workers Scripts Write'],
    })
    await cloudflareTokenModule.destroy!(config, {
      secrets: { CLOUDFLARE_ROOT_TOKEN: 'root-tok' },
      imports: {},
      projectRoot: '/tmp',
    })
    expect(byMethod(stub.calls, 'DELETE', '/tokens/tok-1')).toHaveLength(1)
  })

  test('absent token → no throw, no DELETE', async () => {
    const stub = installFetchStub({ permissionGroups: GROUPS, existingTokens: [] })
    const config = cloudflareTokenModule.configSchema.parse({
      accountId: 'acct-1',
      tokenName: 'zbc-test-token',
      permissions: ['Workers Scripts Write'],
    })
    await cloudflareTokenModule.destroy!(config, {
      secrets: { CLOUDFLARE_ROOT_TOKEN: 'root-tok' },
      imports: {},
      projectRoot: '/tmp',
    })
    expect(stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('deriveS3Credentials', () => {
  test('known vector: sha256 of the value, hex', async () => {
    const { s3AccessKeyId, s3SecretAccessKey } = deriveS3Credentials('id-1', 'abc')
    expect(s3AccessKeyId).toBe('id-1')
    // sha256("abc")
    expect(s3SecretAccessKey).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
