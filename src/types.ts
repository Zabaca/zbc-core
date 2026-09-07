import type { z } from 'zod'

export type ApplyFn<TConfig, TOutputs> = (config: TConfig, ctx: ApplyContext) => Promise<TOutputs>

export type DestroyFn<TConfig> = (config: TConfig, ctx: ApplyContext) => Promise<void>

/**
 * The proof that a just-created resource is USABLE, not merely created.
 *
 * Throwing — or returning `false` — means "not ready yet", and the engine
 * retries. Nothing here can tell a transient refusal from a permanent one, and
 * neither could the four hand-rolled loops this replaced: the budget expiring
 * is what turns one into the other.
 */
export type ReadyFn<TConfig, TOutputs> = (
  outputs: TOutputs,
  config: TConfig,
  ctx: ApplyContext,
) => Promise<boolean | void>

/**
 * What a module declares to say "created is not the same as usable here".
 *
 * Every provider in the consumer survey returns success from a create call
 * before the created thing works — a fresh GCP service account 404s its own
 * keys endpoint, a fresh Cloudflare token is refused by the very scope it was
 * granted, a fresh Tailscale device reports no state at all. Four consumers
 * each wrote a retry loop inside their module because there was nowhere
 * reusable to put one.
 *
 * The reusable place is not a retry helper — everyone could write that. It is
 * this declaration plus the engine's rule about it: an instance's outputs do
 * not cross an `imports` edge until the probe succeeds. Which is also why the
 * probe is the MODULE's and not the engine's: leeandco measured
 * `/tokens/verify` answering 200 while the scope-gated call was still refusing
 * half a second later, so a generic liveness check proves the wrong thing.
 * Readiness has to be probed against the capability the caller will use, and
 * only the module knows what that is.
 */
export interface ReadinessDeclaration<TConfig, TOutputs> {
  /**
   * What a passing probe proves, phrased as a claim — e.g. "the minted token
   * can exercise the read permissions it was granted". It is the whole of the
   * timeout error's diagnostic value: the operator needs to know which
   * capability was still being refused, not that "something" timed out.
   */
  proves: string
  probe: ReadyFn<TConfig, TOutputs>
  /** How long to keep probing before failing the apply. Default 60s. */
  timeoutMs?: number
  /** How long to wait between attempts. Default 1s. */
  intervalMs?: number
}

/**
 * The three raw fields a caller has to supply. `defineModule` turns one of
 * these into a full `ApplyContext` before the module body sees it (see
 * `context.ts`), which is why the engine — and a test — may hand `apply` a
 * plain object and the module still gets `secret()` and `output()`.
 */
export interface ApplyContextInput {
  secrets: Record<string, string>
  imports: Record<string, unknown>
  projectRoot: string
}

/** A `{ from, output }` reference into an imported instance's outputs. */
export interface OutputRef {
  from?: string
  output?: string
}

export interface SecretOptions {
  /**
   * What wanted the secret, for the error message — e.g.
   * `flySecrets entry "WALGIT_S3_ACCESS_KEY_ID"`. With an alias the env var
   * name and the secrets.yaml key are different strings, and a message naming
   * only one sends the reader to the wrong file.
   */
  field?: string
  /**
   * Presence is the contract rather than non-emptiness. An intentionally blank
   * placeholder — `KEY:` with no value, or `KEY: ""` — lets a script no-op the
   * step it gates until the real value is filled in.
   */
  allowBlank?: boolean
}

export interface OutputOptions {
  /** Accept an emitted empty string — for outputs where "nothing to do" is a real answer. */
  allowBlank?: boolean
}

/**
 * What a module's `apply`/`destroy` receives.
 *
 * The two methods are the engine's answer to the same two questions every
 * module used to answer itself: "what is this secret" and "what did the
 * instance I imported emit". Six copies of the second and seventeen of the
 * first is how they failed differently for the same cause.
 */
export interface ApplyContext extends ApplyContextInput {
  /**
   * A value from this environment's secrets.yaml. Throws naming the key (and
   * `field`, when given) if the key is absent or blank; `allowBlank` accepts a
   * key that is present but intentionally empty.
   */
  secret(key: string, opts?: SecretOptions): string
  /**
   * An imported instance's output. Throws naming `field` when the ref is
   * incomplete, when the instance is not among this instance's imports, or
   * when it does not emit that output. `allowBlank` accepts an emitted empty
   * string — "nothing to do" is a real answer for some outputs.
   */
  output(ref: OutputRef, field: string, opts?: OutputOptions): string
}

/**
 * The shape `defineModule` publishes: it accepts the raw three fields, because
 * it normalizes them itself. A caller holding a full `ApplyContext` may pass
 * that instead — it is already one of these.
 */
export type BoundApplyFn<TConfig, TOutputs> = (
  config: TConfig,
  ctx: ApplyContextInput,
) => Promise<TOutputs>

export type BoundDestroyFn<TConfig> = (config: TConfig, ctx: ApplyContextInput) => Promise<void>

/**
 * A published `ready`, with the probe bound the way `apply` and `destroy` are.
 *
 * `probe` is declared as a METHOD rather than as a function-typed property, and
 * that is load-bearing rather than stylistic. `TOutputs` reaches every other
 * member of `ModuleDefinition` in an output position — `outputsSchema`,
 * `apply`'s return — which leaves `ModuleDefinition<any, X>` covariant in it, so
 * a `ModuleInstance<ZodObject<{bucketName}>>` is assignable to the
 * `ModuleInstance<z.ZodType>` that `imports` is typed as. `probe` is the first
 * member to take `TOutputs` as a PARAMETER, and under `strictFunctionTypes` one
 * contravariant occurrence makes the whole type invariant — which broke every
 * `imports: [r2Bucket]` in `packages/infra/environments/`, six files that never
 * mention readiness.
 *
 * Method syntax is checked bivariantly, which restores that assignability. The
 * unsoundness it admits is unreachable here: the engine is the only caller of a
 * probe, and it passes exactly the outputs that instance's own `apply` returned,
 * after `outputsSchema.parse` has validated them.
 */
export interface BoundReadiness<TConfig, TOutputs> extends Omit<
  ReadinessDeclaration<TConfig, TOutputs>,
  'probe'
> {
  probe(outputs: TOutputs, config: TConfig, ctx: ApplyContextInput): Promise<boolean | void>
}

export interface ModuleDefinition<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputsSchema: TOutputs
  apply: BoundApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: BoundDestroyFn<z.infer<TConfig>>
  /** See `ReadinessDeclaration`. Absent on every module that has no gap
   * between "created" and "usable" — which is most of them, and they pay
   * nothing for this. */
  ready?: BoundReadiness<z.infer<TConfig>, z.infer<TOutputs>>
  instance: (opts: InstanceOptions<TConfig>) => ModuleInstance<TOutputs>
}

export interface InstanceOptions<TConfig extends z.ZodType> {
  name: string
  config: z.input<TConfig>
  imports?: ModuleInstance[]
  /**
   * Destroy, then apply, on every `zbc apply` — a clean resource each run.
   * Requires the module to define `destroy`; an ephemeral instance of a module
   * without one is refused before anything is applied.
   *
   * A property of the INSTANCE, not of the module's config: whether a preview
   * resource is thrown away each run is the environment's decision, and four
   * modules each restating it in their own schema is how three of them ended up
   * with three different failure policies and the fourth with none at all.
   */
  ephemeral?: boolean
}

export interface ModuleInstance<TOutputs extends z.ZodType = z.ZodType> {
  name: string
  moduleName: string
  config: unknown
  imports: ModuleInstance[]
  /** See `InstanceOptions.ephemeral`. Always set — the engine reads it directly. */
  ephemeral: boolean
  _outputsSchema: TOutputs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _definition: ModuleDefinition<any, TOutputs>
}
