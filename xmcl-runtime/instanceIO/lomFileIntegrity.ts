import { createHash } from 'crypto'
import type { LoMHashAlgorithm } from './lomDistribution'

export interface LoMIntegrityDescriptor {
  path: string
  size?: number
  hash?: string
  hashAlgorithm?: LoMHashAlgorithm
}

export interface LoMFileValidation {
  valid: boolean
  eolCompatible: boolean
  actualSize: number
  actualHash?: string
}

const TEXT_FILE_PATTERN = /\.(?:cfg|conf|css|html|ini|js|json|json5|lang|mcmeta|md|properties|snbt|toml|ts|txt|xml|yaml|yml|zs)$/i

export function isLoMTextFile(path: string) {
  return TEXT_FILE_PATTERN.test(path)
}

function digest(data: Buffer, algorithm: LoMHashAlgorithm) {
  return createHash(algorithm).update(data).digest('hex')
}

function matchesDescriptor(data: Buffer, file: LoMIntegrityDescriptor) {
  if (file.size && data.length !== file.size) return false
  if (file.hash && file.hashAlgorithm && digest(data, file.hashAlgorithm) !== file.hash.toLowerCase()) return false
  return true
}

/**
 * Git stores text files with LF in the repository, while distribution.json
 * can be generated from a Windows checkout where core.autocrlf presents the
 * same file with CRLF. In that case the published size/hash describe CRLF
 * bytes although raw.githubusercontent.com correctly serves the LF blob.
 *
 * Only text-like files get this compatibility path. Binary files remain
 * byte-for-byte strict.
 */
export function toCrlfForManifest(data: Buffer) {
  let bareLf = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) bareLf++
  }
  if (bareLf === 0) return data

  const converted = Buffer.allocUnsafe(data.length + bareLf)
  let out = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a && (i === 0 || data[i - 1] !== 0x0d)) converted[out++] = 0x0d
    converted[out++] = data[i]
  }
  return converted
}

export function validateLoMFileBytes(data: Buffer, file: LoMIntegrityDescriptor): LoMFileValidation {
  const actualHash = file.hash && file.hashAlgorithm ? digest(data, file.hashAlgorithm) : undefined
  if (matchesDescriptor(data, file)) {
    return { valid: true, eolCompatible: false, actualSize: data.length, actualHash }
  }

  if (isLoMTextFile(file.path)) {
    const crlf = toCrlfForManifest(data)
    if (crlf !== data && matchesDescriptor(crlf, file)) {
      return { valid: true, eolCompatible: true, actualSize: data.length, actualHash }
    }
  }

  return { valid: false, eolCompatible: false, actualSize: data.length, actualHash }
}

export class LoMIntegrityError extends Error {
  constructor(file: LoMIntegrityDescriptor, validation: LoMFileValidation) {
    const expectedSize = file.size || 'unknown'
    const expectedHash = file.hash || 'none'
    const actualHash = validation.actualHash || 'none'
    super(`[LoM Updater] Integrity mismatch ${file.path}: expected size=${expectedSize} ${file.hashAlgorithm || 'hash'}=${expectedHash}, actual size=${validation.actualSize} hash=${actualHash}`)
    this.name = 'LoMIntegrityError'
  }
}
