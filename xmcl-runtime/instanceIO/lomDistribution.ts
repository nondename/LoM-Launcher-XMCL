export type LoMHashAlgorithm = 'sha1' | 'md5'

export type LoMManifestFile = {
  path: string
  hash?: string
  hashAlgorithm?: LoMHashAlgorithm
  url?: string
  size?: number
}

export type LoMManifest = {
  version: string
  files: LoMManifestFile[]
  delete?: string[]
  /**
   * Provider-owned runtime files installed into XMCL's shared game-data root.
   * These are cache-like files (Forge libraries/version metadata) and are
   * verified/overwritten but never automatically deleted.
   */
  runtimeFiles?: LoMManifestFile[]
  /** Local version id made available after runtimeFiles are installed. */
  runtimeVersion?: string
}

type DistributionArtifact = {
  size?: unknown
  url?: unknown
  MD5?: unknown
  path?: unknown
}

type DistributionModule = {
  id?: unknown
  type?: unknown
  artifact?: DistributionArtifact
  subModules?: unknown
}

type DistributionServer = {
  id?: unknown
  name?: unknown
  version?: unknown
  minecraftVersion?: unknown
  modules?: unknown
}

type Distribution = {
  version?: unknown
  servers?: unknown
  delete?: unknown
}

type DistributionCollection = {
  files: Map<string, LoMManifestFile>
  runtimeFiles: Map<string, LoMManifestFile>
  runtimeVersion?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function decodePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/')
}

function relativePathFromArtifactUrl(url: string, sourceUrl: string): string | undefined {
  const artifactUrl = new URL(url, sourceUrl)
  const sourceBase = new URL('.', sourceUrl)
  if (artifactUrl.origin !== sourceBase.origin || !artifactUrl.pathname.startsWith(sourceBase.pathname)) {
    return undefined
  }
  return decodePath(artifactUrl.pathname.slice(sourceBase.pathname.length))
}

function normalizeArtifactPath(artifact: DistributionArtifact, sourceUrl: string): string | undefined {
  if (typeof artifact.url === 'string') {
    const fromUrl = relativePathFromArtifactUrl(artifact.url, sourceUrl)
    if (fromUrl) return fromUrl
  }
  if (typeof artifact.path === 'string') {
    return decodePath(artifact.path)
  }
  return undefined
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0')) return false
  const parts = path.split('/')
  return !parts.some((part) => !part || part === '.' || part === '..')
}

function validPackPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false
  // Runtime artifacts belong to XMCL's shared game-data root, never inside a
  // particular instance directory.
  if (path === 'repo' || path.startsWith('repo/')) return false
  return true
}

function getRuntimeTargetPath(type: string, sourcePath: string): string | undefined {
  if (!isSafeRelativePath(sourcePath)) return undefined

  if (type === 'VersionManifest' && sourcePath.startsWith('repo/versions/')) {
    const target = sourcePath.slice('repo/'.length)
    return target.startsWith('versions/') && isSafeRelativePath(target) ? target : undefined
  }

  if ((type === 'Library' || type === 'ForgeHosted') && sourcePath.startsWith('repo/lib/')) {
    const relativeLibrary = sourcePath.slice('repo/lib/'.length)
    const target = `libraries/${relativeLibrary}`
    return isSafeRelativePath(target) ? target : undefined
  }

  return undefined
}

function toManifestFile(
  artifact: DistributionArtifact,
  path: string,
  sourceUrl: string,
): LoMManifestFile {
  const md5 = typeof artifact.MD5 === 'string' && /^[a-f0-9]{32}$/i.test(artifact.MD5)
    ? artifact.MD5.toLowerCase()
    : undefined
  const size = typeof artifact.size === 'number' && Number.isFinite(artifact.size) && artifact.size >= 0
    ? artifact.size
    : undefined

  return {
    path,
    url: typeof artifact.url === 'string' ? new URL(artifact.url, sourceUrl).toString() : undefined,
    size,
    hash: md5,
    hashAlgorithm: md5 ? 'md5' : undefined,
  }
}

function collectDistributionModules(
  modules: unknown,
  sourceUrl: string,
  collection: DistributionCollection,
) {
  if (!Array.isArray(modules)) return

  for (const value of modules) {
    if (!isRecord(value)) continue
    const module = value as DistributionModule
    const type = typeof module.type === 'string' ? module.type : ''
    const artifact = isRecord(module.artifact) ? module.artifact as DistributionArtifact : undefined

    if (artifact && typeof artifact.url === 'string') {
      const sourcePath = normalizeArtifactPath(artifact, sourceUrl)

      if ((type === 'ForgeMod' || type === 'File') && sourcePath && validPackPath(sourcePath)) {
        collection.files.set(sourcePath, toManifestFile(artifact, sourcePath, sourceUrl))
      }

      if (sourcePath) {
        const runtimePath = getRuntimeTargetPath(type, sourcePath)
        if (runtimePath) {
          collection.runtimeFiles.set(runtimePath, toManifestFile(artifact, runtimePath, sourceUrl))
          if (type === 'VersionManifest') {
            // The Helios module id is not necessarily the local XMCL version
            // id. For Forge it is currently "1.20.1-47.4.22", while the actual
            // mirrored version directory/json is "1.20.1-forge-47.4.22".
            // The on-disk target path is authoritative because VersionService
            // resolves versions by that directory/json id.
            const match = /^versions\/([^/]+)\/([^/]+)\.json$/.exec(runtimePath)
            if (match && match[1] === match[2]) {
              collection.runtimeVersion = match[1]
            } else if (typeof module.id === 'string' && module.id) {
              collection.runtimeVersion = module.id
            }
          }
        }
      }
    }

    collectDistributionModules(module.subModules, sourceUrl, collection)
  }
}

function normalizeLegacyManifest(raw: Record<string, unknown>): LoMManifest | undefined {
  if (typeof raw.version !== 'string' || !Array.isArray(raw.files)) return undefined

  const files: LoMManifestFile[] = []
  for (const value of raw.files) {
    if (!isRecord(value)) throw new Error('[LoM Updater] Invalid legacy manifest file entry')
    const path = value.path
    const sha1 = value.sha1
    if (typeof path !== 'string' || typeof sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(sha1)) {
      throw new Error('[LoM Updater] Invalid legacy manifest file entry')
    }
    files.push({
      path: decodePath(path),
      url: typeof value.url === 'string' ? value.url : undefined,
      size: typeof value.size === 'number' ? value.size : undefined,
      hash: sha1.toLowerCase(),
      hashAlgorithm: 'sha1',
    })
  }

  return {
    version: raw.version,
    files,
    delete: Array.isArray(raw.delete) ? raw.delete.filter((v): v is string => typeof v === 'string') : undefined,
  }
}

export function normalizeLoMManifest(raw: unknown, sourceUrl: string): LoMManifest {
  if (!isRecord(raw)) throw new Error('[LoM Updater] Invalid manifest')

  const legacy = normalizeLegacyManifest(raw)
  if (legacy) return legacy

  const distribution = raw as Distribution
  if (!Array.isArray(distribution.servers) || distribution.servers.length === 0) {
    throw new Error('[LoM Updater] Invalid distribution: servers are missing')
  }

  const servers = distribution.servers.filter(isRecord) as DistributionServer[]
  const server = servers.find((candidate) => candidate.id === 'Legends_of_Medieval-1.20.1')
    ?? servers.find((candidate) => candidate.name === 'Legends of Medieval')
    ?? servers.find((candidate) => candidate.minecraftVersion === '1.20.1')
    ?? servers[0]

  if (!server) throw new Error('[LoM Updater] Invalid distribution: LoM server is missing')

  // distribution.version is the pack updater revision. The server version is
  // kept as a fallback for older manifests, but it should not mask pack-only
  // updates where Minecraft/Forge/server metadata did not change.
  const version = typeof distribution.version === 'string'
    ? distribution.version
    : typeof server.version === 'string'
      ? server.version
      : undefined
  if (!version) throw new Error('[LoM Updater] Invalid distribution: version is missing')

  const collection: DistributionCollection = {
    files: new Map<string, LoMManifestFile>(),
    runtimeFiles: new Map<string, LoMManifestFile>(),
  }
  collectDistributionModules(server.modules, sourceUrl, collection)

  // options.txt is intentionally stored at the pack repository root and is
  // not emitted by the current Helios distribution generator. Include it so
  // a fresh LoM install receives our Russian/default client settings instead
  // of the vanilla English options generated by Minecraft.
  if (!collection.files.has('options.txt')) {
    collection.files.set('options.txt', {
      path: 'options.txt',
      url: new URL('options.txt', sourceUrl).toString(),
    })
  }

  if (collection.files.size <= 1) {
    throw new Error('[LoM Updater] Distribution contains no game files')
  }

  const deletePaths = Array.isArray(distribution.delete)
    ? distribution.delete
      .filter((value): value is string => typeof value === 'string')
      .map(decodePath)
      .filter(validPackPath)
    : []

  return {
    version,
    files: [...collection.files.values()],
    delete: [...new Set([
      // Cleanup the marker left by the pre-v0.1 production build which was
      // accidentally wired to the updater test manifest.
      'config/lom-updater-test.txt',
      ...deletePaths,
    ])],
    runtimeFiles: [...collection.runtimeFiles.values()],
    runtimeVersion: collection.runtimeVersion,
  }
}
