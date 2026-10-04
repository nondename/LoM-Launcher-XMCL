import chalk from 'chalk'
import { createHash } from 'crypto'
import { build as electronBuilder } from 'electron-builder'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import path, { join } from 'path'
import { pipeline } from 'stream'
import { promisify } from 'util'
import { config as electronBuilderConfig } from './build/electron-builder.config'

async function writeHash(algorithm: string, filePath: string) {
  const hash = createHash(algorithm).setEncoding('hex')
  await promisify(pipeline)(createReadStream(filePath), hash, createWriteStream(filePath + '.sha256'))
}

/**
 * Build the Windows NSIS installer out of an already packed `win-unpacked`
 * directory.
 *
 * The release pipeline runs the regular `build.ts` in dir mode first (it also
 * emits the asar payload the in-app updater consumes), so re-packing the app
 * here would duplicate that work. `prepackaged` makes electron-builder skip
 * `beforeBuild`/`doPack`/`afterPack` entirely and go straight to the NSIS
 * target, which keeps the installer step fast and independent.
 */
async function start() {
  const prepackaged = path.resolve(__dirname, 'build/output/win-unpacked')
  if (!existsSync(join(prepackaged, 'LoM Launcher.exe'))) {
    throw new Error(
      `No packed Windows app found at ${prepackaged}. Run \`pnpm run build\` (dir mode) first.`,
    )
  }

  console.log(chalk.bold.underline('Build Windows installer (NSIS)'))
  const startTime = Date.now()

  // `x64: true` pins the arch; without it electron-builder falls back to the
  // `win.target` list in the config and would also build zip/appx.
  const files = await electronBuilder({
    publish: 'never',
    projectDir: __dirname,
    prepackaged,
    win: ['nsis'],
    x64: true,
    config: electronBuilderConfig,
  } as Parameters<typeof electronBuilder>[0])

  for (const file of files) {
    const fstat = await stat(file)
    console.log(
      `${chalk.gray('[write]')} ${chalk.yellow(file)} ${(
        fstat.size /
        1024 /
        1024
      ).toFixed(2)}mb`,
    )
    // Same `<artifact>.sha256` convention as build.ts so the release workflow
    // can ship a checksum alongside the installer.
    await writeHash('sha256', file)
  }

  console.log(`Build completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s.`)
  process.exit(0)
}

start().catch((e) => {
  console.error(chalk.red(e.toString()))
  process.exit(1)
})
