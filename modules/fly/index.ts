import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * fly — deploys a package to Fly.io via `fly deploy`.
 *
 * Same shape as the `cloudflare` module: a THIN orchestrator. `apply` runs on
 * the operator machine, reads the Fly credential from `ctx.secrets`, runs an
 * optional local build, then shells `fly deploy` in the package's own
 * directory. The app TOPOLOGY (processes, services, ports, handlers, VM size,
 * regions, autostop/autostart) lives in that package's `fly.toml` — Fly is the
 * source of truth for it, not this module.
 *
 * Exists because Cloudflare cannot serve a payload that needs raw inbound TCP:
 * Containers are reachable only through a Worker's `fetch`, and Spectrum
 * proxies TCP only to an origin IP, which a Worker does not have. See this
 * repository's docs/adr/0006-fly-returns-as-a-deploy-module.md — deliberately a
 * Deploy Module, not the Provisioning Module that zbc's ADR-0001
 * (docs/adr/0001-nats-server-cloudflare-package.md) deleted.
 *
 * Two things `fly.toml` cannot express, which this module therefore owns:
 *
 *   - **The app existing at all.** `fly deploy` fails against an app that was
 *     never created, so apply does a list→create first (idempotent).
 *   - **IP allocation.** An IP is account state, not app config. A dedicated
 *     IPv4 is REQUIRED for any port that is not 80/443 ($2/mo) — shared IPv4 is
 *     80/443 only — so a raw-TCP service is unreachable without one, and that
 *     is not a failure `fly deploy` reports.
 *
 * Auth is non-interactive: flyctl reads `FLY_API_TOKEN` from the environment,
 * so no `fly auth login` is needed. NOTE: Fly macaroon tokens contain a literal
 * space (`FlyV1 fm2_…`). Any pipeline that strips whitespace out of the secret
 * yields a token that fails with a bare `401 token validation error`.
 *
 * Secrets are STAGED (`fly secrets set --stage`) rather than set directly,
 * because an unstaged `fly secrets set` triggers its own deployment — staging
 * lets the `fly deploy` below pick them up so one apply is one deployment. This
 * is the opposite order from the `cloudflare` module, which must push Worker
 * secrets *after* deploy because the script has to exist first.
 */

const flyValueSchema = z.union([
  z.string(),
  z.object({
    /** Env var name inside the app. */
    name: z.string(),
    /** Literal value, straight from this instance's config file. */
    value: z.string(),
  }),
  z.object({
    /** Env var name inside the app. */
    name: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance to read. */
    output: z.string(),
  }),
  z.object({
    /** Env var name inside the app. */
    name: z.string(),
    /**
     * A key in this environment's secrets.yaml, exposed under `name`.
     *
     * The plain-string form already reads a secret, but it forces the app's
     * env var to be spelled exactly like the secret. An app whose interface
     * says `WALGIT_S3_ACCESS_KEY_ID` cannot then read a credential filed as
     * `WAREHOUSE_R2_ACCESS_KEY_ID` — and the alternative is a second copy of
     * the same credential under a second name, which is one more thing to
     * forget when it rotates.
     */
    secret: z.string(),
  }),
])

type FlyValueEntry = z.infer<typeof flyValueSchema>

/** Resolve a flySecrets entry to its `{ name, value }` pair. */
export function resolveFlyValue(
  entry: FlyValueEntry,
  ctx: { secrets: Record<string, string>; imports: Record<string, unknown> },
  fieldName: string,
): { name: string; value: string } {
  if (typeof entry === 'string') {
    const value = ctx.secrets[entry]
    if (!value) {
      throw new Error(
        `${fieldName} references "${entry}" but it's missing from this environment's secrets.yaml`,
      )
    }
    return { name: entry, value }
  }

  if ('value' in entry) {
    return { name: entry.name, value: entry.value }
  }

  if ('secret' in entry) {
    const value = ctx.secrets[entry.secret]
    if (!value) {
      throw new Error(
        `${fieldName} entry "${entry.name}" reads secret "${entry.secret}", ` +
          "which is missing from this environment's secrets.yaml",
      )
    }
    return { name: entry.name, value }
  }

  const instanceOutputs = ctx.imports[entry.from]
  if (!instanceOutputs) {
    throw new Error(
      `${fieldName} entry "${entry.name}" reads from instance "${entry.from}", which is not in this instance's imports`,
    )
  }
  const value = (instanceOutputs as Record<string, unknown>)[entry.output]
  if (value === undefined) {
    throw new Error(
      `${fieldName} entry "${entry.name}" reads output "${entry.output}" from instance "${entry.from}", which does not emit it`,
    )
  }
  return { name: entry.name, value: String(value) }
}

/** Run flyctl, capturing BOTH streams — flyctl splits human output across them,
 *  so parsing only stdout is how a silent non-deploy would go unnoticed. */
function fly(
  workdir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { input?: string; allowFailure?: boolean } = {},
): { out: string; status: number } {
  const res = spawnSync('fly', args, {
    cwd: workdir,
    env,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  })
  const combined = `${res.stdout?.toString() ?? ''}\n${res.stderr?.toString() ?? ''}`
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      'flyctl not found on PATH. Install it with `brew install flyctl` or `curl -L https://fly.io/install.sh | sh`.',
    )
  }
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(
      `fly ${args.join(' ')} failed (exit ${res.status}):\n${combined.trim() || res.error?.message}`,
    )
  }
  return { out: combined, status: res.status ?? 1 }
}

/** Read `app = "name"` out of the package's fly.toml. The app name belongs to
 *  the package's own topology file; `appName` in config only overrides it (the
 *  per-PR preview case, mirroring the cloudflare module's `workerName`). */
/** Did `fly deploy` say, in its own words, that machines reached a good state?
 *
 *  Exit 0 is not the signal — flyctl prints its build and then exits 0 on paths
 *  where nothing converged, which is what the caller's guard exists to catch.
 *  The vocabulary differs by path, and the guard originally knew only the
 *  first-launch half:
 *
 *    launching a new machine  -> "Finished launching new machines"
 *    a machine-less group     -> "No machines in group"
 *    non-rolling update       -> "update finished: success"
 *    ROLLING update           -> "✔ Machine <id> is now in a good state"
 *
 *  The last line is the one that was missing, and it is the line every deploy
 *  after the first prints. zbc-walgit was launched by hand, so CI's first run
 *  against it took the rolling path and the guard failed a deploy that had in
 *  fact converged (run 32881480843, 2026-08-25). A false red on a healthy
 *  deploy costs the guard its credibility as surely as a false green does.
 *
 *  "reached stopped state" is NOT convergence and is deliberately not matched:
 *  flyctl prints it for an auto-stopped machine on its way to a good state, and
 *  also for one that stopped because it died. Only the good-state line settles it.
 */
export function machinesConverged(out: string): boolean {
  return /(update finished: success|Finished launching new machines|No machines? in group|Machine \w+ is now in a good state)/.test(
    out,
  )
}

function appNameFromFlyToml(workdir: string): string | undefined {
  const tomlPath = path.join(workdir, 'fly.toml')
  if (!fs.existsSync(tomlPath)) return undefined
  const match = fs.readFileSync(tomlPath, 'utf8').match(/^\s*app\s*=\s*["']([^"']+)["']/m)
  return match?.[1]
}

export const flyModule = defineModule({
  name: 'fly',
  configSchema: z.object({
    /** Package directory holding fly.toml + Dockerfile, relative to repo root. */
    workdir: z.string(),
    /**
     * Override the deployed app name. Omit to use the `app` declared in the
     * package's fly.toml. Set it for per-PR preview apps
     * (e.g. `walgit-pr-${process.env.PR_NUMBER}`) from a single fly.toml.
     */
    appName: z.string().optional(),
    /** Fly organisation slug the app belongs to. */
    org: z.string().default('personal'),
    /** Optional build run locally before deploy (assets, bundling). */
    build: z
      .object({
        command: z.string(),
        /** Defaults to `workdir`. Relative to repo root. */
        cwd: z.string().optional(),
      })
      .optional(),
    /**
     * App secrets, staged before deploy. Each entry is either a plain name (a
     * key in this environment's secrets.yaml), `{ name, value }` for a literal,
     * `{ name, secret }` to expose a secrets.yaml key under a different env var
     * name, or `{ name, from, output }` to pull from an imported instance's
     * outputs.
     */
    flySecrets: z.array(flyValueSchema).default([]),
    /**
     * Public IPv4. `dedicated` is REQUIRED for any service port that is not
     * 80/443 and bills $2/mo; `shared` covers 80/443 only; `none` leaves the
     * app IPv6-only. Allocation is idempotent — existing IPs are left alone.
     */
    ipv4: z.enum(['none', 'shared', 'dedicated']).default('shared'),
    /** Allocate a dedicated public IPv6 (free). Independent of `ipv4`. */
    ipv6: z.boolean().default(true),
    /** Deploy two machines instead of one (`--ha`). */
    highAvailability: z.boolean().default(false),
    /**
     * Build the image with the LOCAL Docker daemon (`--local-only`) instead of
     * Fly's remote builder. Needs Docker running at apply time; avoids paying
     * for a builder machine to spin up.
     */
    localBuild: z.boolean().default(false),
    /** Destroy+recreate the whole app on every apply (preview environments). */
    ephemeral: z.boolean().default(false),
  }),
  outputs: z.object({
    appName: z.string(),
    /** `<app>.fly.dev` — the app's default hostname. */
    hostname: z.string(),
    /** Public IPv4, when one is allocated. Empty string otherwise. */
    ipv4: z.string(),
    /** Public IPv6, when one is allocated. Empty string otherwise. */
    ipv6: z.string(),
  }),
  async apply(config, ctx) {
    const token = ctx.secrets['FLY_API_TOKEN']
    if (!token) throw new Error('Missing secret: FLY_API_TOKEN')

    const env: NodeJS.ProcessEnv = { ...process.env, FLY_API_TOKEN: token }
    const workdir = path.resolve(ctx.projectRoot, config.workdir)
    const appName = config.appName ?? appNameFromFlyToml(workdir)
    if (!appName) {
      throw new Error(
        `fly: no app name — set \`appName\` in the instance config, or \`app = "..."\` in ${config.workdir}/fly.toml`,
      )
    }

    // 0. Ephemeral: tear the whole app down first so every apply starts clean.
    if (config.ephemeral) {
      console.log(`  Ephemeral: destroying ${appName} before recreate`)
      fly(workdir, ['apps', 'destroy', appName, '--yes'], env, { allowFailure: true })
    }

    // 1. Ensure the app exists. `fly deploy` does not create one, and the
    //    failure it gives for a missing app is not obviously that.
    const list = fly(workdir, ['apps', 'list'], env)
    const exists = new RegExp(`^\\s*${appName}\\s`, 'm').test(list.out)
    if (!exists) {
      console.log(`  Creating app ${appName} (org: ${config.org})`)
      fly(workdir, ['apps', 'create', appName, '--org', config.org], env)
    }

    // 2. IPs. Idempotent: allocate only what is missing. A raw-TCP service
    //    without a dedicated v4 is silently unreachable, so this is not
    //    cosmetic — see docs/adr/0006-fly-returns-as-a-deploy-module.md.
    const ips = fly(workdir, ['ips', 'list', '-a', appName], env)
    const hasV4 = /\bv4\b/.test(ips.out)
    const hasV6 = /\bv6\b/.test(ips.out)
    if (config.ipv4 === 'dedicated' && !hasV4) {
      console.log(`  Allocating dedicated IPv4 ($2/mo)`)
      fly(workdir, ['ips', 'allocate-v4', '-a', appName, '--yes'], env)
    } else if (config.ipv4 === 'shared' && !hasV4) {
      fly(workdir, ['ips', 'allocate-v4', '--shared', '-a', appName], env, { allowFailure: true })
    }
    if (config.ipv6 && !hasV6) {
      console.log(`  Allocating IPv6`)
      fly(workdir, ['ips', 'allocate-v6', '-a', appName], env)
    }

    // 3. Optional local build. Inherit stdio so build output streams.
    if (config.build) {
      const buildCwd = path.resolve(ctx.projectRoot, config.build.cwd ?? config.workdir)
      console.log(
        `  Building: ${config.build.command} (in ${path.relative(ctx.projectRoot, buildCwd) || '.'})`,
      )
      execSync(config.build.command, { cwd: buildCwd, stdio: 'inherit', env })
    }

    // 4. Resolve every secret BEFORE staging so a bad reference fails fast,
    //    without leaving a half-configured app. `resolveFlyValue` is pure.
    const resolved = config.flySecrets.map((entry) => resolveFlyValue(entry, ctx, 'flySecrets'))

    // 5. Stage secrets. `--stage` withholds the deployment that `fly secrets
    //    set` would otherwise trigger; step 6 picks them up. Values go on the
    //    command line as NAME=VALUE — flyctl offers no stdin form — so they are
    //    visible to a local process listing, though never logged here.
    if (resolved.length > 0) {
      fly(
        workdir,
        [
          'secrets',
          'set',
          '--stage',
          '-a',
          appName,
          ...resolved.map((s) => `${s.name}=${s.value}`),
        ],
        env,
      )
      console.log(`  Staged secrets: ${resolved.map((s) => s.name).join(', ')}`)
    }

    // 6. Deploy.
    const deployArgs = ['deploy', '-a', appName, '--yes']
    if (!config.highAvailability) deployArgs.push('--ha=false')
    if (config.localBuild) deployArgs.push('--local-only')
    console.log(
      `  Deploying via flyctl (in ${config.workdir}) [app: ${appName}]${config.localBuild ? ' [local build]' : ''}`,
    )
    const { out } = fly(workdir, deployArgs, env)

    // Success-theater guard, same lesson as the cloudflare module: require a
    // confirmation that machines actually converged rather than trusting exit 0.
    if (!machinesConverged(out)) {
      throw new Error(
        `fly deploy exited 0 but printed no machine-convergence confirmation:\n${out}`,
      )
    }

    // 7. Read the IPs back for outputs — dependents need the address, and after
    //    step 2 it is whatever Fly actually holds, not what we asked for.
    const finalIps = fly(workdir, ['ips', 'list', '-a', appName], env)
    const v4 = finalIps.out.match(/\bv4\s*│\s*([0-9.]+)/)?.[1] ?? ''
    const v6 = finalIps.out.match(/\bv6\s*│\s*([0-9a-fA-F:]+)/)?.[1] ?? ''
    const hostname = `${appName}.fly.dev`
    console.log(`  Deployed: ${hostname}${v4 ? ` (${v4})` : ''}`)

    return { appName, hostname, ipv4: v4, ipv6: v6 }
  },
  async destroy(config, ctx) {
    const token = ctx.secrets['FLY_API_TOKEN']
    if (!token) throw new Error('Missing secret: FLY_API_TOKEN')
    const env: NodeJS.ProcessEnv = { ...process.env, FLY_API_TOKEN: token }
    const workdir = path.resolve(ctx.projectRoot, config.workdir)
    const appName = config.appName ?? appNameFromFlyToml(workdir)
    if (!appName) throw new Error('fly: no app name to destroy')

    // Destroying the app releases its machines AND its IPs — which matters,
    // since a dedicated IPv4 keeps billing while it is allocated. Non-fatal if
    // the app is already gone.
    const { status } = fly(workdir, ['apps', 'destroy', appName, '--yes'], env, {
      allowFailure: true,
    })
    console.log(status === 0 ? `  Destroyed app ${appName}` : `  App ${appName} already gone`)
  },
})
