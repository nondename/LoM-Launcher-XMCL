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
 * Git can expose text files with different line endings than the checkout
 * that was used to generate distribution.json. A checkout can also add or
 * remove the final newline without changing the semantic text contents.
 *
 * We still require one transformed byte sequence to match the exact manifest
 * size and hash. Binary files never use these compatibility candidates.
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

export function toLfForManifest(data: Buffer) {
  let crlf = 0
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] === 0x0d && data[i] === 0x0a) crlf++
  }
  if (crlf === 0) return data

  const converted = Buffer.allocUnsafe(data.length - crlf)
  let out = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0d && i + 1 < data.length && data[i + 1] === 0x0a) continue
    converted[out++] = data[i]
  }
  return converted
}

function stripFinalNewline(data: Buffer) {
  if (data.length === 0) return data
  if (data[data.length - 1] === 0x0a) {
    if (data.length >= 2 && data[data.length - 2] === 0x0d) return data.subarray(0, data.length - 2)
    return data.subarray(0, data.length - 1)
  }
  if (data[data.length - 1] === 0x0d) return data.subarray(0, data.length - 1)
  return data
}

function textCompatibilityCandidates(data: Buffer) {
  const candidates: Buffer[] = []
  const add = (candidate: Buffer) => {
    if (!candidates.some((existing) => existing.equals(candidate))) candidates.push(candidate)
  }

  const lineEndingBases = [data, toLfForManifest(data), toCrlfForManifest(data)]
  for (const base of lineEndingBases) {
    add(base)
    const stripped = stripFinalNewline(base)
    add(stripped)
    add(Buffer.concat([stripped, Buffer.from('\n')]))
    add(Buffer.concat([stripped, Buffer.from('\r\n')]))
  }
  return candidates
}

export function validateLoMFileBytes(data: Buffer, file: LoMIntegrityDescriptor): LoMFileValidation {
  const actualHash = file.hash && file.hashAlgorithm ? digest(data, file.hashAlgorithm) : undefined
  if (matchesDescriptor(data, file)) {
    return { valid: true, eolCompatible: false, actualSize: data.length, actualHash }
  }

  if (isLoMTextFile(file.path)) {
    for (const candidate of textCompatibilityCandidates(data)) {
      if (candidate.equals(data)) continue
      if (matchesDescriptor(candidate, file)) {
        return { valid: true, eolCompatible: true, actualSize: data.length, actualHash }
      }
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
