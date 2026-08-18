// Contributed from foundry, 2026-08-18 — the second group of host-converging
// modules to arrive that way, after systemd-unit / host-file /
// docker-compose-stack on 2026-08-03.
//
// The comments below cite `ADR-NNNN` and sibling test files by bare name. Those
// are **foundry's**, not this repository's, and they are kept rather than
// stripped because each one is the record of a failure that shaped the code —
// a reference a reader can go and find beats a rationale nobody can check.
import { execSync } from 'node:child_process'

// host-exec — the one place a module reaches the machine by running a command,
// and the only place a test can stand in front of it.
//
// **Why this exists.** An audit on 2026-08-15 found that 14 of the 17
// apply-bearing modules in this directory have an `apply` no test invokes:
// gutting `apply` to a no-op left the suite byte-identical. The three that did
// verify theirs were the Cloudflare modules, which replace `globalThis.fetch`
// and run the *real* apply against an in-memory Cloudflare — proof that the
// property is reachable, and the pattern this file generalises to commands.
//
// Two of the fourteen needed no new mechanism, because `host-symlink` and
// `claude-settings` touch the filesystem and a filesystem has temp directories;
// both were converted the same day, which is why the count is 12 rather than 14
// by the time this file exists — and 11 once `tailscale-serve` lands. The rest
// hardcode `execSync` against global machine state — `tailscale serve`, `incus`,
// `apt-get`, `gh` — where there is no equivalent of a temp directory, because
// the machine is the only one there is. Hence a seam rather than a harness: the
// thing that cannot be duplicated has to be substitutable instead. Two of the
// eleven are not this file's to take: `tailscale-acl` and `tailscale-authkey`
// reach the Tailscale API over `fetch`, so they convert the Cloudflare way.
//
// **This was already asked for, in writing.** `declared-once.test.ts` registers
// a duplicated `run` across `apt-packages` and `incus-storage-pool` and says of
// it: "Collapse it the way provision-core was collapsed if a third copy
// appears — `vm` and `git-worktree` each already have a `run` with a different
// signature, so the count is closer than it looks." That registry entry retires
// when those modules convert; this file is where they converge.
//
// **Why a mutable binding rather than a parameter.** The obvious home for this
// is `ApplyContext`, which the engine already threads into every `apply`.
// Widening the engine's own contract to carry a property only tests observe
// makes every consumer pay for one consumer's test strategy — the seam is a
// module-layer concern and `src/types.ts` is the wrong place to express it.
//
// In foundry, where this was written, that argument came second: `ApplyContext`
// was reachable only through the `vendor/zbc/` subtree, whose commits may not
// mix with other paths, so widening it meant a push-and-pull round trip per
// iteration. That half no longer applies here — this file now lives beside
// `src/types.ts` — and it is recorded rather than deleted because the reason
// that survives is the one that generalises.
//
// **Why not a mock library.** A library asserts on *calls*. What makes the
// Cloudflare tests honest is that their stub is a small in-memory version of the
// world, so applying twice sees the state the first pass left behind and a
// no-op means the converge really settled. A recorded call list cannot say that.
// The seam is deliberately thin enough that the interesting object is the fake
// the test writes, not this file.
//
// **The surface grows with its consumers, on purpose.** `ExecOptions` carried
// `timeout` and nothing else while `tailscale-serve` was the only converted
// module, because that is all it uses. `input`, `maxBuffer` and `stream` arrived
// with `vm` and `vm-provision` — the ADR names the first two by their absence
// and says each "arrives with the module that needs it and the test that
// exercises it", which is the standard they are held to below: every one of them
// is a behaviour those modules already had under `execSync` and would have lost
// silently in the conversion, and every one has a test that fails without it.
// `cwd` is still absent, because nothing has needed it yet.
//
// `execStatus` is the fourth of those arrivals — the non-throwing exit-code
// variant the ADR describes as "the one four modules spell `runStatus`". `vm`
// needs it at four call sites where a non-zero exit is the expected answer
// rather than a failure, and unwrapping `execSync`'s error object is precisely
// the Node detail this seam exists to keep out of modules.

/** What a converted module may ask for. See the note above on why it is small. */
export interface ExecOptions {
  /** Milliseconds before the command is killed. */
  timeout?: number
  /**
   * Written to the command's stdin, which is closed straight after.
   *
   * `vm-provision` hands a whole provisioning script to `bash -s` this way so
   * that the secrets it exports never appear in a process list.
   */
  input?: string
  /**
   * Bytes of captured output tolerated before the command is killed.
   *
   * Node's default is 1 MB and `incus init` alone can exceed it: an image pull
   * writes a progress bar to stderr, which is captured and therefore counts.
   * Exceeding it is an ENOBUFS throw, not a truncation.
   */
  maxBuffer?: number
  /**
   * Send stdout and stderr to this process's own streams instead of capturing.
   *
   * For the one command here that takes minutes — `vm-provision` running apt
   * and a toolchain script inside a guest — where an operator watching an apply
   * needs to see it happening. Nothing is captured, so `exec` returns `''` and
   * a failure's `stderr` is null; the diagnosis was on the console as it ran.
   */
  stream?: boolean
}

/** Run a command, return its stdout. Throws on a non-zero exit, as `execSync` does. */
export type Exec = (command: string, options?: ExecOptions) => string

/**
 * The real one: stdin closed unless fed, stdout and stderr captured unless streamed.
 *
 * stdin is not the caller's, so a command that unexpectedly reads it sees EOF
 * instead of stopping an interactive `bun run apply` dead at a terminal. Measured,
 * because it is not obvious: `'pipe'` with no `input` is equivalent — `execSync`
 * closes the write end at once — so the choice that carries weight is against
 * `'inherit'`, and `'ignore'` says that without implying a pipe nobody feeds.
 * With an `input` it has to be `'pipe'`, which is the same closed-afterwards
 * stdin with something in it first.
 *
 * `?? ''` rather than a bare `.toString()`: under `stream` there is no captured
 * stdout and `execSync` returns `null`, which would throw here instead.
 *
 * **`maxBuffer` is spread in only when asked for, and that is not a style
 * choice.** Measured on bun 1.3.14: `maxBuffer: undefined` is not the same as
 * omitting the key — an omitted one gets Node's 1 MB default and an explicit
 * `undefined` is *unbounded*. Written the obvious way, every caller that never
 * mentions `maxBuffer` would have had its cap silently removed by this option
 * arriving, which is the opposite of what adding an option should do. `timeout`
 * and `input` need no such care because for both of them undefined and absent
 * mean the same thing.
 */
const executeOnThisMachine: Exec = (command, options) =>
  (
    execSync(command, {
      stdio: [
        options?.input === undefined ? 'ignore' : 'pipe',
        options?.stream === true ? 'inherit' : 'pipe',
        options?.stream === true ? 'inherit' : 'pipe',
      ],
      input: options?.input,
      timeout: options?.timeout,
      ...(options?.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    }) ?? ''
  ).toString()

let installed: Exec = executeOnThisMachine

/**
 * Run a command on this machine.
 *
 * Modules call this instead of importing `execSync`. It is a delegating wrapper
 * rather than the implementation itself so that `withExec` can replace what it
 * delegates to without every caller having to re-import anything.
 */
export const exec: Exec = (command, options) => installed(command, options)

/**
 * Run `body` with `fake` standing in for the machine, then put the real one back.
 *
 * Scoped rather than a bare setter, and the restore is in a `finally` *after*
 * the body's promise settles. Both halves matter: a set/restore pair leaks the
 * fake into every later test in the file when the body throws, and a restore
 * that does not await hands the real machine back in the middle of an
 * in-flight `apply` — which for these modules means a real `tailscale serve` or
 * `incus` call from a unit test.
 */
export async function withExec<T>(fake: Exec, body: () => Promise<T>): Promise<T> {
  const previous = installed
  installed = fake
  try {
    return await body()
  } finally {
    installed = previous
  }
}

/** What a command did when a non-zero exit is an answer rather than a failure. */
export interface ExecResult {
  /** The command's exit code. 0 is success; anything else is not. */
  code: number
  /** stdout and stderr, concatenated, because either may carry the diagnosis. */
  out: string
}

/**
 * Run a command and report its exit code instead of throwing on a non-zero one.
 *
 * `vm` polls a guest with `incus exec … -- true` until it answers, and asks
 * `incus list` about a machine that may not exist yet. In both, failure is the
 * expected first answer, so a throw would be control flow. Written at each call
 * site this would be four copies of the same unwrapping of `execSync`'s error
 * — `status`, and two Buffers — which is the Node detail the seam exists to
 * hold in one place.
 *
 * When neither stream carried a word — a command that fails silently, or a fake
 * that refuses by throwing a plain `Error` and so has no `status` to offer —
 * the error's own message becomes the output and the code falls back to 1.
 * Reporting 0 would read as success, and an empty `out` would strip the only
 * diagnosis there was: `vm` puts this string straight into the error it raises.
 */
export function execStatus(command: string, options?: ExecOptions): ExecResult {
  try {
    return { code: 0, out: exec(command, options) }
  } catch (error) {
    const failure = error as {
      status?: number
      stdout?: unknown
      stderr?: unknown
      message?: string
    }
    const captured = `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}`
    return {
      code: failure.status ?? 1,
      out: captured === '' ? (failure.message ?? '') : captured,
    }
  }
}
