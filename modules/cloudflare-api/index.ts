// The parts of "talk to the Cloudflare API" that no module should own twice:
// the base URL, the envelope Cloudflare wraps every response in, and the rule
// for reading a credential out of an imported instance's outputs.
//
// Extracted the way `provision-core` was extracted, and for the same reason its
// header gives. `cloudflare-zone` wrote these first; `cloudflare-tunnel` needed
// the identical four, and the duplication was caught on the apply
// that introduced it — which is the whole point of that test, since the
// previous convention was a comment asking a human to notice, and by the time
// anybody counted the Cloudflare resolver was at four copies.
//
// The base URL is the load-bearing one. `https://api.cloudflare.com/client/v4`
// is a version pin, not a protocol constant: the day it moves, it moves once.

export const API = 'https://api.cloudflare.com/client/v4'

/**
 * One entry of the envelope's `errors` array.
 *
 * EVERY FIELD IS OPTIONAL, and that is the point. Cloudflare does not send one
 * shape: the documented one is `{code, message}`, and the Access endpoints
 * answer `{code, error}`. Typing this as `{message: string}` — which it was
 * until 2026-08-23 — is a claim about the API that the API does not honour, and
 * it reads as true because the field is simply absent rather than wrong.
 */
export interface CfApiError {
  code?: number | string
  message?: string
  error?: string
  [field: string]: unknown
}

/**
 * Cloudflare answers every call with this envelope, including failures — the
 * HTTP status is frequently 200 on an error, so `success` is the only field
 * that says whether anything happened.
 */
export interface CfEnvelope<T> {
  success: boolean
  errors: CfApiError[]
  result: T
  result_info?: { page: number; total_pages: number }
}

/** A field that is a non-empty string once trimmed, or nothing. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** One error entry as text, using whatever fields it actually carries. */
function describeCfError(entry: unknown): string {
  if (entry === null || entry === undefined) return ''
  if (typeof entry !== 'object') return String(entry)
  const fields = entry as CfApiError
  const code =
    typeof fields.code === 'number' || typeof fields.code === 'string'
      ? String(fields.code)
      : undefined
  const text = nonEmpty(fields.message) ?? nonEmpty(fields.error) ?? nonEmpty(fields.detail)
  if (text !== undefined) return code === undefined ? text : `${code}: ${text}`
  if (code !== undefined) {
    const { code: _code, ...rest } = fields
    const extra = JSON.stringify(rest)
    return extra === '{}' ? code : `${code}: ${extra}`
  }
  const all = JSON.stringify(fields)
  return all === '{}' ? '' : all
}

/**
 * Everything Cloudflare said about a failure, whichever shape it said it in.
 *
 * ⚠️ THE ACCESS ENDPOINTS ARE THE ONES THAT ANSWER IN THE UNDOCUMENTED SHAPE.
 * On 2026-08-15 `POST /accounts/{id}/access/apps` returned
 * `[{"code":1010,"error":"auth.forbidden"}]`. The line here read `e.message`
 * only, so it mapped to `[undefined]`, joined to the empty string, fell through
 * `||` to a bare `HTTP 403`, and the one fact in the response was thrown away.
 * Recovering `1010 auth.forbidden` took three throwaway diagnostic scripts, and
 * it was the whole answer: a token minted with zone-scoped grants.
 *
 * Pure; exported for tests, and exported because a module that has to describe
 * a failure Cloudflare reported outside `cf` — a batch call, a probe — must not
 * grow its own copy. That copying is what this file was extracted to end.
 */
export function describeCfErrors(errors: unknown, status: number): string {
  const entries = Array.isArray(errors) ? errors : []
  const parts = entries.map(describeCfError).filter((part) => part !== '')
  return parts.length > 0 ? parts.join('; ') : `HTTP ${status}`
}

/**
 * Call the API and return the WHOLE envelope; throw the API's own message on
 * failure. Callers that paginate need `result_info`, which is why this exists
 * alongside `cf` rather than under it.
 */
export async function cfRaw<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfEnvelope<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = (await res.json()) as CfEnvelope<T>
  if (!payload.success) {
    throw new Error(
      `Cloudflare API ${method} ${path} failed: ${describeCfErrors(payload.errors, res.status)}`,
    )
  }
  return payload
}

/** The common case: the envelope's `result`, or a throw. */
export async function cf<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await cfRaw<T>(token, method, path, body)).result
}

/**
 * Resolve a `{ from, output }` credential reference against an instance's
 * imports, failing fast and by name.
 *
 * Every Cloudflare module takes its token this way rather than from
 * secrets.yaml, because `cloudflare-token` rolls minted values on every apply
 * and persists none of them — a copy at rest is a copy that is already stale.
 * The two error messages matter more than the happy path: a missing import and
 * a missing output are both silently `undefined` otherwise, and an apply that
 * carries `Bearer undefined` fails much later, at a Cloudflare 403 that reads
 * like a permissions problem.
 */
export function resolveApiToken(
  ref: { from: string; output: string },
  imports: Record<string, unknown>,
): string {
  return resolveRef(ref, imports, 'apiToken')
}

/**
 * The same resolution, for a reference that is NOT the API token.
 *
 * `apiToken` was the only `{from, output}` a Cloudflare module took until
 * `cloudflare-access` grew a list of service-token references. The field name
 * is a parameter because the error message is the whole value of this function:
 * one that says `apiToken` for the third entry of `serviceTokens` sends the
 * reader to the wrong line of an instance file.
 *
 * The parameter is typed loosely on purpose. A zod-inferred config marks both
 * halves optional in some spellings, and the checks have to run at runtime
 * regardless — a `from` naming an instance that is not imported is a real
 * failure mode and nothing in the type system is catching it here.
 */
export function resolveRef(
  ref: { from?: string; output?: string },
  imports: Record<string, unknown>,
  field: string,
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
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `${field} references output "${ref.output}" on instance "${ref.from}", which doesn't emit it`,
    )
  }
  return value
}
