import type { z } from 'zod'

export type ApplyFn<TConfig, TOutputs> = (config: TConfig, ctx: ApplyContext) => Promise<TOutputs>

export type DestroyFn<TConfig> = (config: TConfig, ctx: ApplyContext) => Promise<void>

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

export interface ModuleDefinition<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputsSchema: TOutputs
  apply: BoundApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: BoundDestroyFn<z.infer<TConfig>>
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
