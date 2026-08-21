import { createHash } from 'node:crypto'

// The parts of "converge the inside of a machine" that do not care how the
// work is delivered: what to run, whether to run it, and how to decide that
// cheaply on a no-op apply.
//
// Two transports use this. vm-provision reaches Incus guests over `incus exec`
// — no IP, no keys, no waiting for sshd. remote-provision reaches machines we
// do not host (the vultr exit node) over SSH. Everything below is identical
// for both, and duplicating it would mean two digests that drift.

export const MARKER_DIR = '/var/lib/zbc-provision'

/** POSIX single-quote escaping: close, escape, reopen. */
export const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/**
 * Values delivered to the script but excluded from the digest.
 *
 * `volatileEnv` is accepted here only so callers can pass one object around;
 * it is never read. A freshly minted auth key changes on every apply, and
 * hashing it would re-run apt-get and the whole toolchain install every time.
 * The digest answers "what should this machine be", and a credential is not
 * part of that answer — see shouldProvision for how a pending join still
 * forces a run.
 */
export function provisionDigest(input: {
  packages: string[]
  script: string
  env: Record<string, string>
  volatileEnv?: Record<string, string>
}): string {
  // Canonicalized so incidental reordering doesn't churn the digest, but any
  // real change — including a rotated secret value — does.
  const canonical = JSON.stringify({
    packages: [...input.packages].sort(),
    script: input.script,
    env: Object.keys(input.env)
      .sort()
      .map((k) => [k, input.env[k]]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function renderProvisionScript(input: {
  packages: string[]
  script: string
  env?: Record<string, string>
  volatileEnv?: Record<string, string>
}): string {
  const lines = ['set -euo pipefail']

  // Exported here rather than passed as command arguments so secret values
  // never appear in any process list; the payload arrives on stdin.
  // Volatile values take the same route for the same reason.
  for (const [key, value] of Object.entries({ ...input.env, ...input.volatileEnv })) {
    lines.push(`export ${key}=${sq(value)}`)
  }

  if (input.packages.length > 0) {
    lines.push(
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      `apt-get install -y -qq ${[...input.packages].sort().join(' ')}`,
    )
  }

  lines.push(input.script)
  return `${lines.join('\n')}\n`
}

/**
 * Reads `ENVVAR: "instance.field"` references out of another instance's
 * outputs. Outputs only exist during an apply, so this is the only way a
 * just-minted credential can reach a script without being written down.
 */
export function resolveVolatileEnv(
  spec: Record<string, string>,
  imports: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [envVar, ref] of Object.entries(spec)) {
    const dot = ref.indexOf('.')
    if (dot <= 0 || dot === ref.length - 1) {
      throw new Error(`volatileEnvFrom.${envVar}: "${ref}" is not of the form instance.field`)
    }
    const instance = ref.slice(0, dot)
    const field = ref.slice(dot + 1)
    const source = imports[instance]
    if (source === undefined || source === null || typeof source !== 'object') {
      throw new Error(
        `volatileEnvFrom.${envVar}: no imported instance named "${instance}" — add it to this instance's imports`,
      )
    }
    const value = (source as Record<string, unknown>)[field]
    if (value === undefined) {
      throw new Error(
        `volatileEnvFrom.${envVar}: instance "${instance}" has no output field "${field}"`,
      )
    }
    out[envVar] = String(value)
  }
  return out
}

/**
 * An unchanged digest normally means "skip". A non-empty volatile value
 * overrides that: the authkey module mints only when a device is missing or
 * offline, so a key in hand means there is a join to perform that the digest
 * cannot see. An empty one is the steady state and skips as usual.
 */
export function shouldProvision(input: {
  current: string
  digest: string
  volatileEnv: Record<string, string>
  force: boolean
}): boolean {
  if (input.force) return true
  if (input.current !== input.digest) return true
  return Object.values(input.volatileEnv).some((v) => v !== '')
}

/** The trailing marker write, appended only after everything above succeeded. */
export function markerWrite(marker: string, digest: string): string {
  return `mkdir -p ${MARKER_DIR}\nprintf '%s' ${sq(digest)} > ${MARKER_DIR}/${marker}\n`
}
