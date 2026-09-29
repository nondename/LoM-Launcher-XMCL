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

export interface XUpdateService {
  /** Fetch the remote manifest and compare it with the current instance. */
  fetchInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  /** Fetch, stage and apply all add/update operations from the remote manifest. */
  applyInstanceUpdate(path: string): Promise<InstanceUpdate | undefined>
  uploadInstanceManifest(options: SetInstanceManifestOptions): Promise<void>
}

export const XUpdateServiceKey: ServiceKey<XUpdateService> = 'XUpdateService'
