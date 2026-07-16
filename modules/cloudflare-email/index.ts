import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * cloudflare-email — provisions Cloudflare Email Service (public beta) for a
 * domain: outbound sending (SPF/DKIM/DMARC/bounce-MX auto-provisioned) and/or
 * inbound routing (literal rules + catch-all → forward / worker / drop).
 *
 * Unlike the `cloudflare` module (which shells out to wrangler), this module
 * calls the Cloudflare REST API directly — wrangler has no surface for Email
 * Routing / Email Sending onboarding. Same turso-style shape: token from
 * ctx.secrets, idempotent list→create everywhere, console.log progress.
 *
 * Operational caveats (beta):
 * - Email Sending requires a Workers Paid plan (403/10105 = not entitled).
 * - The API token needs Email Routing Rules Edit + Zone Settings Edit (the
 *   routing enable/settings/DNS endpoints live under generic Zone Settings) +
 *   DNS Edit on the zone, and Email Sending Edit + Email Routing Addresses
 *   Edit on the account (10000 "Authentication error" = missing scope).
 * - `forward` targets must be verified destination addresses; verification is
 *   a manual email click. apply creates the address (which sends the email)
 *   and fails with instructions — click the link, re-run apply.
 * - Outbound cap 5 MiB per message; rate limits are unpublished. Pilot before
 *   pointing high-volume projects at it.
 * - Sending onboarding adds an SPF record; if the (sub)domain already has one,
 *   merge them manually — two SPF records break SPF evaluation entirely.
 */

const API = 'https://api.cloudflare.com/client/v4'

interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T
}

class CfError extends Error {
  constructor(
    public status: number,
    public codes: number[],
    message: string,
  ) {
    super(message)
  }
  has(code: number): boolean {
    return this.codes.includes(code)
  }
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
    throw new CfError(res.status, [], `Cloudflare API ${path}: HTTP ${res.status} (non-JSON body)`)
  }
  if (!res.ok || !envelope.success) {
    const codes = (envelope.errors ?? []).map((e) => e.code)
    const detail = (envelope.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ')
    if (codes.includes(10000)) {
      throw new CfError(
        res.status,
        codes,
        `Cloudflare API ${path} rejected the token (10000 Authentication error). ` +
          `CLOUDFLARE_API_TOKEN is likely missing a scope — it needs: ` +
          `Zone → Email Routing Rules: Edit, Zone → Zone Settings: Edit (the routing ` +
          `enable/settings/DNS endpoints live under generic Zone Settings), Zone → DNS: Edit, ` +
          `Account → Email Sending: Edit, Account → Email Routing Addresses: Edit. Edit the token at ` +
          `https://dash.cloudflare.com/profile/api-tokens and re-run zbc apply.`,
      )
    }
    if (codes.includes(10105)) {
      throw new CfError(
        res.status,
        codes,
        `Cloudflare API ${path}: account not entitled to Email Sending (10105). ` +
          `Email Sending requires a Workers Paid plan — upgrade the account, then re-run zbc apply.`,
      )
    }
    throw new CfError(
      res.status,
      codes,
      `Cloudflare API ${path} failed (HTTP ${res.status}): ${detail}`,
    )
  }
  return envelope.result
}

/** A routing rule action target. */
const addressSchema = z.object({
  /** Local part only — the domain comes from config.domain. */
  localPart: z.string(),
  action: z.enum(['forward', 'worker']),
  /** forward: a verified destination address (email). */
  destination: z.string().optional(),
  /** worker: the deployed Worker script name. */
  workerName: z.string().optional(),
})

const catchAllSchema = z.object({
  action: z.enum(['worker', 'forward', 'drop']),
  workerName: z.string().optional(),
  destination: z.string().optional(),
})

interface RoutingRule {
  id: string
  name?: string
  enabled: boolean
  matchers: Array<{ type: string; field?: string; value?: string }>
  actions: Array<{ type: string; value?: string[] }>
}

interface SendingSubdomain {
  tag: string
  name: string
  enabled: boolean
}

/** Managed-rule marker so destroy only removes rules this module created. */
const RULE_PREFIX = 'zbc:'

function ruleAction(entry: { action: string; destination?: string; workerName?: string }): {
  type: string
  value?: string[]
} {
  if (entry.action === 'forward') {
    if (!entry.destination) throw new Error(`action "forward" requires a destination`)
    return { type: 'forward', value: [entry.destination] }
  }
  if (entry.action === 'worker') {
    if (!entry.workerName) throw new Error(`action "worker" requires a workerName`)
    return { type: 'worker', value: [entry.workerName] }
  }
  return { type: 'drop' }
}

/**
 * Ensure a forward destination exists and is verified. Creating an address
 * triggers Cloudflare's verification email; verification itself is a manual
 * click we cannot automate — so fail with instructions and let the operator
 * re-run apply.
 */
async function ensureDestinationVerified(
  token: string,
  accountId: string,
  email: string,
): Promise<void> {
  const addresses = await cfFetch<Array<{ email: string; verified?: string | null }>>(
    token,
    `/accounts/${accountId}/email/routing/addresses?per_page=50`,
  )
  const existing = addresses.find((a) => a.email.toLowerCase() === email.toLowerCase())
  if (existing?.verified) return
  if (!existing) {
    await cfFetch(token, `/accounts/${accountId}/email/routing/addresses`, {
      method: 'POST',
      body: { email },
    })
    console.log(`  Created destination address ${email} — verification email sent`)
  }
  throw new Error(
    `Destination address ${email} is not verified yet. Cloudflare has emailed it a ` +
      `verification link — click it, then re-run zbc apply.`,
  )
}

export const cloudflareEmailModule = defineModule({
  name: 'cloudflare-email',
  configSchema: z.object({
    /** Cloudflare account id (dashboard URL — not a secret). */
    accountId: z.string(),
    /** Zone id of the apex zone (e.g. cedarpad.com's zone). */
    zoneId: z.string(),
    /** Email domain — the zone apex or a subdomain of it (e.g. mail.cedarpad.com). */
    domain: z.string(),
    /** Onboard the domain for outbound sending (SPF/DKIM/DMARC/bounce-MX). */
    enableSending: z.boolean().default(true),
    /** Enable inbound routing (MX records) + rules below. */
    enableRouting: z.boolean().default(false),
    /** Catch-all rule for the domain. Omit to leave catch-all untouched. */
    catchAll: catchAllSchema.optional(),
    /** Literal-address rules (localPart @ domain). */
    addresses: z.array(addressSchema).default([]),
  }),
  outputs: z.object({
    sendingEnabled: z.boolean(),
    routingEnabled: z.boolean(),
    /** DNS record name+type → status (e.g. "MX mail.cedarpad.com": "active"). */
    dnsStatus: z.record(z.string()),
    /** Full email addresses with literal rules. */
    addresses: z.array(z.string()),
    accountId: z.string(),
    domain: z.string(),
  }),
  async apply(config, ctx) {
    const token = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!token) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')

    const { accountId, zoneId, domain } = config
    const dnsStatus: Record<string, string> = {}
    let sendingEnabled = false
    let routingEnabled = false

    // ── 1. Outbound sending: onboard the (sub)domain, surface DNS status ────
    if (config.enableSending) {
      const subdomains = await cfFetch<SendingSubdomain[]>(
        token,
        `/zones/${zoneId}/email/sending/subdomains`,
      )
      let sub = subdomains.find((s) => s.name === domain)
      if (sub) {
        console.log(`  Sending: ${domain} already onboarded`)
      } else {
        sub = await cfFetch<SendingSubdomain>(token, `/zones/${zoneId}/email/sending/subdomains`, {
          method: 'POST',
          body: { name: domain },
        })
        console.log(`  Sending: onboarded ${domain} (SPF/DKIM/DMARC/bounce-MX auto-provisioned)`)
      }
      sendingEnabled = true

      // DNS record verification status. Field names are beta-era; read
      // defensively and record whatever type/name/status the API returns.
      try {
        const dns = await cfFetch<unknown>(
          token,
          `/zones/${zoneId}/email/sending/subdomains/${sub.tag}/dns`,
        )
        const records: Array<Record<string, unknown>> = Array.isArray(dns)
          ? (dns as Array<Record<string, unknown>>)
          : (((dns as Record<string, unknown>)?.['records'] as Array<Record<string, unknown>>) ??
            [])
        for (const r of records) {
          const key = `${String(r.type ?? 'record')} ${String(r.name ?? domain)}`
          const status = String(r.status ?? r.state ?? 'unknown')
          dnsStatus[key] = status
          if (status !== 'active' && status !== 'verified' && status !== 'locked') {
            console.log(`  ⚠ Sending DNS pending: ${key} → ${status}`)
          }
        }
      } catch (err) {
        console.log(`  ⚠ Could not read sending DNS status: ${(err as Error).message}`)
      }
    }

    // ── 2. Inbound routing: enable, subdomain DNS, rules, catch-all ─────────
    if (config.enableRouting) {
      const settings = await cfFetch<{ enabled?: boolean; status?: string }>(
        token,
        `/zones/${zoneId}/email/routing`,
      )
      if (settings.enabled || settings.status === 'ready') {
        console.log(`  Routing: already enabled on zone`)
      } else {
        await cfFetch(token, `/zones/${zoneId}/email/routing/enable`, { method: 'POST' })
        console.log(`  Routing: enabled on zone (MX/SPF records locked in)`)
      }
      routingEnabled = true

      // Subdomain routing: provision routing DNS for the subdomain itself
      // (POST /email/routing/dns with the subdomain name). Idempotent: check
      // first via the subdomain query param.
      const zone = await cfFetch<{ name: string }>(token, `/zones/${zoneId}`)
      if (domain !== zone.name) {
        try {
          const dns = await cfFetch<Array<Record<string, unknown>>>(
            token,
            `/zones/${zoneId}/email/routing/dns?subdomain=${encodeURIComponent(domain)}`,
          )
          const hasMx = Array.isArray(dns) && dns.some((r) => r.type === 'MX')
          if (!hasMx) {
            await cfFetch(token, `/zones/${zoneId}/email/routing/dns`, {
              method: 'POST',
              body: { name: domain },
            })
            console.log(`  Routing: provisioned DNS for subdomain ${domain}`)
          } else {
            console.log(`  Routing: subdomain ${domain} DNS already provisioned`)
          }
        } catch (err) {
          // Some API versions only expose subdomain enrollment via POST; try it.
          if (err instanceof CfError && err.status === 404) {
            await cfFetch(token, `/zones/${zoneId}/email/routing/dns`, {
              method: 'POST',
              body: { name: domain },
            })
            console.log(`  Routing: provisioned DNS for subdomain ${domain}`)
          } else {
            throw err
          }
        }
      }

      // Routing DNS status for the domain
      try {
        const routingDns = await cfFetch<Array<Record<string, unknown>>>(
          token,
          `/zones/${zoneId}/email/routing/dns${domain !== zone.name ? `?subdomain=${encodeURIComponent(domain)}` : ''}`,
        )
        for (const r of routingDns ?? []) {
          dnsStatus[`${String(r.type ?? 'record')} ${String(r.name ?? domain)}`] = String(
            r.status ?? 'unknown',
          )
        }
      } catch {
        // status endpoint variance — non-fatal
      }

      // Pre-verify every forward destination before touching rules.
      const forwardTargets = new Set<string>()
      for (const a of config.addresses) {
        if (a.action === 'forward' && a.destination) forwardTargets.add(a.destination)
      }
      if (config.catchAll?.action === 'forward' && config.catchAll.destination) {
        forwardTargets.add(config.catchAll.destination)
      }
      for (const dest of forwardTargets) {
        await ensureDestinationVerified(token, accountId, dest)
      }

      // Upsert literal rules for each address.
      const existingRules = await cfFetch<RoutingRule[]>(
        token,
        `/zones/${zoneId}/email/routing/rules?per_page=50`,
      )
      for (const entry of config.addresses) {
        const email = `${entry.localPart}@${domain}`
        const ruleName = `${RULE_PREFIX}${email}`
        const body = {
          name: ruleName,
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: email }],
          actions: [ruleAction(entry)],
        }
        const existing = existingRules.find(
          (r) =>
            r.name === ruleName ||
            r.matchers.some((m) => m.type === 'literal' && m.value === email),
        )
        if (existing) {
          await cfFetch(token, `/zones/${zoneId}/email/routing/rules/${existing.id}`, {
            method: 'PUT',
            body,
          })
          console.log(`  Routing: updated rule for ${email} → ${entry.action}`)
        } else {
          await cfFetch(token, `/zones/${zoneId}/email/routing/rules`, { method: 'POST', body })
          console.log(`  Routing: created rule for ${email} → ${entry.action}`)
        }
      }

      // Catch-all.
      if (config.catchAll) {
        await cfFetch(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
          method: 'PUT',
          body: {
            name: `${RULE_PREFIX}catch-all`,
            enabled: true,
            matchers: [{ type: 'all' }],
            actions: [ruleAction(config.catchAll)],
          },
        })
        console.log(`  Routing: catch-all → ${config.catchAll.action}`)
      }
    }

    const pending = Object.entries(dnsStatus).filter(
      ([, s]) => s !== 'active' && s !== 'verified' && s !== 'locked',
    )
    if (pending.length > 0) {
      console.log(
        `  ⚠ ${pending.length} DNS record(s) not yet verified — mail may not flow until they are:`,
      )
      for (const [k, s] of pending) console.log(`      ${k}: ${s}`)
    }

    return {
      sendingEnabled,
      routingEnabled,
      dnsStatus,
      addresses: config.addresses.map((a) => `${a.localPart}@${domain}`),
      accountId,
      domain,
    }
  },
  async destroy(config, ctx) {
    const token = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!token) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')
    const { zoneId, domain } = config

    console.log(`  ⚠ DESTROYING email config for ${domain} — mail for this domain WILL STOP.`)

    // Remove managed rules (only ones this module named).
    try {
      const rules = await cfFetch<RoutingRule[]>(
        token,
        `/zones/${zoneId}/email/routing/rules?per_page=50`,
      )
      for (const r of rules) {
        if (r.name?.startsWith(RULE_PREFIX)) {
          await cfFetch(token, `/zones/${zoneId}/email/routing/rules/${r.id}`, {
            method: 'DELETE',
          })
          console.log(`  Deleted rule ${r.name}`)
        }
      }
    } catch (err) {
      console.log(`  Rule cleanup skipped: ${(err as Error).message}`)
    }

    // Reset catch-all to drop (catch_all can't be deleted, only redefined).
    if (config.catchAll) {
      try {
        await cfFetch(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
          method: 'PUT',
          body: {
            name: `${RULE_PREFIX}catch-all`,
            enabled: false,
            matchers: [{ type: 'all' }],
            actions: [{ type: 'drop' }],
          },
        })
        console.log(`  Catch-all disabled`)
      } catch (err) {
        console.log(`  Catch-all reset skipped: ${(err as Error).message}`)
      }
    }

    if (config.enableRouting) {
      try {
        await cfFetch(token, `/zones/${zoneId}/email/routing/disable`, { method: 'POST' })
        console.log(`  Routing disabled on zone`)
      } catch (err) {
        console.log(`  Routing disable skipped: ${(err as Error).message}`)
      }
    }

    if (config.enableSending) {
      try {
        const subdomains = await cfFetch<SendingSubdomain[]>(
          token,
          `/zones/${zoneId}/email/sending/subdomains`,
        )
        const sub = subdomains.find((s) => s.name === domain)
        if (sub) {
          await cfFetch(token, `/zones/${zoneId}/email/sending/subdomains/${sub.tag}`, {
            method: 'DELETE',
          })
          console.log(`  Sending subdomain ${domain} deleted`)
        }
      } catch (err) {
        console.log(`  Sending teardown skipped: ${(err as Error).message}`)
      }
    }
  },
})
