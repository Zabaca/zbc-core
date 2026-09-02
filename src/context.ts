// The two questions every module used to answer for itself.
//
// "What is this secret" was written seventeen times, in two spellings that
// disagree about what absent means (`!value`, which calls an empty string
// missing, and `=== undefined`, which does not). "What did the instance I
// imported emit" was written six times, and the copies differed in whether a
// non-string counted, whether an empty string counted, and which of the three
// distinct failures they could tell apart.
//
// Both live here now, and `ApplyContext` is how a module reaches them. The
// wording of the three `output` failures is `cloudflare-api`'s `resolveRef`
// verbatim: a missing import and a missing output are both silently
// `undefined` otherwise, and an apply that carries `Bearer undefined` fails
// much later, at a Cloudflare 403 that reads like a permissions problem.
//
// Runs under the CLI and under a consumer's own bun. Pure — no I/O, no
// runtime-specific globals — which is what lets it be tested as a value.

import type {
  ApplyContext,
  ApplyContextInput,
  OutputOptions,
  OutputRef,
  SecretOptions,
} from './types'

/** `ctx.secret`, over a plain secrets record. */
export function resolveSecret(
  secrets: Record<string, string>,
  key: string,
  opts: SecretOptions = {},
): string {
  const raw = secrets[key]
  const subject =
    opts.field === undefined ? `Secret "${key}"` : `${opts.field} needs secret "${key}", which`
  if (raw === undefined) {
    throw new Error(`${subject} is missing from this environment's secrets.yaml`)
  }
  // `KEY:` with nothing after it parses to null, and that is the most natural
  // spelling of the intentionally blank placeholder `allowBlank` exists for —
  // so it means what `KEY: ""` means rather than a different failure. The
  // coercion also keeps the return type honest: without it, a module that asked
  // for a string gets `null` and finds out somewhere much further downstream.
  const value = raw === null ? '' : raw
  if (value === '' && !opts.allowBlank) {
    throw new Error(`${subject} is empty in this environment's secrets.yaml`)
  }
  return value
}

/**
 * `ctx.output`, over a plain imports record.
 *
 * The three messages are the whole value of this function: `field` says which
 * line of the instance file to look at, and the three cases are told apart
 * because they have three different fixes.
 *
 * `ref` is typed loosely on purpose. A zod-inferred config marks both halves
 * optional in some spellings, and the checks have to run at runtime regardless
 * — a `from` naming an instance that is not imported is a real failure mode and
 * nothing in the type system is catching it here.
 */
export function resolveOutput(
  ref: OutputRef,
  imports: Record<string, unknown>,
  field: string,
  opts: OutputOptions = {},
): string {
  if (!ref.from || !ref.output) {
    throw new Error(`${field} must name both an instance (\`from\`) and an output (\`output\`)`)
  }
  const outputs = imports[ref.from]
  if (outputs === undefined) {
    throw new Error(
      `${field} references instance "${ref.from}", which is not in this instance's imports`,
    )
  }
  const value = (outputs as Record<string, unknown> | null)?.[ref.output]
  if (typeof value !== 'string' || (value === '' && !opts.allowBlank)) {
    throw new Error(
      `${field} references output "${ref.output}" on instance "${ref.from}", which doesn't emit it`,
    )
  }
  return value
}

/** The context the engine hands a module: the three fields plus the two rules. */
export function createApplyContext(input: ApplyContextInput): ApplyContext {
  return {
    secrets: input.secrets,
    imports: input.imports,
    projectRoot: input.projectRoot,
    secret(key, opts) {
      return resolveSecret(input.secrets, key, opts)
    },
    output(ref, field, opts) {
      return resolveOutput(ref, input.imports, field, opts)
    },
  }
}

/**
 * Upgrade whatever a caller passed into a full context, leaving one that is
 * already full — the engine's destroy context resolves imports on demand, and
 * rebuilding it here would throw that away.
 *
 * `defineModule` calls this on every `apply`/`destroy`, so a module body may
 * assume the methods exist no matter who invoked it.
 */
export function ensureApplyContext(ctx: ApplyContextInput | ApplyContext): ApplyContext {
  const candidate = ctx as ApplyContext
  return typeof candidate.secret === 'function' && typeof candidate.output === 'function'
    ? candidate
    : createApplyContext(ctx)
}
