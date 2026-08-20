// Contributed from foundry, 2026-08-19 — the third group to arrive that way,
// after systemd-unit / host-file / docker-compose-stack on 2026-08-03 and the
// four host primitives on 2026-08-18.
//
// The comments below cite `ADR-NNNN` and sibling test files by bare name. Those
// are **foundry's**, not this repository's, and they are kept rather than
// stripped because each one is the record of a failure that shaped the code —
// a reference a reader can go and find beats a rationale nobody can check.

import { z } from 'zod'
import { type ExecOptions, exec } from '../host-exec'

// incus-core — one door to the incus daemon, for the modules that declare its
// server-side state.
//
// Three modules converge incus itself rather than a guest — `incus-listener`,
// `incus-project` and `incus-trust` — and all three need the same two lines: a
// `sudo incus` invocation with a timeout, and a JSON list read back from it.
// Written out three times that is exactly what `declared-once.test.ts` catches,
// and rightly: unlike the `sleep` and `run` pairs that test registers as
// deliberate, **there is a version of this that drifts into a bug.** The `sudo`
// prefix is a decision about how this repo reaches the daemon, not a coincidence
// of two modules needing the same wrapper — and `remote-guests/02` is about to
// add a second form of it, where the prefix becomes `incus --project <p>` and
// `sudo` disappears because a remote endpoint authenticates as an ordinary user.
// One place to add that is the point. Same shape as `tailscale-core` and
// `provision-core`: a directory under `modules/` that is not itself a module.
//
// **Why sudo, measured rather than assumed.** The incus socket is
// `root:incus-admin`, and `uptown` — the user an apply runs as — is in neither.
// On 2026-08-18 `incus version` as that user printed "Server version:
// unreachable" while `sudo incus version` printed 6.0.0. Adding the user to
// `incus-admin` would be the alternative and is worse: group membership on that
// socket is unconditional admin over every project, which is precisely the
// authority ADR-0026 declines to hand out.
//
// Routed through `host-exec` rather than `execSync` so a test can stand in front
// of the machine and run these modules' real `apply` (ADR-0023). Nothing here
// widens `ExecOptions`; every call is a command with a timeout, and every incus
// subcommand these modules use exits 0 on the paths they read, so the
// non-throwing `runStatus` variant that four unconverted modules carry is not
// needed and is not added.

/**
 * Long enough for `project create` on a busy daemon, short enough that a wedged
 * one fails the apply instead of hanging it. `incus-storage-pool` gives its
 * pool creation ten minutes; nothing here writes to disk.
 */
export const INCUS_TIMEOUT_MS = 60_000

/**
 * What a plain incus name looks like — a project, a trust entry, an instance.
 *
 * One copy rather than one per module: every name matched by it is interpolated
 * into an `incus` command built here, so this is a decision about what this
 * repo will hand a shell and not a coincidence of two modules validating
 * strings. `declared-once.test.ts` caught the second copy the day it was
 * written, which is the rule working rather than the rule being awkward.
 */
export const PLAIN_INCUS_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Which incus daemon a command is addressed to, and which project inside it.
 *
 * Absent means the local unix socket and whatever project that endpoint calls
 * default — which is what every declaration in this repo says today, and the
 * reason the two renderers below are written so that an absent target changes
 * no byte of the command line.
 */
export interface IncusTarget {
  /** A configured incus remote, e.g. `ryzen-9`. Absent means the local socket. */
  remote?: string
  /** An incus project, e.g. `zabaca`. Absent means the endpoint's default. */
  project?: string
}

/**
 * For modules that let a declaration name one. Both names are interpolated
 * straight into a shell command, so both are held to `PLAIN_INCUS_NAME` for the
 * reason that constant exists.
 */
export const incusTargetSchema = z.object({
  remote: z.string().regex(PLAIN_INCUS_NAME).optional(),
  project: z.string().regex(PLAIN_INCUS_NAME).optional(),
})

/**
 * The `incus` invocation for a target — everything up to the subcommand.
 *
 * **`sudo` is a substitution, not decoration.** It is here because the local
 * socket is `root:incus-admin` and the user an apply runs as is in neither
 * group (measured 2026-08-18: `incus version` as `uptown` says "Server version:
 * unreachable", `sudo incus version` says 6.0.0). A remote endpoint is TLS and
 * authenticates as whoever holds the client certificate, so `sudo` there is not
 * merely unnecessary — it would elevate to a *local* root that has nothing to
 * do with the identity the remote authorises. It would also work by accident on
 * this box, where sudo is passwordless, and fail everywhere else.
 *
 * `--project` is decided separately and by `project` alone, because it scopes
 * what an endpoint shows rather than which socket is opened. Foundry converging
 * its own guest inside `zabaca` would be local, projected, and still root.
 */
export function incusCommand(target?: IncusTarget): string {
  return [
    target?.remote === undefined ? 'sudo incus' : 'incus',
    target?.project === undefined ? '' : `--project ${target.project}`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * How a guest is named to a target: bare on the local daemon, `remote:name` on
 * a remote.
 *
 * The invocation above is not enough on its own, and the gap is silent: an
 * unqualified name means the *default* remote, so `incus --project zabaca start
 * cedarpad-ws` is a well-formed command that acts on the local daemon and
 * reports success. Every call site that names a guest goes through here.
 *
 * With an empty name it is the bare scope — `ryzen-9:` — which is the form
 * `incus list <remote>:` takes, and empty locally so the caller drops it.
 */
export function guestRef(target: IncusTarget | undefined, name: string): string {
  return target?.remote === undefined ? name : `${target.remote}:${name}`
}

/**
 * Run an incus subcommand. `args` is everything after `incus`. Throws on a
 * non-zero exit.
 *
 * Local by construction and deliberately not target-aware: the three modules
 * that use it converge the *substrate* — the listener, the projects, the trust
 * entries — which ADR-0026 keeps as foundry's own and which by definition runs
 * on the box holding the socket. `vm` and `vm-provision` are the guest-facing
 * pair and they take a target; they build their own runner on the two
 * renderers above rather than calling this one, and `vm`'s header says why.
 */
export function incus(args: string, options?: ExecOptions): string {
  return exec(`${incusCommand()} ${args}`, { timeout: options?.timeout ?? INCUS_TIMEOUT_MS })
}

/**
 * Run an incus subcommand that was asked for `--format json`, and read the list
 * back.
 *
 * Unparseable output is an error rather than an empty list. Reading it as "there
 * is nothing there" is how a module creates a project that already exists, or
 * issues a second credential for an identity that already holds one — the same
 * failure `parseServeStatus` refuses one module over. `null` is the exception,
 * because incus genuinely prints it for an empty result in some versions, and it
 * means the list is empty rather than that the read failed.
 */
export function incusJson<T>(args: string, options?: ExecOptions): T {
  const out = incus(args, options)
  let parsed: unknown
  try {
    parsed = JSON.parse(out.trim() === '' ? 'null' : out)
  } catch {
    throw new Error(`\`incus ${args}\` did not print JSON: ${out.trim().slice(0, 200)}`)
  }
  if (parsed === null) return [] as unknown as T
  if (!Array.isArray(parsed)) {
    throw new Error(
      `\`incus ${args}\` printed JSON that is not a list: ${out.trim().slice(0, 200)}`,
    )
  }
  return parsed as T
}

/**
 * What incus accepts as an expiry expression, taken from the daemon rather than
 * from a man page: `<count><unit>`, where the unit is one of `S` seconds, `M`
 * minutes, `H` hours, `d` days, `w` weeks, `m` months, `y` years.
 *
 * **Anchored to the binary.** `incusd` 6.0.0 on this box carries exactly one
 * copy of `^(\d+)(S|M|H|d|w|m|y)$` and exactly one `Invalid expiry expression`,
 * and `sudo incus config set core.remote_token_expiry zzz` answers
 * `cannot set 'core.remote_token_expiry' to 'zzz': Invalid expiry expression`
 * (probed 2026-08-18 with a value no plausible parser accepts, so the daemon
 * rejected it and nothing was written). The casing is the part worth having
 * from the machine: `H` is hours and `m` is *months*, so `1h` and `1M` are both
 * things a reader would write meaning something else.
 *
 * Two modules need it and they need it in opposite directions —
 * `incus-listener` refuses a declaration the daemon would reject, and the
 * enrolment path refuses to issue against a daemon whose expiry is not a real
 * one — so it lives here rather than being written twice.
 */
export const EXPIRY_EXPRESSION = /^(\d+)(S|M|H|d|w|m|y)$/

/**
 * Whether what the daemon reports for an expiry key is a real deadline.
 *
 * Empty is what `core.remote_token_expiry` prints when nothing has set it, and
 * incus's own default for that key is documented as "no expiry" — so absent,
 * blank and whitespace all mean *tokens never die*, which is the state the
 * enrolment path refuses to issue into. A zero count is refused for the same
 * reason from the other end: `0H` parses, and it is not an expiry policy, it is
 * every token being dead before it is handed over.
 */
export function namesAnExpiry(value: string | undefined): boolean {
  const match = EXPIRY_EXPRESSION.exec((value ?? '').trim())
  return match !== null && Number(match[1]) > 0
}
