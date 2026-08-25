import { describe, expect, test } from 'bun:test'
import { machinesConverged } from './index'

/**
 * The four sentences flyctl uses to say "the machines are up".
 *
 * The guard this covers knew three of them. The fourth — the rolling-update
 * line — is what every deploy after an app's first one prints, so the guard
 * was green exactly until walgit was deployed a second time, then red on a
 * deploy that had converged. The transcripts below are copied from real
 * flyctl output rather than paraphrased, because a paraphrase would have
 * passed the old regex too.
 */
describe('machinesConverged', () => {
  test('accepts a rolling update of an existing machine', () => {
    // Verbatim from Production run 32881480843 (zbc-walgit, 2026-08-25).
    expect(
      machinesConverged(`Updating existing machines in 'zbc-walgit' with rolling strategy
> Acquiring lease for 28792d7b453948
> Updating machine config for 28792d7b453948
> Waiting for machine 28792d7b453948 to reach a good state
> Machine 28792d7b453948 reached stopped state
✔ Machine 28792d7b453948 is now in a good state
> Clearing lease for 28792d7b453948`),
    ).toBe(true)
  })

  test('accepts the three first-launch confirmations it already knew', () => {
    expect(machinesConverged('Finished launching new machines')).toBe(true)
    expect(machinesConverged('update finished: success')).toBe(true)
    expect(machinesConverged('No machines in group app')).toBe(true)
  })

  test('rejects a build that never mentions a machine', () => {
    // flyctl exits 0 here. This is the whole reason the guard exists.
    expect(
      machinesConverged(`==> Verifying app config
--> Verified app config
==> Building image with Depot
#15 [11/11] RUN chmod +x /entrypoint.sh
Visit your newly deployed app at https://zbc-walgit.fly.dev/`),
    ).toBe(false)
  })

  test('a stopped machine alone is not convergence', () => {
    // Printed both by an auto-stopped machine on its way to a good state and
    // by one that stopped because it died. Only the good-state line settles it.
    expect(machinesConverged('> Machine 28792d7b453948 reached stopped state')).toBe(false)
  })
})
