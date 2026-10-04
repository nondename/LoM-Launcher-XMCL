import { createHash } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Of } from './updateChecksum'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lom-update-checksum-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sha256Of', () => {
  it('resolves to an empty string when the file does not exist yet', async () => {
    // Regression: `checksum()` resolves `undefined` on ENOENT instead of
    // rejecting, so the first "Скачать и установить" click crashed with
    // `Cannot read properties of undefined (reading 'toLowerCase')` while
    // probing the `pending_update` file that has not been downloaded.
    const result = await sha256Of(join(dir, 'pending_update'))
    expect(result).toBe('')
    expect(result.toLowerCase()).toBe('')
  })

  it('returns the lowercase hex digest of an existing file', async () => {
    const path = join(dir, 'app.asar')
    const payload = 'lo m launcher update payload'
    await writeFile(path, payload)

    const expected = createHash('sha256').update(payload).digest('hex')

    expect(await sha256Of(path)).toBe(expected)
    expect(await sha256Of(path)).toBe(expected.toLowerCase())
    expect(await sha256Of(path)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('never returns a non-string, so callers can always compare digests', async () => {
    expect(typeof (await sha256Of(join(dir, 'missing')))).toBe('string')

    const empty = join(dir, 'empty')
    await writeFile(empty, '')
    expect(typeof (await sha256Of(empty))).toBe('string')
  })
})
