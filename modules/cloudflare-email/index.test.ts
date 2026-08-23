import { describe, expect, test } from 'bun:test'
import { classifySendingDns, readSendingDnsRecord } from './index'

// Cloudflare's Email Sending API is beta and the module reads its record
// objects defensively, which is right. What was wrong is where the defensive
// value went: `String(r.status ?? r.state ?? 'unknown')` produced the literal
// 'unknown' when NEITHER field was present, and that string was then compared
// against active|verified|locked and reported as `Sending DNS pending`.
//
// So "I could not find the field" was printed as a claim about the customer's
// DNS. On cedarpad.com it fired on all four records — MX, SPF, DKIM, DMARC —
// every apply, while every one of them resolved correctly and `_dmarc` was
// `p=reject`, under which unaligned mail is refused rather than delivered. The
// passwordless login emails arriving were proof the records were fine.
//
// Absence and failure are different answers and only one of them is about DNS.

const rec = (over: Record<string, unknown> = {}) => ({
  type: 'TXT',
  name: '_dmarc.example.com',
  ...over,
})

describe('readSendingDnsRecord', () => {
  test('reads the status Cloudflare reported', () => {
    expect(readSendingDnsRecord(rec({ status: 'active' }), 'example.com').status).toBe('active')
  })

  test('accepts `state` as well, since the beta API has used both', () => {
    expect(readSendingDnsRecord(rec({ state: 'pending' }), 'example.com').status).toBe('pending')
  })

  // The defect, at its source: no status field must read as "not reported",
  // never as a status string that downstream comparisons can fail.
  test('reports null — not "unknown" — when the API carried no status', () => {
    expect(readSendingDnsRecord(rec(), 'example.com').status).toBeNull()
  })

  test('labels the record by type and name, as the warning prints it', () => {
    expect(readSendingDnsRecord(rec({ type: 'MX', name: 'cf-bounce.example.com' }), 'x').key).toBe(
      'MX cf-bounce.example.com',
    )
  })

  test('falls back on the label only, where a wrong guess costs nothing', () => {
    const r = readSendingDnsRecord({}, 'example.com')
    expect(r.key).toBe('record example.com')
    expect(r.status).toBeNull()
  })
})

describe('classifySendingDns', () => {
  const read = (rs: Array<Record<string, unknown>>) =>
    classifySendingDns(rs.map((r) => readSendingDnsRecord(r, 'example.com')))

  test.each(['active', 'verified', 'locked'])('%s is live: neither pending nor unreported', (s) => {
    const v = read([rec({ status: s })])
    expect(v.pending).toEqual([])
    expect(v.unreported).toEqual([])
  })

  test('a reported status outside that set is pending — the real warning survives', () => {
    const v = read([rec({ status: 'initializing' })])
    expect(v.pending.map((p) => p.status)).toEqual(['initializing'])
    expect(v.unreported).toEqual([])
  })

  // The whole point. Four records with no status is not four broken records.
  test('records with no reported status are unreported, never pending', () => {
    const v = read([rec({ type: 'MX' }), rec({ type: 'TXT' })])
    expect(v.pending).toEqual([])
    expect(v.unreported).toHaveLength(2)
  })

  test('a mixed answer separates the two rather than merging them', () => {
    const v = read([rec({ status: 'active' }), rec({ status: 'initializing' }), rec()])
    expect(v.pending).toHaveLength(1)
    expect(v.unreported).toHaveLength(1)
  })

  test('no records at all is not a problem to report', () => {
    const v = classifySendingDns([])
    expect(v.pending).toEqual([])
    expect(v.unreported).toEqual([])
  })
})
