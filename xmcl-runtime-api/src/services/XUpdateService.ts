import { InstanceFile } from '@xmcl/instance'
import { InstanceManifest } from '../entities/instanceManifest.schema'
import { ServiceKey } from './Service'

export interface InstanceUpdate {
  updates: Array<{
    operation: 'update' | 'add'
    file: InstanceFile
  }>
  manifest: InstanceManifest
}

export interface SetInstanceManifestOptions {
  path: string
  manifest: InstanceManifest
  headers?: Record<string, string>
  includeFileWithDownloads?: boolean
  forceJsonFormat?: boolean
}

export interface ManagedInstanceUpdateResult {
  version: string
  changed: number
  deleted: number
}

export interface ManagedInstanceUpdateStatus {
  available: boolean
  remoteVersion: string
  installedVersion?: string
}

export interface ManagedInstanceUpdateProgress {
  phase: 'idle' | 'checking' | 'downloading' | 'cancelling' | 'installing' | 'done' | 'error'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  bytesPerSecond: number
  currentFile?: string
  error?: string
}

// Compatibility aliases for renderer code compiled against older LoM builds.
export type LoMUpdateResult = ManagedInstanceUpdateResult
export type LoMUpdateStatus = ManagedInstanceUpdateStatus
export type LoMUpdateProgress = ManagedInstanceUpdateProgress

export interface XUpdateService {
  /** Fetch the remote manifest and compare it with the current instance. */
  fetchInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  /** Fetch, stage and apply all add/update operations from the remote manifest. */
  applyInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  /** Compare a launcher-managed instance with its provider manifest. */
  checkManagedInstanceUpdate(path: string): Promise<ManagedInstanceUpdateStatus>
  /** Apply the provider-owned files of a launcher-managed instance. */
  applyManagedInstanceUpdate(path: string): Promise<ManagedInstanceUpdateResult>
  /** Cancel a managed update while it is still downloading. */
  cancelManagedInstanceUpdate(path: string): Promise<boolean>
  /** Read update progress for a specific managed instance. */
  getManagedInstanceUpdateProgress(path: string): Promise<ManagedInstanceUpdateProgress>
  uploadInstanceManifest(options: SetInstanceManifestOptions): Promise<void>
}

export const XUpdateServiceKey: ServiceKey<XUpdateService> = 'XUpdateService'
