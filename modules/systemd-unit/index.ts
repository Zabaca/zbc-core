import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { defineModule } from '../../src/define-module'

const sh = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()

// Manages a systemd unit (service or timer). scope=user writes to
// ~/.config/systemd/user (survives reboots via `loginctl enable-linger`,
// which apply ensures); scope=system writes to /etc/systemd/system via sudo
// (this host grants passwordless sudo). Converges: writes unit only on
// change, daemon-reloads, enables --now, and restarts when content changed.
export const systemdUnitModule = defineModule({
  name: 'systemd-unit',
  configSchema: z.object({
    unit: z.string(), // e.g. "foundry-transcribe.service"
    content: z.string(),
    scope: z.enum(['user', 'system']).default('user'),
    enableNow: z.boolean().default(true),
  }),
  outputs: z.object({ unit: z.string(), changed: z.boolean(), active: z.boolean() }),
  apply: async (config) => {
    const user = config.scope === 'user'
    const ctl = user ? 'systemctl --user' : 'sudo systemctl'
    const dir = user
      ? path.join(os.homedir(), '.config/systemd/user')
      : '/etc/systemd/system'
    const unitPath = path.join(dir, config.unit)

    const existing = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf8') : null
    const changed = existing !== config.content
    if (changed) {
      if (user) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(unitPath, config.content)
      } else {
        execSync(`sudo tee ${unitPath} > /dev/null`, { input: config.content })
      }
      sh(`${ctl} daemon-reload`)
    }
    if (user) sh(`loginctl enable-linger ${os.userInfo().username} || true`)
    if (config.enableNow) {
      sh(`${ctl} enable ${config.unit} 2>&1 || true`)
      if (changed) sh(`${ctl} restart ${config.unit}`)
      else sh(`${ctl} start ${config.unit}`)
    }
    const active = sh(`${ctl} is-active ${config.unit} || true`).trim() === 'active'
    console.log(`  ${config.unit} ${changed ? 'updated' : 'unchanged'}, active=${active}`)
    return { unit: config.unit, changed, active }
  },
})
