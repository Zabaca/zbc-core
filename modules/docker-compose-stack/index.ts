import { z } from 'zod'
import { execSync } from 'node:child_process'
import { defineModule } from '../../src/define-module'

// Converges a docker compose project: `docker compose up -d` in the given
// directory (idempotent — compose only recreates changed containers).
// Import a host-file instance for the stack's .env to sequence secret
// materialization before up.
export const dockerComposeStackModule = defineModule({
  name: 'docker-compose-stack',
  configSchema: z.object({
    dir: z.string(),
    services: z.array(z.string()).default([]), // empty = whole stack
  }),
  outputs: z.object({ dir: z.string(), running: z.number() }),
  apply: async (config) => {
    const svc = config.services.join(' ')
    execSync(`docker compose up -d ${svc}`, { cwd: config.dir, stdio: 'inherit' })
    const out = execSync('docker compose ps --status running --quiet', {
      cwd: config.dir,
    })
      .toString()
      .trim()
    const running = out ? out.split('\n').length : 0
    console.log(`  ${config.dir}: ${running} containers running`)
    return { dir: config.dir, running }
  },
})
