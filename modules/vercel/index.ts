import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

const VERCEL_API = 'https://api.vercel.com'

interface VercelProject {
  id: string
  name: string
  framework?: string | null
  accountId: string
}

interface VercelEnvVar {
  id: string
  key: string
  value: string
  target: string[]
}

function withTeam(p: string, teamId?: string) {
  if (!teamId) return p
  const sep = p.includes('?') ? '&' : '?'
  return `${p}${sep}teamId=${teamId}`
}

async function vercelFetch(p: string, token: string, teamId?: string, options?: RequestInit) {
  const res = await fetch(`${VERCEL_API}${withTeam(p, teamId)}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Vercel API ${p} failed (${res.status}): ${body}`)
  }

  if (res.status === 204) return null
  return res.json()
}

async function findProject(
  token: string,
  projectName: string,
  teamId?: string,
): Promise<VercelProject | null> {
  try {
    return await vercelFetch(`/v9/projects/${projectName}`, token, teamId)
  } catch {
    return null
  }
}

interface CreateProjectInput {
  framework?: string | null
  rootDirectory?: string
  installCommand?: string
  buildCommand?: string
  outputDirectory?: string
}

async function createProject(
  token: string,
  projectName: string,
  teamId: string | undefined,
  input: CreateProjectInput,
): Promise<VercelProject> {
  const body: Record<string, unknown> = { name: projectName }
  if (input.framework !== undefined) body.framework = input.framework
  if (input.rootDirectory !== undefined) body.rootDirectory = input.rootDirectory
  if (input.installCommand !== undefined) body.installCommand = input.installCommand
  if (input.buildCommand !== undefined) body.buildCommand = input.buildCommand
  if (input.outputDirectory !== undefined) body.outputDirectory = input.outputDirectory

  return vercelFetch('/v10/projects', token, teamId, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * PATCH project settings on every apply so config-as-code stays
 * authoritative. createProject only sets these on first creation; without
 * this call, edits to rootDirectory/installCommand/etc. are silently
 * ignored on existing projects.
 */
async function syncProjectSettings(
  token: string,
  projectId: string,
  teamId: string | undefined,
  input: CreateProjectInput,
) {
  const body: Record<string, unknown> = {}
  // Only set fields the caller explicitly provided. Vercel treats `null`
  // as "use default", which we want for framework when caller didn't pass.
  if (input.framework !== undefined) body.framework = input.framework
  if (input.rootDirectory !== undefined) body.rootDirectory = input.rootDirectory
  if (input.installCommand !== undefined) body.installCommand = input.installCommand
  if (input.buildCommand !== undefined) body.buildCommand = input.buildCommand
  if (input.outputDirectory !== undefined) body.outputDirectory = input.outputDirectory

  if (Object.keys(body).length === 0) return

  await vercelFetch(`/v9/projects/${projectId}`, token, teamId, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

async function syncEnvVars(
  token: string,
  projectId: string,
  teamId: string | undefined,
  desired: Record<string, string>,
  target: string[],
) {
  const data = (await vercelFetch(`/v9/projects/${projectId}/env`, token, teamId)) as {
    envs: VercelEnvVar[]
  }
  const existing = data.envs ?? []

  for (const [key, value] of Object.entries(desired)) {
    const found = existing.find((e) => e.key === key)
    if (found) {
      await vercelFetch(`/v9/projects/${projectId}/env/${found.id}`, token, teamId, {
        method: 'PATCH',
        body: JSON.stringify({ value, target }),
      })
    } else {
      await vercelFetch(`/v9/projects/${projectId}/env`, token, teamId, {
        method: 'POST',
        body: JSON.stringify({ key, value, target, type: 'encrypted' }),
      })
    }
  }
}

async function syncDomain(
  token: string,
  projectId: string,
  teamId: string | undefined,
  domain: string,
) {
  try {
    await vercelFetch(`/v10/projects/${projectId}/domains`, token, teamId, {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    })
  } catch {
    // Domain may already be configured — fine.
  }
}

function findVercelBin(projectRoot: string): string {
  const candidates = [
    path.join(projectRoot, 'packages/cli/node_modules/.bin/vercel'),
    path.join(projectRoot, 'node_modules/.bin/vercel'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('vercel CLI not found. Install it: bun add -d vercel in packages/cli')
}

function deployToVercel(
  token: string,
  uploadDir: string,
  teamId: string | undefined,
  production: boolean,
  projectRoot: string,
) {
  const vercelBin = findVercelBin(projectRoot)
  const args = [vercelBin, 'deploy', uploadDir, '--token', token, '--yes']
  if (teamId) args.push('--scope', teamId)
  if (production) args.push('--prod')

  console.log(
    `  Deploying ${path.relative(projectRoot, uploadDir) || '.'}${production ? ' (production)' : ''}...`,
  )

  try {
    const output = execSync(args.join(' '), { stdio: ['ignore', 'pipe', 'pipe'] })
    const raw = output.toString().trim()
    const urlMatch = raw.match(/https:\/\/[^\s"',}]+/)
    const deployUrl = urlMatch?.[0] ?? ''
    console.log(`  Deployed: ${deployUrl}`)
    return deployUrl
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    throw new Error(`Vercel deploy failed: ${stderr}`)
  }
}

const buildModeSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  outputDir: z.string(),
})

export const vercelModule = defineModule({
  name: 'vercel',
  configSchema: z
    .object({
      projectName: z.string(),
      teamId: z.string().optional(),
      domain: z.string().optional(),
      framework: z.string().nullable().optional(),

      // Mode A — module builds locally, uploads outputDir as static.
      build: buildModeSchema.optional(),

      // Mode B — Vercel builds from the uploaded sourceDir.
      sourceDir: z.string().optional(),
      rootDirectory: z.string().optional(),
      installCommand: z.string().optional(),
      buildCommand: z.string().optional(),
      outputDirectory: z.string().optional(),

      production: z.boolean().default(true),

      /**
       * Secrets to forward to the Vercel project as runtime env vars.
       * Each entry names a key in the environment's secrets.yaml; the same
       * name is set on the Vercel project. Used for app-runtime secrets
       * that aren't outputs of an imported instance (e.g. BETTER_AUTH_SECRET).
       */
      secretEnv: z.array(z.string()).default([]),
    })
    .refine((c) => Boolean(c.build) !== Boolean(c.sourceDir), {
      message: 'Provide exactly one of `build` (static prebuilt) or `sourceDir` (Vercel builds).',
    }),
  outputs: z.object({
    projectUrl: z.string(),
    projectId: z.string(),
    deployUrl: z.string().optional(),
  }),
  async apply(config, ctx) {
    const vercelToken = ctx.secrets['VERCEL_TOKEN']
    if (!vercelToken) throw new Error('Missing secret: VERCEL_TOKEN')

    const isStatic = Boolean(config.build)

    const settingsInput: CreateProjectInput = isStatic
      ? { framework: null }
      : {
          framework: config.framework ?? undefined,
          rootDirectory: config.rootDirectory,
          installCommand: config.installCommand,
          buildCommand: config.buildCommand,
          outputDirectory: config.outputDirectory,
        }

    let project = await findProject(vercelToken, config.projectName, config.teamId)
    if (project) {
      console.log(`  Project "${config.projectName}" already exists`)
      await syncProjectSettings(vercelToken, project.id, config.teamId, settingsInput)
      console.log(`  Synced project settings`)
    } else {
      project = await createProject(vercelToken, config.projectName, config.teamId, settingsInput)
      console.log(`  Created project "${config.projectName}"`)
    }

    const envVars: Record<string, string> = {}
    for (const [instanceName, outputs] of Object.entries(ctx.imports)) {
      if (typeof outputs === 'object' && outputs !== null) {
        for (const [key, value] of Object.entries(outputs as Record<string, unknown>)) {
          if (typeof value === 'string') {
            const envKey = `${instanceName}_${key}`.toUpperCase().replace(/-/g, '_')
            envVars[envKey] = value
          }
        }
      }
    }
    // Vercel doesn't expose the project slug as a system env var. Inject it
    // ourselves so runtime code can construct the bare `<projectName>.vercel.app`
    // alias (which VERCEL_PROJECT_PRODUCTION_URL hides once a custom domain
    // is attached).
    envVars['VERCEL_PROJECT_NAME'] = config.projectName
    for (const secretName of config.secretEnv) {
      const value = ctx.secrets[secretName]
      if (!value) {
        throw new Error(
          `secretEnv references "${secretName}" but it's missing from this environment's secrets.yaml`,
        )
      }
      envVars[secretName] = value
    }
    if (Object.keys(envVars).length > 0) {
      await syncEnvVars(vercelToken, project.id, config.teamId, envVars, [
        'production',
        'preview',
        'development',
      ])
      console.log(`  Synced env vars: ${Object.keys(envVars).join(', ')}`)
    }

    if (config.domain) {
      await syncDomain(vercelToken, project.id, config.teamId, config.domain)
      console.log(`  Domain "${config.domain}" configured`)
    }

    let uploadDir: string
    if (isStatic && config.build) {
      const buildCwd = path.resolve(ctx.projectRoot, config.build.cwd ?? '.')
      console.log(
        `  Building: ${config.build.command} (in ${path.relative(ctx.projectRoot, buildCwd) || '.'})`,
      )
      execSync(config.build.command, { cwd: buildCwd, stdio: 'inherit' })
      uploadDir = path.resolve(ctx.projectRoot, config.build.outputDir)
    } else if (config.sourceDir) {
      uploadDir = path.resolve(ctx.projectRoot, config.sourceDir)
    } else {
      // refine() guarantees this, but TS doesn't know it
      throw new Error('unreachable: neither build nor sourceDir set')
    }

    const vercelDir = path.join(uploadDir, '.vercel')
    fs.mkdirSync(vercelDir, { recursive: true })
    fs.writeFileSync(
      path.join(vercelDir, 'project.json'),
      JSON.stringify({ orgId: project.accountId, projectId: project.id }),
    )

    const deployUrl = deployToVercel(
      vercelToken,
      uploadDir,
      config.teamId,
      config.production,
      ctx.projectRoot,
    )

    return {
      projectUrl: `https://${config.projectName}.vercel.app`,
      projectId: project.id,
      deployUrl,
    }
  },
  async destroy(config, ctx) {
    const vercelToken = ctx.secrets['VERCEL_TOKEN']
    if (!vercelToken) throw new Error('Missing secret: VERCEL_TOKEN')

    const project = await findProject(vercelToken, config.projectName, config.teamId)
    if (project) {
      await vercelFetch(`/v9/projects/${project.id}`, vercelToken, config.teamId, {
        method: 'DELETE',
      })
      console.log(`  Deleted project "${config.projectName}"`)
    } else {
      console.log(`  Project "${config.projectName}" not found — skipping`)
    }
  },
})
