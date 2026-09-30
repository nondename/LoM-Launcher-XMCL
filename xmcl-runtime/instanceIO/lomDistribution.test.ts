import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { normalizeLoMManifest } from './lomDistribution'
import { validateLoMFileBytes } from './lomFileIntegrity'

const SOURCE = 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/distribution.json'

describe('LoM distribution adapter', () => {
  it('extracts pack files recursively and ignores Forge repository libraries', () => {
    const manifest = normalizeLoMManifest({
      version: '1.0.0',
      servers: [{
        id: 'Legends_of_Medieval-1.20.1',
        name: 'Legends of Medieval',
        version: '0.2.0-dev',
        minecraftVersion: '1.20.1',
        modules: [{
          type: 'ForgeHosted',
          artifact: {
            url: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/repo/net/minecraftforge/forge.jar',
            MD5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          subModules: [{
            type: 'ForgeMod',
            artifact: {
              size: 1234,
              url: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/mods/%5Bforge%5Dexample.jar',
              MD5: '0123456789abcdef0123456789abcdef',
            },
          }, {
            type: 'File',
            artifact: {
              size: 456,
              url: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/resourcepacks/%5B1.6%5D%20Enhanced.zip',
              path: 'resourcepacks/%5B1.6%5D%20Enhanced.zip',
              MD5: 'fedcba9876543210fedcba9876543210',
            },
          }, {
            type: 'Library',
            artifact: {
              url: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/repo/com/example/library.jar',
              MD5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          }],
        }],
      }],
    }, SOURCE)

    expect(manifest.version).toBe('0.2.0-dev')
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'mods/[forge]example.jar',
        hashAlgorithm: 'md5',
        hash: '0123456789abcdef0123456789abcdef',
        size: 1234,
      }),
      expect.objectContaining({
        path: 'resourcepacks/[1.6] Enhanced.zip',
        hashAlgorithm: 'md5',
        hash: 'fedcba9876543210fedcba9876543210',
        size: 456,
      }),
      expect.objectContaining({
        path: 'options.txt',
        url: 'https://raw.githubusercontent.com/nondename/Minecraft-Legends-of-Medieval/dev/options.txt',
      }),
    ]))
    expect(manifest.files.some((file) => file.path.startsWith('repo/'))).toBe(false)
    expect(manifest.delete).toContain('config/lom-updater-test.txt')
  })

  it('keeps compatibility with the old sha1 updater manifest format', () => {
    const manifest = normalizeLoMManifest({
      version: '2',
      files: [{
        path: 'config/test.txt',
        sha1: '0123456789abcdef0123456789abcdef01234567',
        url: 'config/test.txt',
        size: 4,
      }],
    }, SOURCE)

    expect(manifest).toEqual({
      version: '2',
      files: [{
        path: 'config/test.txt',
        url: 'config/test.txt',
        size: 4,
        hash: '0123456789abcdef0123456789abcdef01234567',
        hashAlgorithm: 'sha1',
      }],
      delete: undefined,
    })
  })

  it('accepts an LF Git text blob when the manifest describes equivalent CRLF bytes', () => {
    const lf = Buffer.from('first=true\nsecond=false\nthird=true\n', 'utf8')
    const crlf = Buffer.from('first=true\r\nsecond=false\r\nthird=true\r\n', 'utf8')
    const hash = createHash('md5').update(crlf).digest('hex')

    expect(validateLoMFileBytes(lf, {
      path: 'config/example-common.toml',
      size: crlf.length,
      hash,
      hashAlgorithm: 'md5',
    })).toMatchObject({
      valid: true,
      eolCompatible: true,
      actualSize: lf.length,
    })
  })

  it('accepts a Git text blob when the manifest checkout only differs by the final newline', () => {
    const raw = Buffer.from('first=true\nsecond=false', 'utf8')
    const checkout = Buffer.from('first=true\nsecond=false\n', 'utf8')
    const hash = createHash('md5').update(checkout).digest('hex')

    expect(validateLoMFileBytes(raw, {
      path: 'config/antiqueatlas-common.toml',
      size: checkout.length,
      hash,
      hashAlgorithm: 'md5',
    })).toMatchObject({
      valid: true,
      eolCompatible: true,
      actualSize: raw.length,
    })
  })

  it('does not apply line-ending compatibility to binary files', () => {
    const lf = Buffer.from([0x50, 0x4b, 0x0a, 0x01])
    const crlf = Buffer.from([0x50, 0x4b, 0x0d, 0x0a, 0x01])
    const hash = createHash('md5').update(crlf).digest('hex')

    expect(validateLoMFileBytes(lf, {
      path: 'mods/example.jar',
      size: crlf.length,
      hash,
      hashAlgorithm: 'md5',
    }).valid).toBe(false)
  })
})
