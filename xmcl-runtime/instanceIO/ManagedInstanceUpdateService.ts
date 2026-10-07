import type { ManagedInstance } from '@xmcl/instance'
import { InstanceIOException } from '@xmcl/runtime-api'
import { Inject, LauncherAppKey } from '~/app'
import { InstanceService } from '~/instance'
import { AbstractService } from '~/service'
import { LauncherApp } from '../app/LauncherApp'
import { LoMUpdateService } from './LoMUpdateService'
import type { ManagedInstanceUpdateProvider } from './ManagedInstanceUpdateProvider'

type ManagedContext = {
  instancePath: string
  managed: ManagedInstance
}

/**
 * Runtime boundary between ordinary XMCL instances and launcher-managed
 * profiles. UI code may request an update by path, but ownership is always
 * re-validated here against the persisted instance metadata before a provider
 * is allowed to touch files.
 */
export class ManagedInstanceUpdateService extends AbstractService {
  constructor(
    @Inject(LauncherAppKey) app: LauncherApp,
    @Inject(InstanceService) private instanceService: InstanceService,
  ) {
    super(app)
  }

  private resolveContext(instancePath: string): ManagedContext {
    const instance = this.instanceService.state.all[instancePath]
    if (!instance) {
      throw new InstanceIOException({ instancePath, type: 'instanceNotFound' })
    }
    if (!instance.managed) {
      throw new Error(`Instance is not launcher-managed: ${instancePath}`)
    }
    return { instancePath, managed: instance.managed }
  }

  private async getProvider(context: ManagedContext): Promise<ManagedInstanceUpdateProvider> {
    switch (context.managed.provider) {
      case 'lom-distribution':
        return this.app.registry.getOrCreate(LoMUpdateService)
      default:
        throw new Error(`Unsupported managed instance provider: ${context.managed.provider}`)
    }
  }

  async check(instancePath: string): Promise<LoMUpdateStatus> {
    const context = this.resolveContext(instancePath)
    const provider = await this.getProvider(context)
    return provider.check(instancePath, context.managed)
  }

  async update(instancePath: string): Promise<LoMUpdateResult> {
    const context = this.resolveContext(instancePath)
    const provider = await this.getProvider(context)
    return provider.update(instancePath, context.managed)
  }

  async cancel(instancePath: string): Promise<boolean> {
    const context = this.resolveContext(instancePath)
    const provider = await this.getProvider(context)
    return provider.cancel(instancePath)
  }

  async getProgress(instancePath: string): Promise<LoMUpdateProgress> {
    const context = this.resolveContext(instancePath)
    const provider = await this.getProvider(context)
    return provider.getProgress(instancePath)
  }
}
