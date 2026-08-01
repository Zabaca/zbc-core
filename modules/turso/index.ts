import { z } from 'zod'
import { createClient } from '@tursodatabase/api'
import { defineModule } from '../../src/define-module'

/**
 * Retry `probe` until it stops throwing.
 *
 * DEFENSIVE, not a fix for anything observed. A freshly created database can
 * exist in the control plane before its HTTP endpoint answers, which would
 * surface as a 404 on the first connection and read like a migration failure.
 * That is a real property of the service, but it is NOT what broke preview
 * deploys on 2026-08-01: that was the guessed hostname below, and this wait
 * has never been seen to retry even once. Delete it if it stays that way;
 * do not cite it as the cause of a past incident.
 *
 * Probes reachability rather than retrying migrate() itself, so a genuine
 * migration error still fails on the first try instead of being attempted
 * `attempts` times and reported as a timeout.
 */
export async function waitUntilReachable(
  probe: () => Promise<unknown>,
  {
    attempts = 10,
    delayMs = 2000,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await probe()
      return
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(`still unreachable after ${attempt} attempts: ${err}`, { cause: err })
      }
      if (attempt === 1) console.log('  Waiting for the database endpoint to come up...')
      await sleep(delayMs)
    }
  }
}

export const tursoModule = defineModule({
  name: 'turso',
  configSchema: z.object({
    orgName: z.string(),
    dbName: z.string(),
    group: z.string().default('default'),
    primaryLocation: z.string().default('iad'),
    ephemeral: z.boolean().default(false),
    /**
     * Path to a Drizzle migrations folder, relative to the monorepo root
     * (resolved via ctx.projectRoot). When provided, apply() runs migrations
     * after database creation. Idempotent.
     */
    migrationsDir: z.string().optional(),
  }),
  outputs: z.object({
    databaseUrl: z.string(),
    authToken: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secrets['TURSO_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: TURSO_API_TOKEN')

    const turso = createClient({ org: config.orgName, token: apiToken })

    // For ephemeral databases, destroy first to get a clean state
    if (config.ephemeral) {
      try {
        await turso.databases.delete(config.dbName)
        console.log(`  Deleted ephemeral database "${config.dbName}"`)
      } catch {
        // Database didn't exist — that's fine
      }
    }

    // Check if database already exists
    const databases = await turso.databases.list()
    const existing = databases.find((db) => db.name === config.dbName)
    let hostname = existing?.hostname

    if (existing) {
      console.log(`  Database "${config.dbName}" already exists`)

      if (existing.group && existing.group !== config.group) {
        console.warn(`  ⚠ Drift: group is "${existing.group}" but config says "${config.group}"`)
      }
      if (existing.primaryRegion && existing.primaryRegion !== config.primaryLocation) {
        console.warn(
          `  ⚠ Drift: location is "${existing.primaryRegion}" but config says "${config.primaryLocation}"`,
        )
      }
    } else {
      // Ensure group exists
      try {
        const groups = await turso.groups.list()
        const groupExists = groups.some((g) => g.name === config.group)
        if (!groupExists) {
          await turso.groups.create(config.group, config.primaryLocation)
          console.log(`  Created group "${config.group}" at ${config.primaryLocation}`)
        }
      } catch {
        // Group may already exist — continue
      }

      const created = await turso.databases.create(config.dbName, { group: config.group })
      // Use the hostname the API RETURNS, never a template. This was guessed
      // as `<db>-<org>.turso.io` and real hostnames carry a region segment:
      //   foothillmetabolic-pr-7-zabaca.aws-us-west-2.turso.io
      // so every newly created database got an unreachable URL and 404'd on
      // its first connection. It hid for months because the `existing` branch
      // reads the real hostname, so a long-lived database is always right and
      // only a first-ever apply (every per-PR preview) took the broken path.
      hostname = created.hostname
      console.log(`  Created database "${config.dbName}" in group "${config.group}"`)
    }
    if (!hostname) throw new Error(`Turso returned no hostname for "${config.dbName}"`)

    // Generate an auth token
    const tokenResponse = await turso.databases.createToken(config.dbName, {
      authorization: 'full-access',
    })

    const databaseUrl = `libsql://${hostname}`

    if (config.migrationsDir) {
      const { resolve } = await import('node:path')
      const { createClient: createLibsqlClient } = await import('@libsql/client')
      const { drizzle } = await import('drizzle-orm/libsql')
      const { migrate } = await import('drizzle-orm/libsql/migrator')

      const folder = resolve(ctx.projectRoot, config.migrationsDir)
      const migrationClient = createLibsqlClient({
        url: databaseUrl,
        authToken: tokenResponse.jwt,
      })
      const migrationDb = drizzle(migrationClient)

      await waitUntilReachable(() => migrationClient.execute('select 1'))

      console.log(`  Applying migrations from ${folder}`)
      await migrate(migrationDb, { migrationsFolder: folder })
      console.log(`  ✓ Migrations applied`)

      migrationClient.close()
    }

    return {
      databaseUrl,
      authToken: tokenResponse.jwt,
    }
  },
  async destroy(config, ctx) {
    const apiToken = ctx.secrets['TURSO_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: TURSO_API_TOKEN')

    const turso = createClient({ org: config.orgName, token: apiToken })

    try {
      await turso.databases.delete(config.dbName)
      console.log(`  Deleted database "${config.dbName}"`)
    } catch {
      console.log(`  Database "${config.dbName}" not found — skipping`)
    }
  },
})
