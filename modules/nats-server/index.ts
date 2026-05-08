import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

const FLY_API = 'https://api.machines.dev'
const FLY_GRAPHQL = 'https://api.fly.io/graphql'
const NATS_USER = 'app'
const MACHINE_TAG = { 'managed-by': 'zbc', instance: 'nats' } as const

interface FlyApp {
  id: string
  name: string
  organization: { slug: string }
}

interface FlyMachine {
  id: string
  name: string
  state: string
  config?: {
    metadata?: Record<string, string>
  }
}

async function flyFetch<T = unknown>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T | null> {
  const res = await fetch(`${FLY_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Fly API ${path} failed (${res.status}): ${body}`)
  }
  if (res.status === 204) return null
  return (await res.json()) as T
}

async function flyGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(FLY_GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors?.length) {
    throw new Error(`Fly GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  if (!body.data) throw new Error('Fly GraphQL: empty response')
  return body.data
}

/**
 * Fly's Machines REST API does not auto-allocate public IPs. Without this,
 * <app>.fly.dev never resolves. IP allocation isn't on the Machines API yet
 * — we go through GraphQL. shared_v4 is org-wide and not listed per-app,
 * so we always (re-)issue the mutation; it's idempotent. v6 is per-app, so
 * we only allocate if not present.
 */
async function ensureIPs(appName: string, token: string): Promise<void> {
  const list = await flyGraphQL<{ app: { ipAddresses: { nodes: Array<{ type: string }> } } }>(
    token,
    `query($name: String!) { app(name: $name) { ipAddresses { nodes { type } } } }`,
    { name: appName },
  )
  const hasV6 = list.app.ipAddresses.nodes.some((n) => n.type === 'v6')

  await flyGraphQL(
    token,
    `mutation($appId: ID!) { allocateIpAddress(input: {appId: $appId, type: shared_v4}) { ipAddress { address } } }`,
    { appId: appName },
  )
  if (!hasV6) {
    await flyGraphQL(
      token,
      `mutation($appId: ID!) { allocateIpAddress(input: {appId: $appId, type: v6}) { ipAddress { address } } }`,
      { appId: appName },
    )
    console.log(`  Allocated IPv6 for "${appName}"`)
  }
}

function renderConf(): string {
  return `# Managed by zbc — do not edit by hand.

http_port: 8222

websocket {
  port: 8080
  no_tls: true
}

authorization {
  user: ${NATS_USER}
  password: $NATS_PASSWORD
}

max_payload: 1MB
write_deadline: "10s"
`
}

function isManaged(machine: FlyMachine): boolean {
  const md = machine.config?.metadata ?? {}
  return md['managed-by'] === MACHINE_TAG['managed-by'] && md.instance === MACHINE_TAG.instance
}

export const natsServerModule = defineModule({
  name: 'nats-server',
  configSchema: z.object({
    appName: z.string(),
    flyOrg: z.string().default('personal'),
    region: z.string().default('iad'),
    memoryMB: z.number().default(256),
    cpuKind: z.enum(['shared', 'performance']).default('shared'),
    cpus: z.number().default(1),
  }),
  outputs: z.object({
    url: z.string(),
    user: z.string(),
    password: z.string(),
  }),
  async apply(config, ctx) {
    const flyToken = ctx.secrets['FLY_API_TOKEN']
    if (!flyToken) throw new Error('Missing secret: FLY_API_TOKEN')

    const password = ctx.secrets['NATS_PASSWORD']
    if (!password) {
      const generated = randomBytes(32).toString('hex')
      throw new Error(
        `Missing secret: NATS_PASSWORD\n` +
          `  Generated one for you — add to your environment's secrets.yaml and re-run:\n\n` +
          `    NATS_PASSWORD: ${generated}\n`,
      )
    }

    let app = await flyFetch<FlyApp>(`/v1/apps/${config.appName}`, flyToken)
    if (app) {
      console.log(`  Fly app "${config.appName}" already exists`)
    } else {
      app = await flyFetch<FlyApp>('/v1/apps', flyToken, {
        method: 'POST',
        body: JSON.stringify({ app_name: config.appName, org_slug: config.flyOrg }),
      })
      console.log(`  Created Fly app "${config.appName}" in org "${config.flyOrg}"`)
    }

    await ensureIPs(config.appName, flyToken)

    const machineConfig = {
      image: 'nats:latest',
      env: { NATS_PASSWORD: password },
      files: [
        {
          guest_path: '/etc/nats/nats-server.conf',
          raw_value: Buffer.from(renderConf(), 'utf8').toString('base64'),
        },
      ],
      init: { cmd: ['-c', '/etc/nats/nats-server.conf'] },
      services: [
        {
          protocol: 'tcp',
          internal_port: 8080,
          ports: [{ port: 443, handlers: ['tls', 'http'] }],
        },
      ],
      checks: {
        healthz: {
          type: 'http',
          port: 8222,
          path: '/healthz',
          interval: '15s',
          timeout: '5s',
          grace_period: '10s',
        },
      },
      metadata: { ...MACHINE_TAG },
      guest: {
        cpu_kind: config.cpuKind,
        cpus: config.cpus,
        memory_mb: config.memoryMB,
      },
    }

    const machines =
      (await flyFetch<FlyMachine[]>(`/v1/apps/${config.appName}/machines`, flyToken)) ?? []
    const managed = machines.filter(isManaged)

    let machineId: string
    if (managed.length === 0) {
      const created = await flyFetch<FlyMachine>(`/v1/apps/${config.appName}/machines`, flyToken, {
        method: 'POST',
        body: JSON.stringify({
          name: 'nats',
          region: config.region,
          config: machineConfig,
        }),
      })
      if (!created) throw new Error('Fly machine create returned no body')
      machineId = created.id
      console.log(`  Created machine "${created.id}" in ${config.region}`)
    } else {
      machineId = managed[0].id
      await flyFetch<FlyMachine>(`/v1/apps/${config.appName}/machines/${machineId}`, flyToken, {
        method: 'POST',
        body: JSON.stringify({ config: machineConfig, region: config.region }),
      })
      console.log(`  Updated machine "${machineId}"`)
      if (managed.length > 1) {
        console.warn(
          `  ⚠ Found ${managed.length} machines tagged managed-by=zbc; updated first, ignored the rest`,
        )
      }
    }

    // Fly's update cycle (stop → swap config → start) auto-starts the
    // machine, but the full cycle can take 60–90s. Don't call /start
    // ourselves — it races the auto-start and 412s with "getting replaced".
    // /wait caps at 60s server-side; poll up to ~4 minutes.
    const waitURL = `/v1/apps/${config.appName}/machines/${machineId}/wait?state=started&timeout=60`
    let started = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await flyFetch(waitURL, flyToken)
        started = true
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('(408)')) throw err
      }
    }
    if (!started) throw new Error(`Machine "${machineId}" did not reach started state in 4m`)
    console.log(`  Machine "${machineId}" started`)

    return {
      url: `wss://${config.appName}.fly.dev`,
      user: NATS_USER,
      password,
    }
  },
  async destroy(config, ctx) {
    const flyToken = ctx.secrets['FLY_API_TOKEN']
    if (!flyToken) throw new Error('Missing secret: FLY_API_TOKEN')

    const result = await flyFetch(`/v1/apps/${config.appName}?force=true`, flyToken, {
      method: 'DELETE',
    })
    if (result === null) {
      console.log(`  Fly app "${config.appName}" deleted (or did not exist)`)
    } else {
      console.log(`  Fly app "${config.appName}" deleted`)
    }
  },
})
