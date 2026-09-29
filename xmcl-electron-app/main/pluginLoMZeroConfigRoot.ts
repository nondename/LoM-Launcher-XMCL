import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Skip XMCL's root-directory chooser on a brand-new LoM Launcher profile.
 *
 * The core bootstrap only opens the chooser when <appDataPath>/root is absent.
 * Pre-seeding that file with XMCL's own default root keeps the normal core
 * startup path intact while making the LoM first launch zero-config.
 * Existing installations are never changed.
 */
export function pluginLoMZeroConfigRoot(app: { appDataPath: string }) {
  const rootFile = join(app.appDataPath, 'root')
  if (existsSync(rootFile)) return

  mkdirSync(app.appDataPath, { recursive: true })
  writeFileSync(rootFile, app.appDataPath, { flag: 'wx' })
}
