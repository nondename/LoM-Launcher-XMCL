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

export interface LoMUpdateResult {
  version: string
  changed: number
  deleted: number
}

export interface LoMUpdateStatus {
  available: boolean
  remoteVersion: string
  installedVersion?: string
}

export interface LoMUpdateProgress {
  phase: 'idle' | 'checking' | 'downloading' | 'cancelling' | 'installing' | 'done' | 'error'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  bytesPerSecond: number
  currentFile?: string
  error?: string
}

export interface XUpdateService {
  /** Fetch the remote manifest and compare it with the current instance. */
  fetchInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  /** Fetch, stage and apply all add/update operations from the remote manifest. */
  applyInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  /** Compare the installed LoM revision with the remote LoM manifest revision. */
  checkLoMUpdate(path: string): Promise<LoMUpdateStatus>
  /** Apply the dedicated LoM manifest update. */
  applyLoMUpdate(path: string): Promise<LoMUpdateResult>
  /** Cancel a LoM update while it is still downloading. */
  cancelLoMUpdate(path: string): Promise<boolean>
  /** Read current LoM updater progress. */
  getLoMUpdateProgress(): Promise<LoMUpdateProgress>
  uploadInstanceManifest(options: SetInstanceManifestOptions): Promise<void>
}

export const XUpdateServiceKey: ServiceKey<XUpdateService> = 'XUpdateService'
