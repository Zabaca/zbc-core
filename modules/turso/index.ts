import { z } from 'zod'
import { createClient } from '@tursodatabase/api'
import { defineModule } from '../../src/define-module'

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

      await turso.databases.create(config.dbName, { group: config.group })
      console.log(`  Created database "${config.dbName}" in group "${config.group}"`)
    }

    // Generate an auth token
    const tokenResponse = await turso.databases.createToken(config.dbName, {
      authorization: 'full-access',
    })

    const hostname = existing?.hostname ?? `${config.dbName}-${config.orgName}.turso.io`
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
