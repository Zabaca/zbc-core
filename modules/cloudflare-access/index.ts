// Contributed from foundry, 2026-08-19 — the third group to arrive that way,
// after systemd-unit / host-file / docker-compose-stack on 2026-08-03 and the
// four host primitives on 2026-08-18.
//
// The comments below cite `ADR-NNNN` and sibling test files by bare name. Those
// are **foundry's**, not this repository's, and they are kept rather than
// stripped because each one is the record of a failure that shaped the code —
// a reference a reader can go and find beats a rationale nobody can check.

import { z } from 'zod'
import { defineModule } from '../../src/define-module'
import { cf, resolveApiToken } from '../cloudflare-api'

// cloudflare-access — a Zero Trust application, its policy, and the service
// token a machine caller presents, as repo state.
//
// What this exists for: `cloudflare-tunnel` puts a hostname on the internet,
// and a tunnel with no policy in front of it is an open door. Here that door
// leads to a vite dev server with no auth of its own and a bridge that can run
// agent turns with a real Claude token, so "add the route and secure it after"
// is not a sequence worth being able to run. The two land together.
//
// ── The service token secret is NOT rolled on every apply ─────────────────
// `cloudflare-token` rolls its value every apply and persists nothing, which is
// the better discipline — a minted value that lives only in memory cannot go
// stale in a file somewhere. That does NOT work here, and the difference is
// worth stating because the asymmetry looks like an oversight otherwise.
//
// A Cloudflare API token's consumer is this apply. An Access service token's
// consumer is somebody ELSE — cedarpad's edge Worker, deployed from a different
// repo on a different cadence. Rolling on every apply would invalidate the
// credential the running Worker holds, so every unrelated `bun run apply` on
// this box would take the canvas down until the Worker was redeployed. That is
// a worse failure than the one rolling protects against.
//
// So: created once, and thereafter REUSED, never rotated. Cloudflare returns a
// service token's secret exactly once, at creation — so on the apply that
// creates it, this module prints the pair and that is the only chance to
// capture it. `rotate: true` is the deliberate escape hatch for the day it
// leaks or the Worker loses it; it mints a new secret and prints it, and
// whoever sets it does so knowing the old one dies.
//
// ── Why `include` and not `require` ───────────────────────────────────────
// The policy lists the service token in `include`, which is an OR — any listed
// principal gets in. `require` is an AND across every entry, so a second
// principal added later (an email for a human) would have to satisfy the
// service-token rule too, which no browser can. `include` is what makes the
// policy extensible without a rewrite.

const configSchema = z.object({
  accountId: z.string(),
  /** Credential source: a `cloudflare-token` instance's `tokenValue`. Needs
   *  "Access: Apps and Policies Write" and "Access: Service Tokens Write". */
  apiToken: z.object({ from: z.string(), output: z.string() }),
  /** Human-facing application name in the Zero Trust dashboard. Converge identity. */
  name: z.string().min(1),
  /** The hostname this application protects, e.g. `ws.cedarpad.com`. */
  domain: z.string().min(1),
  /** Service token name — the machine caller (cedarpad's edge Worker). */
  serviceTokenName: z.string().min(1),
  /**
   * Mint a NEW secret for an existing service token. Off by default: the
   * consumer is a separately-deployed Worker, and rotating without redeploying
   * it takes the canvas down. See the header.
   */
  rotate: z.boolean().default(false),
  /**
   * How long a session lasts. `0s` means every request is evaluated — correct
   * for a machine caller, which presents its token on each request anyway and
   * should never be handed a cookie.
   */
  sessionDuration: z.string().default('0s'),
})

/** Cloudflare wants the apex-less form for `domain`; it derives the zone itself. */
export interface AccessApp {
  id: string
  name: string
  domain: string
}

export interface ServiceToken {
  id: string
  name: string
  client_id: string
  client_secret?: string
}

/** The policy body: one `include` naming the service token. Pure; exported for tests. */
export function policyBody(name: string, serviceTokenId: string, sessionDuration: string) {
  return {
    name,
    decision: 'non_identity' as const,
    // `non_identity` is required for a service-token policy: an identity
    // decision expects a human principal and rejects a token outright.
    include: [{ service_token: { token_id: serviceTokenId } }],
    session_duration: sessionDuration,
  }
}

/**
 * Surface a freshly-minted pair the moment it exists.
 *
 * Cloudflare returns a service token's secret exactly once, at creation. The
 * first version of this module printed it at the END of apply, after the app
 * and policy were converged — and the very first real apply 403'd on the app,
 * so the secret was minted, never shown, and unrecoverable except by rotating.
 * Anything that can fail between minting a write-once value and showing it is a
 * chance to lose it, so nothing goes between.
 */
function announce(clientId: string, clientSecret: string): void {
  console.log(`\n  ── capture these now; the secret is never shown again ──`)
  console.log(`  CF_ACCESS_CLIENT_ID=${clientId}`)
  console.log(`  CF_ACCESS_CLIENT_SECRET=${clientSecret}\n`)
}

export const cloudflareAccessModule = defineModule({
  name: 'cloudflare-access',
  configSchema,
  outputs: z.object({
    appId: z.string(),
    policyId: z.string(),
    serviceTokenId: z.string(),
    /** Safe to output — the id is not a secret. */
    clientId: z.string(),
    /** Only non-empty on the apply that CREATED or rotated the token. */
    clientSecret: z.string(),
    created: z.boolean(),
    changed: z.boolean(),
  }),
  async apply(config, ctx) {
    const token = resolveApiToken(config.apiToken, ctx.imports)
    const base = `/accounts/${config.accountId}`
    let changed = false

    // 1. The service token, first: the policy needs its id.
    const tokens = await cf<ServiceToken[]>(token, 'GET', `${base}/access/service_tokens`)
    let svc = tokens.find((t) => t.name === config.serviceTokenName)
    let created = false
    let clientSecret = ''
    if (!svc) {
      svc = await cf<ServiceToken>(token, 'POST', `${base}/access/service_tokens`, {
        name: config.serviceTokenName,
        duration: '8760h', // one year; Cloudflare's max, and expiry here is an outage
      })
      clientSecret = svc.client_secret ?? ''
      created = true
      changed = true
      console.log(`  Created service token "${config.serviceTokenName}" (${svc.id})`)
      announce(svc.client_id, clientSecret)
    } else if (config.rotate) {
      const rotated = await cf<ServiceToken>(
        token,
        'POST',
        `${base}/access/service_tokens/${svc.id}/rotate`,
      )
      clientSecret = rotated.client_secret ?? ''
      changed = true
      console.log(`  ROTATED service token "${config.serviceTokenName}" — the old secret is dead`)
      announce(svc.client_id, clientSecret)
    } else {
      console.log(`  Service token "${config.serviceTokenName}" (${svc.id}) exists, not rotated`)
    }

    // 2. The application, converged by name.
    const apps = await cf<AccessApp[]>(token, 'GET', `${base}/access/apps`)
    let app = apps.find((a) => a.name === config.name)
    const appBody = {
      name: config.name,
      domain: config.domain,
      type: 'self_hosted',
      session_duration: config.sessionDuration,
      // A machine caller presents its token on every request; handing it a
      // cookie would let a leaked cookie outlive the token.
      enable_binding_cookie: false,
      // The Worker reads no identity from this; leaving JWT injection off keeps
      // the request the Worker forwards byte-identical to what the pad expects.
      http_only_cookie_attribute: true,
    }
    if (!app) {
      app = await cf<AccessApp>(token, 'POST', `${base}/access/apps`, appBody)
      changed = true
      console.log(`  Created Access app "${config.name}" for ${config.domain} (${app.id})`)
    } else if (app.domain !== config.domain) {
      app = await cf<AccessApp>(token, 'PUT', `${base}/access/apps/${app.id}`, appBody)
      changed = true
      console.log(`  Updated Access app "${config.name}" -> ${config.domain}`)
    } else {
      console.log(`  Access app "${config.name}" (${app.id}) unchanged`)
    }

    // 3. The policy. Converged by name within the app.
    const policyName = `${config.serviceTokenName} service token`
    const policies = await cf<Array<{ id: string; name: string }>>(
      token,
      'GET',
      `${base}/access/apps/${app.id}/policies`,
    )
    const body = policyBody(policyName, svc.id, config.sessionDuration)
    const existingPolicy = policies.find((p) => p.name === policyName)
    let policyId: string
    if (!existingPolicy) {
      const made = await cf<{ id: string }>(
        token,
        'POST',
        `${base}/access/apps/${app.id}/policies`,
        body,
      )
      policyId = made.id
      changed = true
      console.log(`  Created policy "${policyName}"`)
    } else {
      policyId = existingPolicy.id
      await cf(token, 'PUT', `${base}/access/apps/${app.id}/policies/${policyId}`, body)
      console.log(`  Policy "${policyName}" converged`)
    }

    return {
      appId: app.id,
      policyId,
      serviceTokenId: svc.id,
      clientId: svc.client_id,
      clientSecret,
      created,
      changed,
    }
  },
})
