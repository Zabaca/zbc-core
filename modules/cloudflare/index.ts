import * as path from 'node:path'
import * as fs from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * cloudflare — deploys a Cloudflare Worker (optionally with static assets, a
 * Durable Object, and a Container) via `wrangler deploy`.
 *
 * This is a THIN orchestrator, the same shape as the vercel/turso/lima-engine
 * modules: `apply` runs on the operator machine, reads CF creds from
 * `ctx.secrets`, runs an optional local build, then shells `wrangler deploy` in
 * the package's own directory. The Worker TOPOLOGY (name, assets binding,
 * durable_objects, containers, migrations) lives in that package's
 * `wrangler.jsonc` — wrangler is the source of truth for it, not this module.
 * That keeps the module reusable for the eventual Astro-off-Vercel migration
 * (a plain assets Worker) as well as the container-backed payloads.
 *
 * Auth is non-interactive: wrangler reads `CLOUDFLARE_API_TOKEN` +
 * `CLOUDFLARE_ACCOUNT_ID` from the environment, so no `wrangler login` is
 * needed. Worker secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) are pushed via
 * `wrangler secret put`, piped through stdin so no secret value is ever
 * interpolated into a command string.
 *
 * NOTE on containers (Phase B): `wrangler deploy` builds the container image
 * with Docker, so Docker must be running locally at apply time, and the account
 * must be on a Workers Paid plan with Containers enabled. A plain assets Worker
 * (Phase A) has neither requirement.
 */

/** Resolve the wrangler binary: prefer the package-local one, else `bunx`. */
function resolveWrangler(workdir: string): { cmd: string; pre: string[] } {
  const local = path.join(workdir, 'node_modules', '.bin', 'wrangler')
  if (fs.existsSync(local)) return { cmd: local, pre: [] }
  // Fall back to bunx; --bun keeps it on the bun runtime already in use.
  return { cmd: 'bunx', pre: ['--bun', 'wrangler'] }
}

/** Run wrangler in `workdir` with CF creds in the env; return captured stdout. */
function wrangler(workdir: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  const { cmd, pre } = resolveWrangler(workdir)
  try {
    const out = execFileSync(cmd, [...pre, ...args], {
      cwd: workdir,
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.toString()
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? ''
    throw new Error(
      `wrangler ${args.join(' ')} failed:\n${stderr || stdout || (err as Error).message}`,
    )
  }
}

const buildSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
})

export const cloudflareModule = defineModule({
  name: 'cloudflare',
  configSchema: z.object({
    /** Package dir (relative to projectRoot) that holds wrangler.jsonc. */
    workdir: z.string(),
    /**
     * Cloudflare account id. Not a secret (it appears in the dashboard URL), so
     * it lives in config — only the API token is held in secrets.yaml.
     */
    accountId: z.string(),
    /** Optional local build run before deploy (e.g. `vite build` for assets). */
    build: buildSchema.optional(),
    /**
     * Worker secrets to push after deploy. Each entry names a key in this
     * environment's secrets.yaml; the same name becomes a Worker secret
     * binding (read at runtime as `env.<NAME>`). Pushed via `wrangler secret
     * put` with the value piped through stdin.
     */
    workerSecrets: z.array(z.string()).default([]),
    /**
     * For container-backed Workers: roll the running container to the new image
     * IMMEDIATELY on deploy (`--containers-rollout immediate`). The wrangler
     * default is a GRADUAL rollout, which never drains a single always-warm,
     * DO-bound container — so a redeployed image silently never takes effect
     * until the container idle-sleeps. Set true whenever the image matters at
     * deploy time. No-op for asset-only Workers.
     */
    immediateContainerRollout: z.boolean().default(false),
  }),
  outputs: z.object({
    deployUrl: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }

    const workdir = path.resolve(ctx.projectRoot, config.workdir)

    // 1. Optional local build (assets). Inherit stdio so build output streams.
    if (config.build) {
      const buildCwd = path.resolve(ctx.projectRoot, config.build.cwd ?? config.workdir)
      console.log(
        `  Building: ${config.build.command} (in ${path.relative(ctx.projectRoot, buildCwd) || '.'})`,
      )
      execSync(config.build.command, { cwd: buildCwd, stdio: 'inherit', env })
    }

    // 2. Deploy. Creates/updates the Worker script (+ assets, DO, container).
    const deployArgs = ['deploy']
    if (config.immediateContainerRollout) deployArgs.push('--containers-rollout', 'immediate')
    console.log(
      `  Deploying via wrangler (in ${config.workdir})${config.immediateContainerRollout ? ' [immediate container rollout]' : ''}`,
    )
    const out = wrangler(workdir, deployArgs, env)
    const urlMatch = out.match(/https:\/\/[^\s"',]+\.workers\.dev[^\s"',]*/)
    const deployUrl = urlMatch?.[0] ?? ''
    console.log(`  Deployed: ${deployUrl || '(URL not parsed — see wrangler output)'}`)

    // 3. Push Worker secrets (after deploy: the script must exist first). Value
    //    piped via stdin so it never lands in a command string or the log.
    for (const name of config.workerSecrets) {
      const value = ctx.secrets[name]
      if (!value) {
        throw new Error(
          `workerSecrets references "${name}" but it's missing from this environment's secrets.yaml`,
        )
      }
      wrangler(workdir, ['secret', 'put', name], env, value)
      console.log(`  Set Worker secret: ${name}`)
    }

    return { deployUrl }
  },
  async destroy(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }
    const workdir = path.resolve(ctx.projectRoot, config.workdir)
    // `wrangler delete` removes the Worker (and its DO/container). Non-fatal if
    // already gone.
    try {
      wrangler(workdir, ['delete', '--force'], env)
      console.log('  Deleted Worker')
    } catch (err) {
      console.log(`  Worker delete skipped: ${(err as Error).message}`)
    }
  },
})
