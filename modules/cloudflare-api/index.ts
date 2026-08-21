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
 * Cloudflare answers every call with this envelope, including failures — the
 * HTTP status is frequently 200 on an error, so `success` is the only field
 * that says whether anything happened.
 */
export interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ message: string }>
  result: T
  result_info?: { page: number; total_pages: number }
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
    const messages = payload.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new Error(`Cloudflare API ${method} ${path} failed: ${messages}`)
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
  const outputs = imports[ref.from]
  if (outputs === undefined) {
    throw new Error(
      `apiToken references instance "${ref.from}", which is not in this instance's imports`,
    )
  }
  const value = (outputs as Record<string, unknown> | null)?.[ref.output]
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `apiToken references output "${ref.output}" on instance "${ref.from}", which doesn't emit it`,
    )
  }
  return value
}
