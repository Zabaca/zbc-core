import { describe, expect, test } from 'bun:test'
import { createApplyContext, ensureApplyContext, resolveOutput, resolveSecret } from './context'
import { defineModule } from './define-module'
import type { ApplyContext } from './types'
import { z } from 'zod'

/**
 * The pure half of the context: two rules over two literal records.
 *
 * These used to be seventeen copies (`ctx.secrets['X']` + a throw) and six
 * (`ctx.imports[from]?.[output]` + two throws), which is how they came to
 * disagree about what "absent" means — `!value` calls an empty string missing,
 * `=== undefined` does not, and both spellings shipped.
 */
describe('secret', () => {
  const secrets = { TOKEN: 'v', BLANK: '' }

  test('returns the value', () => {
    expect(resolveSecret(secrets, 'TOKEN')).toBe('v')
  })

  test('an absent key names the key and the file', () => {
    expect(() => resolveSecret(secrets, 'NOPE')).toThrow(/"NOPE".*secrets\.yaml/)
  })

  test('`field` names what wanted it — with an alias the two spellings differ', () => {
    expect(() =>
      resolveSecret(secrets, 'NOPE', { field: 'flySecrets entry "WALGIT_S3_ACCESS_KEY_ID"' }),
    ).toThrow(/WALGIT_S3_ACCESS_KEY_ID.*NOPE/)
  })

  test('a blank value is missing by default, and present with allowBlank', () => {
    expect(() => resolveSecret(secrets, 'BLANK')).toThrow(/empty/)
    expect(resolveSecret(secrets, 'BLANK', { allowBlank: true })).toBe('')
  })

  test('allowBlank still refuses a key that is not there at all', () => {
    expect(() => resolveSecret(secrets, 'NOPE', { allowBlank: true })).toThrow(/missing/)
  })
})

describe('output', () => {
  const imports = { db: { url: 'libsql://x', empty: '' }, tok: {} }

  test('returns the imported instance output', () => {
    expect(resolveOutput({ from: 'db', output: 'url' }, imports, 'workerVars')).toBe('libsql://x')
  })

  test('the three failures are told apart, and every message names the field', () => {
    expect(() => resolveOutput({ from: 'db' }, imports, 'serviceTokens[0]')).toThrow(
      /serviceTokens\[0\] must name both an instance \(`from`\) and an output \(`output`\)/,
    )
    expect(() => resolveOutput({ from: 'ghost', output: 'url' }, imports, 'apiToken')).toThrow(
      /apiToken references instance "ghost", which is not in this instance's imports/,
    )
    expect(() => resolveOutput({ from: 'tok', output: 'tokenValue' }, imports, 'apiToken')).toThrow(
      /apiToken references output "tokenValue" on instance "tok", which doesn't emit it/,
    )
  })

  test('a blank output is absent by default, and a real answer with allowBlank', () => {
    expect(() => resolveOutput({ from: 'db', output: 'empty' }, imports, 'f')).toThrow(
      /doesn't emit it/,
    )
    expect(resolveOutput({ from: 'db', output: 'empty' }, imports, 'f', { allowBlank: true })).toBe(
      '',
    )
  })

  test('a non-string output is not coerced', () => {
    expect(() => resolveOutput({ from: 'n', output: 'count' }, { n: { count: 3 } }, 'f')).toThrow(
      /doesn't emit it/,
    )
  })
})

describe('createApplyContext', () => {
  test('keeps the three raw fields alongside the two rules', () => {
    const ctx = createApplyContext({
      secrets: { A: '1' },
      imports: { db: { url: 'u' } },
      projectRoot: '/root',
    })
    expect(ctx.secrets).toEqual({ A: '1' })
    expect(ctx.imports).toEqual({ db: { url: 'u' } })
    expect(ctx.projectRoot).toBe('/root')
    expect(ctx.secret('A')).toBe('1')
    expect(ctx.output({ from: 'db', output: 'url' }, 'f')).toBe('u')
  })

  test('reads the live records, so an engine that fills imports later is seen', () => {
    const imports: Record<string, unknown> = {}
    const ctx = createApplyContext({ secrets: {}, imports, projectRoot: '/' })
    expect(() => ctx.output({ from: 'db', output: 'url' }, 'f')).toThrow(/not in this instance/)
    imports.db = { url: 'u' }
    expect(ctx.output({ from: 'db', output: 'url' }, 'f')).toBe('u')
  })
})

describe('ensureApplyContext', () => {
  test('upgrades the three raw fields', () => {
    const ctx = ensureApplyContext({ secrets: { A: '1' }, imports: {}, projectRoot: '/' })
    expect(ctx.secret('A')).toBe('1')
  })

  test('leaves a context that already has the rules alone', () => {
    // The destroy path's context resolves imports on demand; rebuilding it
    // here would throw that away and reinstate the old `imports: {}`.
    const original = createApplyContext({ secrets: {}, imports: {}, projectRoot: '/' })
    expect(ensureApplyContext(original)).toBe(original)
  })
})

/**
 * The normalization is what lets the engine — and a module's own test — hand
 * `apply` the three raw fields and have the body still find the two rules.
 * Asserted through `defineModule` rather than through `ensureApplyContext`,
 * because it is `defineModule` doing it that every module in core relies on.
 */
describe('defineModule normalizes whatever context it is handed', () => {
  const probe = (spy: (ctx: ApplyContext) => void) =>
    defineModule({
      name: 'probe',
      configSchema: z.object({ group: z.string().default('default') }),
      outputs: z.object({}),
      apply: async (_config, ctx) => {
        spy(ctx)
        return {}
      },
      destroy: async (_config, ctx) => spy(ctx),
    })

  test('apply gets the rules from three raw fields', async () => {
    let seen: ApplyContext | undefined
    const mod = probe((ctx) => {
      seen = ctx
    })
    await mod.apply({ group: 'g' }, { secrets: { A: '1' }, imports: {}, projectRoot: '/' })
    expect(seen?.secret('A')).toBe('1')
    expect(seen?.projectRoot).toBe('/')
  })

  test('destroy gets them too', async () => {
    let seen: ApplyContext | undefined
    const mod = probe((ctx) => {
      seen = ctx
    })
    await mod.destroy!({ group: 'g' }, { secrets: { A: '1' }, imports: {}, projectRoot: '/' })
    expect(seen?.secret('A')).toBe('1')
  })

  test('a context that already has the rules is passed through, not rebuilt', async () => {
    // The engine's destroy context resolves imports on demand. Rebuilding it
    // would silently reinstate the old `imports: {}` behaviour.
    const lazy: ApplyContext = {
      ...createApplyContext({ secrets: {}, imports: {}, projectRoot: '/' }),
      output: () => 'from-the-lazy-one',
    }
    let seen: ApplyContext | undefined
    const mod = probe((ctx) => {
      seen = ctx
    })
    await mod.apply({ group: 'g' }, lazy)
    expect(seen).toBe(lazy)
    expect(seen?.output({ from: 'x', output: 'y' }, 'f')).toBe('from-the-lazy-one')
  })

  test('a module with no destroy still has none', () => {
    const mod = defineModule({
      name: 'no-destroy',
      configSchema: z.object({}),
      outputs: z.object({}),
      apply: async () => ({}),
    })
    expect(mod.destroy).toBeUndefined()
  })
})

describe('secret over a YAML-shaped record', () => {
  test('`KEY:` with no value reads as blank, not as absent', () => {
    // yaml parses a bare key to null. It is the most natural spelling of the
    // placeholder `allowBlank` exists for, and it must not reach a module as
    // `null` under a `string` type either way.
    const secrets = { KEY: null } as unknown as Record<string, string>
    expect(resolveSecret(secrets, 'KEY', { allowBlank: true })).toBe('')
    expect(() => resolveSecret(secrets, 'KEY')).toThrow(/is empty/)
  })
})
