import { afterEach, describe, expect, test } from 'bun:test'
import { cf, describeCfErrors, resolveApiToken, resolveRef } from './index'

/**
 * What Cloudflare said, when Cloudflare did not say it in the documented shape.
 *
 * This library exists so the envelope is unwrapped once. It was unwrapped once
 * and WRONGLY: `errors?.map((e) => e.message)` reads the documented field and
 * nothing else, and the Access endpoints answer in a different shape entirely.
 * Measured on 2026-08-15 against a live account:
 *
 *     POST /accounts/{id}/access/apps
 *       -> 403 {"result":null,"success":false,
 *               "errors":[{"code":1010,"error":"auth.forbidden"}]}
 *
 * There is no `message` in that. The map produced `[undefined]`, the join
 * produced the empty string, `||` fell through, and the caller was told a bare
 * `HTTP 403`. The one fact in the response was the one field never read, and
 * recovering `1010 auth.forbidden` took three throwaway diagnostic scripts. It
 * was also the whole answer: a token minted with zone-scoped grants.
 *
 * Fixed here rather than in the module that hit it, because every Cloudflare
 * module calls through this file and a per-module copy is the duplication this
 * file was extracted to end.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('describeCfErrors', () => {
  test('the measured Access response: code and error, both surfaced', () => {
    expect(describeCfErrors([{ code: 1010, error: 'auth.forbidden' }], 403)).toBe(
      '1010: auth.forbidden',
    )
  })

  test('the documented shape still reads the way it always did', () => {
    expect(describeCfErrors([{ message: 'quota exceeded' }], 400)).toBe('quota exceeded')
    expect(describeCfErrors([{ code: 10000, message: 'Authentication error' }], 401)).toBe(
      '10000: Authentication error',
    )
  })

  test('a shape nobody anticipated is printed rather than dropped', () => {
    expect(describeCfErrors([{ code: 7003, reason: 'no route' }], 404)).toBe(
      '7003: {"reason":"no route"}',
    )
  })

  test('several errors are joined, not reduced to the first', () => {
    expect(
      describeCfErrors([{ code: 1010, error: 'auth.forbidden' }, { message: 'and also' }], 403),
    ).toBe('1010: auth.forbidden; and also')
  })

  test('the status is the last resort, not the first', () => {
    expect(describeCfErrors([], 502)).toBe('HTTP 502')
    expect(describeCfErrors([{}], 502)).toBe('HTTP 502')
    expect(describeCfErrors(undefined, 502)).toBe('HTTP 502')
    expect(describeCfErrors('not an array', 502)).toBe('HTTP 502')
  })
})

describe('cf() carries what the API said, all the way to the caller', () => {
  test('the undocumented shape reaches the thrown message', async () => {
    // Exporting a correct reader and not calling it would leave every caller
    // exactly as mute as before, so this drives the real `cf`.
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          result: null,
          success: false,
          errors: [{ code: 1010, error: 'auth.forbidden' }],
        }),
        { status: 403 },
      )) as typeof fetch

    let error: Error | undefined
    try {
      await cf('tok', 'POST', '/accounts/a/access/apps', {})
    } catch (e) {
      error = e as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toContain('1010')
    expect(error!.message).toContain('auth.forbidden')
    // What it used to say, and all it used to say.
    expect(error!.message).not.toBe('Cloudflare API POST /accounts/a/access/apps failed: HTTP 403')
  })

  test('a success envelope is unwrapped to its result', async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, errors: [], result: { id: 'x' } }), {
        status: 200,
      })) as typeof fetch
    expect(await cf<{ id: string }>('tok', 'GET', '/whatever')).toEqual({ id: 'x' })
  })
})

describe('resolveApiToken fails by name, not with `Bearer undefined`', () => {
  test('an instance that is not imported', () => {
    expect(() => resolveApiToken({ from: 'tok', output: 'tokenValue' }, {})).toThrow(/not in this/)
  })

  test('an output the instance does not emit', () => {
    expect(() => resolveApiToken({ from: 'tok', output: 'tokenValue' }, { tok: {} })).toThrow(
      /doesn't emit it/,
    )
  })

  test('the happy path', () => {
    expect(
      resolveApiToken({ from: 'tok', output: 'tokenValue' }, { tok: { tokenValue: 'v' } }),
    ).toBe('v')
  })

  test('resolveRef names the FIELD, so a module with several references says which', () => {
    // `apiToken` is no longer the only `{from, output}` a Cloudflare module
    // takes — cloudflare-access resolves a list of service tokens the same way.
    // A failure that says "apiToken" for the third service token sends the
    // reader to the wrong line of the instance.
    expect(() => resolveRef({ from: 'x', output: 'y' }, {}, 'serviceTokens[2]')).toThrow(
      /serviceTokens\[2\] references instance "x"/,
    )
    expect(() => resolveRef({ from: 'x', output: 'y' }, { x: {} }, 'serviceTokens[2]')).toThrow(
      /serviceTokens\[2\] references output "y"/,
    )
  })

  test('a reference missing half of itself is refused by name', () => {
    expect(() => resolveRef({ from: 'x' }, { x: { y: 'v' } }, 'serviceTokens[0]')).toThrow(
      /must name both/,
    )
  })
})
