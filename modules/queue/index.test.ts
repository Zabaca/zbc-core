import { afterEach, describe, expect, test } from 'bun:test'
import { type ListedSubscription, planSubscription, queueModule, type Subscription } from './index'

/**
 * The queue module, driven through its REAL apply/destroy against a stubbed
 * `globalThis.fetch`, so what is asserted is what reached the API: a queue made
 * once and found by name after, a subscription created, left alone, or brought
 * to the wanted events, a conflict refused, and a destroy that removes only the
 * subscriptions it names and never the queue.
 */

const ACCOUNT = 'acct-1'
const B = `/client/v4/accounts/${ACCOUNT}`

interface RecordedCall {
  method: string
  path: string
  query: string
  body?: Record<string, unknown>
}

interface World {
  queues: Array<{ queue_id: string; queue_name: string }>
  subscriptions: ListedSubscription[]
  calls: RecordedCall[]
  /** Queues per listed page, to exercise pagination. Unset: one page, no result_info. */
  queuePageSize?: number
  /** First-match override: `[payload, status]` short-circuits a route. */
  override?: (method: string, path: string) => [unknown, number] | undefined
}

const world = (over: Partial<World> = {}): World => ({
  queues: [],
  subscriptions: [],
  calls: [],
  ...over,
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const ok = (result: unknown, info?: { page: number; total_pages: number }) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result,
      ...(info ? { result_info: info } : {}),
    }),
    { status: 200 },
  )

function installFetch(w: World): void {
  let n = 1
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined
    w.calls.push({ method, path: url.pathname, query: url.search, body })

    const overridden = w.override?.(method, url.pathname)
    if (overridden) return new Response(JSON.stringify(overridden[0]), { status: overridden[1] })

    if (url.pathname === `${B}/queues`) {
      if (method === 'GET') {
        if (w.queuePageSize === undefined) return ok(w.queues)
        const page = Number(url.searchParams.get('page') ?? '1')
        const size = w.queuePageSize
        const total = Math.max(1, Math.ceil(w.queues.length / size))
        return ok(w.queues.slice((page - 1) * size, page * size), { page, total_pages: total })
      }
      const q = { queue_id: `q-${n++}`, queue_name: String(body?.queue_name) }
      w.queues.push(q)
      return ok(q)
    }
    if (url.pathname === `${B}/event_subscriptions/subscriptions`) {
      if (method === 'GET') return ok(w.subscriptions)
      const s = { id: `sub-${n++}`, ...(body as object) } as ListedSubscription
      w.subscriptions.push(s)
      return ok(s)
    }
    const one = url.pathname.match(new RegExp(`^${B}/event_subscriptions/subscriptions/([^/]+)$`))
    if (one) {
      const i = w.subscriptions.findIndex((s) => s.id === one[1])
      if (method === 'DELETE') {
        w.subscriptions.splice(i, 1)
        return ok(null)
      }
      Object.assign(w.subscriptions[i]!, body)
      return ok(w.subscriptions[i])
    }
    throw new Error(`stub has no route for ${method} ${url.pathname}`)
  }) as typeof fetch
}

const CTX = { secrets: { CLOUDFLARE_API_TOKEN: 'tok' }, imports: {}, projectRoot: '/tmp' }

const SENDING: Subscription = {
  name: 'northfield-sending',
  zoneId: 'zone-northfield',
  domain: 'northfield.example',
  events: ['message.delivered', 'message.bounced'],
}

const config = (over: Record<string, unknown> = {}) =>
  queueModule.configSchema.parse({
    accountId: ACCOUNT,
    queueName: 'northfield-delivery',
    subscriptions: [SENDING],
    ...over,
  })

const posts = (w: World, suffix: string) =>
  w.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix))

describe('the queue', () => {
  test('a missing queue is created, by name', async () => {
    const w = world()
    installFetch(w)
    const out = await queueModule.apply(config({ subscriptions: [] }), CTX)

    expect(posts(w, '/queues')).toHaveLength(1)
    expect(posts(w, '/queues')[0]!.body).toEqual({ queue_name: 'northfield-delivery' })
    expect(out).toEqual({ queueName: 'northfield-delivery', queueId: 'q-1', subscriptionIds: {} })
  })

  test('an existing queue is found by name and not created again', async () => {
    const w = world({ queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }] })
    installFetch(w)
    const out = await queueModule.apply(config({ subscriptions: [] }), CTX)

    expect(posts(w, '/queues')).toHaveLength(0)
    expect(out.queueId).toBe('q-live')
  })

  test('a queue past the first page of the listing is still found', async () => {
    // A one-page listing that "worked" on a small account is a silent wrong
    // answer on a large one: the queue exists, the page does not show it, and
    // apply asks for a second one under a name that is already taken.
    const others = Array.from({ length: 5 }, (_, i) => ({
      queue_id: `q-o${i}`,
      queue_name: `other-${i}`,
    }))
    const w = world({
      queues: [...others, { queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      queuePageSize: 2,
    })
    installFetch(w)
    const out = await queueModule.apply(config({ subscriptions: [] }), CTX)

    expect(posts(w, '/queues')).toHaveLength(0)
    expect(out.queueId).toBe('q-live')
  })

  test('a rejected token names the scope this module needs, and nothing is created', async () => {
    const w = world({
      override: () => [
        {
          success: false,
          result: null,
          errors: [{ code: 10000, message: 'Authentication error' }],
        },
        403,
      ],
    })
    installFetch(w)

    const error = await queueModule.apply(config(), CTX).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toContain('Queues: Edit')
    expect(w.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  test('no CLOUDFLARE_API_TOKEN is refused before any call', async () => {
    const w = world()
    installFetch(w)
    const error = await queueModule.apply(config(), { ...CTX, secrets: {} }).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toContain('CLOUDFLARE_API_TOKEN')
    expect(w.calls).toHaveLength(0)
  })
})

describe('the subscriptions that fill it', () => {
  test('a missing subscription is created on the queue, from the sending domain', async () => {
    const w = world()
    installFetch(w)
    const out = await queueModule.apply(config(), CTX)

    const created = posts(w, '/event_subscriptions/subscriptions')
    expect(created).toHaveLength(1)
    expect(created[0]!.body).toEqual({
      name: 'northfield-sending',
      enabled: true,
      source: { type: 'email.sending', zone_id: 'zone-northfield', domain: 'northfield.example' },
      destination: { type: 'queues.queue', queue_id: 'q-1' },
      events: ['message.delivered', 'message.bounced'],
    })
    expect(out.subscriptionIds).toEqual({ 'northfield-sending': 'sub-2' })
  })

  test('the second apply changes nothing', async () => {
    const w = world()
    installFetch(w)
    await queueModule.apply(config(), CTX)
    const before = w.calls.length
    const out = await queueModule.apply(config(), CTX)

    expect(w.calls.slice(before).filter((c) => c.method !== 'GET')).toHaveLength(0)
    expect(out.subscriptionIds).toEqual({ 'northfield-sending': 'sub-2' })
  })

  test('a subscription whose events drifted is brought back to the wanted ones', async () => {
    const w = world({
      queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      subscriptions: [
        {
          id: 'sub-live',
          name: 'northfield-sending',
          enabled: true,
          source: {
            type: 'email.sending',
            zone_id: 'zone-northfield',
            domain: 'northfield.example',
          },
          destination: { type: 'queues.queue', queue_id: 'q-live' },
          events: ['message.delivered'],
        },
      ],
    })
    installFetch(w)
    await queueModule.apply(config(), CTX)

    const patches = w.calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.path).toBe(`${B}/event_subscriptions/subscriptions/sub-live`)
    expect(patches[0]!.body).toEqual({
      enabled: true,
      events: ['message.delivered', 'message.bounced'],
    })
    expect(posts(w, '/event_subscriptions/subscriptions')).toHaveLength(0)
  })

  test('a subscription of the same name on another source is refused, not overwritten', async () => {
    const w = world({
      queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      subscriptions: [
        {
          id: 'sub-other',
          name: 'northfield-sending',
          source: { type: 'email.sending', zone_id: 'zone-other', domain: 'other.example' },
          destination: { type: 'queues.queue', queue_id: 'q-live' },
          events: ['message.delivered'],
        },
      ],
    })
    installFetch(w)
    const error = await queueModule.apply(config(), CTX).then(
      () => undefined,
      (e: Error) => e,
    )

    expect(error?.message).toContain('northfield-sending')
    expect(error?.message).toContain('other.example')
    expect(w.calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')).toHaveLength(0)
  })
})

describe('destroy', () => {
  test('removes the subscriptions it names on its queue and leaves the queue', async () => {
    const w = world({
      queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      subscriptions: [
        {
          id: 'sub-mine',
          name: 'northfield-sending',
          destination: { type: 'queues.queue', queue_id: 'q-live' },
        },
        {
          id: 'sub-unnamed',
          name: 'someone-else',
          destination: { type: 'queues.queue', queue_id: 'q-live' },
        },
      ],
    })
    installFetch(w)
    await queueModule.destroy!(config(), CTX)

    const deletes = w.calls.filter((c) => c.method === 'DELETE')
    expect(deletes.map((c) => c.path)).toEqual([`${B}/event_subscriptions/subscriptions/sub-mine`])
    expect(w.queues).toHaveLength(1)
  })

  test('a subscription of the same name on another queue is not this instance’s to delete', async () => {
    const w = world({
      queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      subscriptions: [
        {
          id: 'sub-elsewhere',
          name: 'northfield-sending',
          destination: { type: 'queues.queue', queue_id: 'q-other' },
        },
      ],
    })
    installFetch(w)
    await queueModule.destroy!(config(), CTX)

    expect(w.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  test('an absent queue has nothing to tear down', async () => {
    const w = world()
    installFetch(w)
    expect(await queueModule.destroy!(config(), CTX)).toBeUndefined()
    expect(w.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  test('a failed delete is a failed destroy, not a reported success', async () => {
    const w = world({
      queues: [{ queue_id: 'q-live', queue_name: 'northfield-delivery' }],
      subscriptions: [
        { id: 'sub-mine', name: 'northfield-sending', destination: { queue_id: 'q-live' } },
      ],
      override: (method) =>
        method === 'DELETE'
          ? [{ success: false, result: null, errors: [{ code: 10013, message: 'internal' }] }, 500]
          : undefined,
    })
    installFetch(w)
    const error = await queueModule.destroy!(config(), CTX).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toContain('internal')
  })
})

const listed = (over: Partial<ListedSubscription> = {}): ListedSubscription => ({
  id: 'sub-1',
  name: 'northfield-sending',
  enabled: true,
  source: { type: 'email.sending', zone_id: 'zone-northfield', domain: 'northfield.example' },
  destination: { type: 'queues.queue', queue_id: 'q-1' },
  events: ['message.delivered', 'message.bounced'],
  ...over,
})

describe('planSubscription, the pure half', () => {
  test('nothing of that name on this queue is a create', () => {
    expect(planSubscription(SENDING, [], 'q-1')).toEqual({ action: 'create' })
    expect(
      planSubscription(SENDING, [listed({ destination: { queue_id: 'q-other' } })], 'q-1'),
    ).toEqual({ action: 'create' })
  })

  test('the same events in another order are a match', () => {
    expect(
      planSubscription(
        SENDING,
        [listed({ events: ['message.bounced', 'message.delivered'] })],
        'q-1',
      ),
    ).toEqual({ action: 'leave', id: 'sub-1' })
  })

  test('a disabled subscription is updated, so it is enabled again', () => {
    expect(planSubscription(SENDING, [listed({ enabled: false })], 'q-1').action).toBe(
      'update-events',
    )
  })

  test('the source is read in either spelling', () => {
    const camel = listed({
      source: { type: 'email.sending', zoneId: 'zone-northfield', domain: 'northfield.example' },
      destination: { queueId: 'q-1' },
    })
    expect(planSubscription(SENDING, [camel], 'q-1')).toEqual({ action: 'leave', id: 'sub-1' })
  })

  test('a source it cannot read is taken as this one, with a warning, never a conflict', () => {
    const plan = planSubscription(SENDING, [listed({ source: {} })], 'q-1')
    expect(plan.action).toBe('leave')
    expect('warn' in plan && plan.warn).toContain('shape this module does not know')
  })

  test('a source of another type is a conflict', () => {
    const plan = planSubscription(SENDING, [listed({ source: { type: 'workers.builds' } })], 'q-1')
    expect(plan.action).toBe('conflict')
  })
})
