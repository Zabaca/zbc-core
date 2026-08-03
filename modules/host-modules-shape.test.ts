import { describe, expect, test } from 'bun:test'
import { systemdUnitModule } from './systemd-unit/index'
import { hostFileModule } from './host-file/index'
import { dockerComposeStackModule } from './docker-compose-stack/index'

/**
 * Shape guard for the host-converging modules (contributed from foundry,
 * 2026-08-03): they import '../../src/define-module', so this test breaks if
 * the core split layout ever moves the engine out from under them — and it
 * pins each module's converge identity (name + minimal valid config).
 */

describe('host-converging modules parse in the core layout', () => {
  test('systemd-unit', () => {
    expect(systemdUnitModule.name).toBe('systemd-unit')
    const parsed = systemdUnitModule.configSchema.parse({
      unit: 'x.service',
      content: '[Unit]\n',
    })
    expect(parsed.scope).toBe('user')
    expect(parsed.enableNow).toBe(true)
  })

  test('host-file requires exactly one content source', () => {
    expect(hostFileModule.name).toBe('host-file')
    expect(hostFileModule.configSchema.parse({ path: '/tmp/x', content: 'hi' }).mode).toBe('0644')
    expect(() => hostFileModule.configSchema.parse({ path: '/tmp/x' })).toThrow()
    expect(() =>
      hostFileModule.configSchema.parse({ path: '/tmp/x', content: 'a', secretKey: 'B' }),
    ).toThrow()
  })

  test('docker-compose-stack', () => {
    expect(dockerComposeStackModule.name).toBe('docker-compose-stack')
    expect(dockerComposeStackModule.configSchema.parse({ dir: '/srv/app' }).services).toEqual([])
  })
})
