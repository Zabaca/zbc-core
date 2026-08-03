import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineModule } from '../../src/define-module'

// Writes a file on this host, converging on content + mode. Content comes
// either inline (`content`) or from a SOPS secret (`secretKey` — the value in
// environments/<env>/secrets.yaml). Idempotent: only rewrites when the
// on-disk bytes differ, so downstream instances can key restarts off
// `outputs.changed`.
export const hostFileModule = defineModule({
  name: 'host-file',
  configSchema: z
    .object({
      path: z.string(),
      content: z.string().optional(),
      secretKey: z.string().optional(),
      mode: z.string().default('0644'),
    })
    .refine((c) => (c.content === undefined) !== (c.secretKey === undefined), {
      message: 'exactly one of content or secretKey is required',
    }),
  outputs: z.object({ path: z.string(), changed: z.boolean() }),
  apply: async (config, ctx) => {
    const desired =
      config.content !== undefined ? config.content : ctx.secrets[config.secretKey!]
    if (desired === undefined) {
      throw new Error(`secret "${config.secretKey}" not found in secrets.yaml`)
    }
    const existing = fs.existsSync(config.path)
      ? fs.readFileSync(config.path, 'utf8')
      : null
    const changed = existing !== desired
    if (changed) {
      fs.mkdirSync(path.dirname(config.path), { recursive: true })
      fs.writeFileSync(config.path, desired)
    }
    fs.chmodSync(config.path, parseInt(config.mode, 8))
    console.log(`  ${config.path} ${changed ? 'written' : 'unchanged'}`)
    return { path: config.path, changed }
  },
})
