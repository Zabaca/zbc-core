import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { type CfOptions, cf, cfRaw } from '../cloudflare-api'

/**
 * queue: a Cloudflare Queue and the Email Sending event subscriptions that fill
 * it, via the REST API (r2-style: token through ctx.secret, idempotent
 * list then create, console.log progress).
 *
 * What it is for: Cloudflare's Email Sending publishes an event for each
 * recipient of each message a domain sends (delivered, bounced, complained, …)
 * to a queue the account subscribes to, one subscription per sending domain. A
 * Worker that wants its delivery reports consumes that queue.
 *
 * The queue has to EXIST before the Worker that consumes it is deployed:
 * wrangler attaches a consumer by queue name (`queues.consumers` in the
 * Worker's wrangler config) and does not create the queue. So the Worker's
 * instance imports this one, which is what orders the apply.
 *
 * The calls are the ones wrangler's own `queues create` and `queues
 * subscription create` make: `POST /accounts/{id}/queues` with `queue_name`,
 * and `POST /accounts/{id}/event_subscriptions/subscriptions` with a name, a
 * source (`email.sending`, a zone id and a domain), a destination (the queue)
 * and the event names, written as wrangler's `--events` flag takes them
 * (`message.bounced`; the queue message itself carries the full
 * `cf.email.sending.message.bounced`). What the API answers when it LISTS a
 * subscription is typed only by wrangler's client, so `planSubscription` reads
 * the source and the destination in either spelling.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────
 * It deletes nothing it did not make: a queue that is not named here, or a
 * subscription that is not listed, is left alone. `destroy` removes the
 * subscriptions this instance names on its queue and LEAVES THE QUEUE, because
 * messages may be waiting in it. A subscription that already exists under the
 * same name is brought to the wanted events and nothing else, and one whose
 * source reads back as a different domain or zone is a hard error rather than
 * an overwrite.
 *
 * Token scope: CLOUDFLARE_API_TOKEN needs Account → Queues: Edit. Creating an
 * event subscription may ask for more on some accounts; the refusal names the
 * call that was refused.
 */

/** Named per-code guidance for this module's calls; see `../cloudflare-api`. */
const OPTS: CfOptions = {
  hints: {
    10000:
      `rejected the token (10000 Authentication error). ` +
      `CLOUDFLARE_API_TOKEN is likely missing the Account → Queues: Edit scope. ` +
      `Edit the token at https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
  },
}

export const subscriptionSchema = z.object({
  /** The subscription's name, unique on the queue: this is how an apply finds the one it made. */
  name: z.string(),
  /** The zone the sending domain is in. */
  zoneId: z.string(),
  /** The sending domain: the zone's apex, or a verified sending subdomain. */
  domain: z.string(),
  /** The events, as wrangler's `--events` takes them (`message.bounced`). */
  events: z.array(z.string()).min(1),
})
export type Subscription = z.infer<typeof subscriptionSchema>

/**
 * A subscription as Cloudflare lists it. Wrangler's client types the source and
 * the destination in snake_case (`zone_id`, `queue_id`); both spellings are read,
 * and a field that is in neither is simply unknown.
 */
export interface ListedSubscription {
  id: string
  name: string
  enabled?: boolean
  source?: { type?: string; zone_id?: string; zoneId?: string; domain?: string }
  destination?: { type?: string; queue_id?: string; queueId?: string }
  events?: string[]
}

export type SubscriptionPlan =
  | { action: 'create' }
  | { action: 'leave'; id: string; warn?: string }
  | { action: 'update-events'; id: string; warn?: string }
  | { action: 'conflict'; id: string; why: string }

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.toSorted().join() === b.toSorted().join()

/**
 * The listed subscription that is this one: same NAME, on THIS QUEUE. One whose
 * destination names another queue is somebody else's and is not looked at; one
 * whose destination reads back in neither spelling is taken to be on this queue,
 * since the listing was asked for this queue's subscriptions.
 */
function findMine(
  existing: readonly ListedSubscription[],
  name: string,
  queueId: string,
): ListedSubscription | undefined {
  return existing.find((s) => {
    const to = s.destination?.queue_id ?? s.destination?.queueId
    return s.name === name && (to === undefined || to === queueId)
  })
}

/**
 * What to do about one wanted subscription, given the ones listed. Pure, so the
 * outcomes are a table test.
 *
 * A source that reads back as a DIFFERENT domain or zone, or as another source
 * type, is a conflict and is never overwritten: someone changed it, or the name
 * was reused, and which is right is not this module's to decide. A source that
 * reads back in a shape this module cannot read (no domain, no zone) is not a
 * conflict: the next apply must not be blocked by a subscription the first one
 * made, over how Cloudflare spells it. It carries on as the same subscription
 * and says so (`warn`).
 */
export function planSubscription(
  wanted: Subscription,
  existing: readonly ListedSubscription[],
  queueId: string,
): SubscriptionPlan {
  const found = findMine(existing, wanted.name, queueId)
  if (!found) return { action: 'create' }
  const zone = found.source?.zone_id ?? found.source?.zoneId
  const domain = found.source?.domain
  const type = found.source?.type
  const readable = domain !== undefined && zone !== undefined
  if (
    (type !== undefined && type !== 'email.sending') ||
    (readable && (zone !== wanted.zoneId || domain !== wanted.domain))
  ) {
    return {
      action: 'conflict',
      id: found.id,
      why: `a subscription named "${wanted.name}" exists on another source (${type ?? '?'} ${domain ?? '?'}); not changed.`,
    }
  }
  const warn = readable
    ? undefined
    : `its source reads back in a shape this module does not know (${JSON.stringify(found.source ?? null)}), so it is taken to be the one made here.`
  const same = sameSet(found.events ?? [], wanted.events) && found.enabled !== false
  return same
    ? { action: 'leave', id: found.id, ...(warn && { warn }) }
    : { action: 'update-events', id: found.id, ...(warn && { warn }) }
}

interface QueueRow {
  queue_id: string
  queue_name: string
}

/**
 * Every row of a listing, page by page.
 *
 * Paginated rather than asked for in one oversized page, for the reason `d1`
 * gives: a single page that "worked" on a small account is a silent wrong
 * answer on a large one, and here that means a second queue created under a
 * name that is already taken. A listing that reports no `result_info` is one
 * page. Bounded, so a provider that never says "last page" fails rather than
 * hangs.
 */
async function listAll<T>(token: string, path: string): Promise<T[]> {
  const all: T[] = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= 100; page++) {
    const envelope = await cfRaw<T[]>(
      token,
      'GET',
      `${path}${sep}per_page=100&page=${page}`,
      undefined,
      OPTS,
    )
    all.push(...(envelope.result ?? []))
    const info = envelope.result_info
    if (!info || page >= (info.total_pages ?? 1)) return all
  }
  throw new Error(`Cloudflare listing ${path} did not terminate after 100 pages`)
}

async function findQueue(
  token: string,
  accountId: string,
  queueName: string,
): Promise<QueueRow | undefined> {
  const queues = await listAll<QueueRow>(token, `/accounts/${accountId}/queues`)
  return queues.find((q) => q.queue_name === queueName)
}

function listSubscriptions(
  token: string,
  accountId: string,
  queueId: string,
): Promise<ListedSubscription[]> {
  return listAll<ListedSubscription>(
    token,
    `/accounts/${accountId}/event_subscriptions/subscriptions?queue_id=${encodeURIComponent(queueId)}`,
  )
}

export const queueModule = defineModule({
  name: 'queue',
  configSchema: z.object({
    /** Cloudflare account id (not a secret: it is in the dashboard URL). */
    accountId: z.string(),
    /** Queue name: account-scoped, and what the consuming Worker's wrangler config names. */
    queueName: z.string(),
    /** Email Sending event subscriptions that fill the queue, one per sending domain. */
    subscriptions: z.array(subscriptionSchema).default([]),
  }),
  outputs: z.object({
    queueName: z.string(),
    queueId: z.string(),
    /** The id of each declared subscription, by its name. */
    subscriptionIds: z.record(z.string()),
  }),
  async apply(config, ctx) {
    const token = ctx.secret('CLOUDFLARE_API_TOKEN')
    const base = `/accounts/${config.accountId}`

    let queue = await findQueue(token, config.accountId, config.queueName)
    if (queue) {
      console.log(`  Queue "${config.queueName}" already exists`)
    } else {
      queue = await cf<QueueRow>(
        token,
        'POST',
        `${base}/queues`,
        { queue_name: config.queueName },
        OPTS,
      )
      console.log(`  Created queue "${config.queueName}"`)
    }

    const existing =
      config.subscriptions.length > 0
        ? await listSubscriptions(token, config.accountId, queue.queue_id)
        : []
    const subscriptionIds: Record<string, string> = {}
    for (const wanted of config.subscriptions) {
      const plan = planSubscription(wanted, existing, queue.queue_id)
      if (plan.action === 'conflict') throw new Error(`Subscription ${wanted.name}: ${plan.why}`)
      if ('warn' in plan && plan.warn) console.log(`  Subscription "${wanted.name}": ${plan.warn}`)
      if (plan.action === 'leave') {
        console.log(`  Subscription "${wanted.name}" already there`)
        subscriptionIds[wanted.name] = plan.id
      } else if (plan.action === 'update-events') {
        await cf(
          token,
          'PATCH',
          `${base}/event_subscriptions/subscriptions/${plan.id}`,
          { enabled: true, events: wanted.events },
          OPTS,
        )
        console.log(`  Subscription "${wanted.name}": events set to ${wanted.events.join(', ')}`)
        subscriptionIds[wanted.name] = plan.id
      } else {
        const made = await cf<{ id: string }>(
          token,
          'POST',
          `${base}/event_subscriptions/subscriptions`,
          {
            name: wanted.name,
            enabled: true,
            source: { type: 'email.sending', zone_id: wanted.zoneId, domain: wanted.domain },
            destination: { type: 'queues.queue', queue_id: queue.queue_id },
            events: wanted.events,
          },
          OPTS,
        )
        console.log(
          `  Subscribed "${wanted.name}" (${wanted.domain}) to ${wanted.events.join(', ')}`,
        )
        subscriptionIds[wanted.name] = made.id
      }
    }
    return { queueName: config.queueName, queueId: queue.queue_id, subscriptionIds }
  },
  /**
   * Remove the subscriptions this instance names, on its own queue, and leave
   * the queue: messages may be waiting in it, and a queue is cheap to keep.
   *
   * A failed delete THROWS. It is not the bucket case `r2` reports and moves
   * past (a non-empty bucket is the ordinary outcome there); a subscription
   * left standing keeps publishing into a queue somebody believes was torn
   * down, so a destroy that reported it as done would be the lie.
   */
  async destroy(config, ctx) {
    const token = ctx.secret('CLOUDFLARE_API_TOKEN')
    const queue = await findQueue(token, config.accountId, config.queueName)
    if (!queue) {
      console.log(`  Queue "${config.queueName}" is already gone`)
      return
    }
    const existing =
      config.subscriptions.length > 0
        ? await listSubscriptions(token, config.accountId, queue.queue_id)
        : []
    for (const wanted of config.subscriptions) {
      const found = findMine(existing, wanted.name, queue.queue_id)
      if (!found) continue
      await cf(
        token,
        'DELETE',
        `/accounts/${config.accountId}/event_subscriptions/subscriptions/${found.id}`,
        undefined,
        OPTS,
      )
      console.log(`  Deleted subscription "${wanted.name}"`)
    }
    console.log(`  Queue "${config.queueName}" left in place (it may hold messages)`)
  },
})
