import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * r2 — provisions a Cloudflare R2 bucket via the REST API (turso-style:
 * token from ctx.secrets, idempotent list→create, console.log progress).
 *
 * Exists so bucket lifecycle is owned by infra instead of being a side effect
 * of `wrangler deploy` prompting to create a missing bucket. A worker wires
 * the bucket in through the cloudflare module's `r2Bindings` config, typically
 * as a `{ binding, from, output }` reference into this instance's outputs.
 *
 * Token scope: CLOUDFLARE_API_TOKEN needs Account → Workers R2 Storage: Edit.
 */

const API = 'https://api.cloudflare.com/client/v4'

interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T
}

async function cfFetch<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  let envelope: CfEnvelope<T>
  try {
    envelope = (await res.json()) as CfEnvelope<T>
  } catch {
    throw new Error(`Cloudflare API ${path}: HTTP ${res.status} (non-JSON body)`)
  }
  if (!res.ok || !envelope.success) {
    const codes = (envelope.errors ?? []).map((e) => e.code)
    const detail = (envelope.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ')
    if (codes.includes(10000)) {
      throw new Error(
        `Cloudflare API ${path} rejected the token (10000 Authentication error). ` +
          `CLOUDFLARE_API_TOKEN is likely missing the Account → Workers R2 Storage: Edit scope. ` +
          `Edit the token at https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
      )
    }
    throw new Error(`Cloudflare API ${path} failed (HTTP ${res.status}): ${detail}`)
  }
  return envelope.result
}

export const r2Module = defineModule({
  name: 'r2',
  configSchema: z.object({
    /** Cloudflare account id (not a secret — it's in the dashboard URL). */
    accountId: z.string(),
    /** Bucket name — account-scoped, so namespace it per project/env. */
    bucketName: z.string(),
    /**
     * Location hint for new buckets (e.g. 'wnam', 'enam', 'weur'). Only
     * applied at creation; Cloudflare doesn't support relocating a bucket.
     */
    locationHint: z.string().optional(),
    /**
     * Destroy+recreate on every apply (preview environments). NOTE: deleting
     * a non-empty bucket fails — the management API has no object purge, so
     * ephemeral only works cleanly for buckets whose objects the app cleans
     * up, or that stay small enough to purge by hand.
     */
    ephemeral: z.boolean().default(false),
  }),
  outputs: z.object({
    bucketName: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')
    const base = `/accounts/${config.accountId}/r2/buckets`

    if (config.ephemeral) {
      try {
        await cfFetch(apiToken, `${base}/${encodeURIComponent(config.bucketName)}`, {
          method: 'DELETE',
        })
        console.log(`  Deleted ephemeral bucket "${config.bucketName}"`)
      } catch {
        // Didn't exist (or non-empty — creation below will then no-op via the
        // existence check, which for ephemeral means stale objects persist).
      }
    }

    const listing = await cfFetch<{ buckets: Array<{ name: string }> }>(
      apiToken,
      `${base}?per_page=1000`,
    )
    const exists = listing.buckets.some((b) => b.name === config.bucketName)

    if (exists) {
      console.log(`  Bucket "${config.bucketName}" already exists`)
    } else {
      await cfFetch(apiToken, base, {
        method: 'POST',
        body: {
          name: config.bucketName,
          ...(config.locationHint ? { locationHint: config.locationHint } : {}),
        },
      })
      console.log(
        `  Created bucket "${config.bucketName}"${config.locationHint ? ` (${config.locationHint})` : ''}`,
      )
    }

    return { bucketName: config.bucketName }
  },
  async destroy(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')
    try {
      await cfFetch(
        apiToken,
        `/accounts/${config.accountId}/r2/buckets/${encodeURIComponent(config.bucketName)}`,
        { method: 'DELETE' },
      )
      console.log(`  Deleted bucket "${config.bucketName}"`)
    } catch (err) {
      // Most common cause: bucket not empty (the API refuses). Surface it —
      // silent skips here would strand storage.
      console.log(`  Bucket delete skipped: ${(err as Error).message}`)
    }
  },
})
