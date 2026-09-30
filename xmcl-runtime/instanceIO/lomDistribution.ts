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
}

type DistributionArtifact = {
  size?: unknown
  url?: unknown
  MD5?: unknown
  path?: unknown
}

type DistributionModule = {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizePackPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
}

function relativePathFromArtifactUrl(url: string, sourceUrl: string): string | undefined {
  const artifactUrl = new URL(url, sourceUrl)
  const sourceBase = new URL('.', sourceUrl)
  if (artifactUrl.origin !== sourceBase.origin || !artifactUrl.pathname.startsWith(sourceBase.pathname)) {
    return undefined
  }
  // Do not decode percent escapes here. A number of files in the original LoM
  // pack are literally named with %20, %5B, %2B, etc. Decoding them would
  // silently change the pack layout on disk.
  return normalizePackPath(artifactUrl.pathname.slice(sourceBase.pathname.length))
}

function normalizeArtifactPath(artifact: DistributionArtifact, sourceUrl: string): string | undefined {
  // Helios File entries carry the intended on-disk path. Prefer it over the
  // URL because the repository contains both normal filenames with spaces and
  // filenames whose percent escapes are literal characters.
  if (typeof artifact.path === 'string') {
    const path = normalizePackPath(artifact.path)
    if (path) return path
  }
  if (typeof artifact.url === 'string') {
    return relativePathFromArtifactUrl(artifact.url, sourceUrl)
  }
  return undefined
}

function validPackPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0')) return false
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return false
  // Forge libraries are already installed by XMCL's native version installer.
  // They are present in the Helios distribution under repo/, but must not be
  // copied into the game instance as normal pack files.
  if (path === 'repo' || path.startsWith('repo/')) return false
  return true
}

function collectDistributionModules(modules: unknown, sourceUrl: string, files: Map<string, LoMManifestFile>) {
  if (!Array.isArray(modules)) return

  for (const value of modules) {
    if (!isRecord(value)) continue
    const module = value as DistributionModule
    const type = typeof module.type === 'string' ? module.type : ''
    const artifact = isRecord(module.artifact) ? module.artifact as DistributionArtifact : undefined

    if ((type === 'ForgeMod' || type === 'File') && artifact && typeof artifact.url === 'string') {
      const path = normalizeArtifactPath(artifact, sourceUrl)
      if (path && validPackPath(path)) {
        const md5 = typeof artifact.MD5 === 'string' && /^[a-f0-9]{32}$/i.test(artifact.MD5)
          ? artifact.MD5.toLowerCase()
          : undefined
        const size = typeof artifact.size === 'number' && Number.isFinite(artifact.size) && artifact.size >= 0
          ? artifact.size
          : undefined
        files.set(path, {
          path,
          url: new URL(artifact.url, sourceUrl).toString(),
          size,
          hash: md5,
          hashAlgorithm: md5 ? 'md5' : undefined,
        })
      }
    }

    collectDistributionModules(module.subModules, sourceUrl, files)
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
      path: normalizePackPath(path),
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

/**
 * GitHub raw URLs are ambiguous for this pack because some repository files
 * literally contain percent escapes in their filename. For example, the repo
 * contains "%5B1.20.1%5D%20SecurityCraft...jar", while distribution.json
 * points at a raw URL containing the same text. A normal HTTP request decodes
 * those escapes to "[1.20.1] SecurityCraft...jar" and returns 404.
 *
 * Always try the manifest URL first. Only if that returns 404 should the
 * updater try the second candidate where percent signs themselves are encoded
 * (% -> %25). This keeps ordinary URLs such as "Antique%20Atlas.jar" working.
 */
export function getLoMDownloadUrls(url: string): string[] {
  const parsed = new URL(url)
  const primary = parsed.toString()
  const result = [primary]

  if (parsed.hostname === 'raw.githubusercontent.com' && /%[0-9a-f]{2}/i.test(parsed.pathname)) {
    const literalPercentPath = parsed.pathname.replace(/%/g, '%25')
    const fallback = `${parsed.origin}${literalPercentPath}${parsed.search}${parsed.hash}`
    if (fallback !== primary) result.push(fallback)
  }

  return result
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

  const version = typeof server.version === 'string'
    ? server.version
    : typeof distribution.version === 'string'
      ? distribution.version
      : undefined
  if (!version) throw new Error('[LoM Updater] Invalid distribution: version is missing')

  const files = new Map<string, LoMManifestFile>()
  collectDistributionModules(server.modules, sourceUrl, files)

  // options.txt is intentionally stored at the pack repository root and is
  // not emitted by the current Helios distribution generator. Include it so
  // a fresh LoM install receives our Russian/default client settings instead
  // of the vanilla English options generated by Minecraft.
  if (!files.has('options.txt')) {
    files.set('options.txt', {
      path: 'options.txt',
      url: new URL('options.txt', sourceUrl).toString(),
    })
  }

  if (files.size <= 1) {
    throw new Error('[LoM Updater] Distribution contains no game files')
  }

  return {
    version,
    files: [...files.values()],
    // Cleanup the marker left by the pre-v0.1 production build which was
    // accidentally wired to the updater test manifest.
    delete: ['config/lom-updater-test.txt'],
  }
}
