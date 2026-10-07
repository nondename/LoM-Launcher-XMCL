import { useEventBus, useLocalStorage } from '@vueuse/core'
import type { EditInstanceOptions, Instance, InstanceDataWithTime } from '@xmcl/instance'
import { InstanceServiceKey, InstanceState, AUTHORITY_DEV, AUTHORITY_MICROSOFT } from '@xmcl/runtime-api'
import { InjectionKey, inject } from 'vue'
import { useService } from './service'
import { useState } from './syncableState'
import { InstanceOrGroupData } from './instanceGroup'
import { kUserContext } from './user'
import { isLegacyLoMProfile, LOM_COLD_START_PENDING_KEY, LOM_LEGACY_MANAGED_INSTANCE_PATHS_KEY, LOM_MANAGED_INSTANCE, LOM_PROFILE_NAME, LOM_PROFILE_RUNTIME } from './lomProfile'

export const kInstances: InjectionKey<ReturnType<typeof useInstances>> = Symbol('Instances')

/**
 * Hook of a view of all instances & some deletion/selection functions
 */
export function useInstances() {
  const { getSharedInstancesState, createInstance, editInstance, deleteInstance, validateInstancePath } = useService(InstanceServiceKey)
  const { state, isValidating, error } = useState(getSharedInstancesState, class extends InstanceState {
    constructor() {
      super()
      this.all = markRaw({})
      this.instances = markRaw([])
    }

    override instanceRemove(path: string): void {
      delete this.all[path]
      this.instances = markRaw(this.instances.filter(i => i.path !== path))
    }

    override instanceAdd(instance: Instance) {
      if (!this.all[instance.path]) {
        const object = markRaw({
          ...instance,
        })
        this.all[instance.path] = object
        this.instances = markRaw([...this.instances, this.all[instance.path]])
      }
    }

    override instanceEdit(settings: Partial<InstanceDataWithTime> & { path: string }) {
      const inst = this.instances.find(i => i.path === (settings.path))
      if (!inst) return

      // Apply the same JIT mutations the renderer used to do in-place, but
      // produce a brand-new instance object reference instead. The previous
      // implementation mutated a `markRaw`-wrapped object, which Vue cannot
      // observe — downstream `watch(... { deep: true })` consumers therefore
      // never re-evaluated after `editInstance`, leaving stale state in the UI.
      const next = markRaw({ ...inst })
      if ('showLog' in settings) next.showLog = settings.showLog
      if ('hideLauncher' in settings) next.hideLauncher = settings.hideLauncher
      if ('fastLaunch' in settings) next.fastLaunch = settings.fastLaunch
      if ('maxMemory' in settings) next.maxMemory = settings.maxMemory
      if ('minMemory' in settings) next.minMemory = settings.minMemory
      if ('assignMemory' in settings) next.assignMemory = settings.assignMemory
      if ('vmOptions' in settings) next.vmOptions = settings.vmOptions
      if ('mcOptions' in settings) next.mcOptions = settings.mcOptions
      if ('preExecuteCommand' in settings) next.preExecuteCommand = settings.preExecuteCommand

      // Let the shared base apply the rest of the diff (runtime, icon, etc.)
      // onto the new object so all downstream fields stay in sync.
      const previousInstances = this.instances
      this.instances = [next]
      try {
        super.instanceEdit(settings)
      } finally {
        this.instances = previousInstances
      }

      this.all[next.path] = next
      const idx = this.instances.indexOf(inst)
      this.instances = markRaw([
        ...this.instances.slice(0, idx),
        next,
        ...this.instances.slice(idx + 1),
      ])
    }
  })
  const userContext = inject(kUserContext)
  const userProfile = userContext?.userProfile

  const instances = computed(() => {
    const list = state.value?.instances ?? []
    const isOffline = userProfile?.value?.authority && userProfile?.value?.authority !== AUTHORITY_MICROSOFT
    if (isOffline) {
      return list.filter(i => i.edition !== 'bedrock')
    }
    return list
  })

  const allInstances = computed(() => state.value?.instances ?? [])

  const _path = useLocalStorage('selectedInstancePath', '' as string)
  const coldStartPendingPath = useLocalStorage(LOM_COLD_START_PENDING_KEY, '' as string)
  // Read-only migration source from launcher builds that tracked LoM ownership
  // by absolute path. New builds persist ownership in instance.json instead.
  const legacyManagedPaths = useLocalStorage<string[]>(LOM_LEGACY_MANAGED_INSTANCE_PATHS_KEY, [])
  const path = ref('')
  // Guard against `watch(instances)` clobbering the restored selection before
  // the async `watch(state)` initializer has finished. Without this, the
  // instances list populates (synchronously) while `path` is still empty,
  // causing the first instance to be selected and persisted over the real
  // last-selected instance.
  const initialized = ref(false)

  const migrationBus = useEventBus<{ oldRoot: string; newRoot: string }>('migration')

  migrationBus.once((e) => {
    _path.value = _path.value.replace(e.oldRoot, e.newRoot)
    coldStartPendingPath.value = coldStartPendingPath.value.replace(e.oldRoot, e.newRoot)
    legacyManagedPaths.value = legacyManagedPaths.value.map((value) => value.replace(e.oldRoot, e.newRoot))
  })

  async function edit(options: EditInstanceOptions & { instancePath: string }) {
    await editInstance({
      ...options,
      env: {
        ...(options.env ? JSON.parse(JSON.stringify(options.env)) : undefined),
      },
      // Keep `null` (the IPC-safe "reset to global" marker) intact instead of
      // collapsing it back to `undefined` — Electron IPC would drop the latter
      // and the resolution override would never be removed from instance.json.
      resolution: options.resolution ? JSON.parse(JSON.stringify(options.resolution)) : options.resolution,
    })
  }
  async function remove(instancePath: string, deleteData = true) {
    const index = instances.value.findIndex(i => i.path === instancePath)
    const lastSelected = path.value
    await deleteInstance(instancePath, deleteData)
    if (coldStartPendingPath.value === instancePath) coldStartPendingPath.value = ''
    if (instancePath === lastSelected) {
      path.value = instances.value[Math.max(index - 1, 0)]?.path ?? ''
    }
    return allInstances.value.length === 0
  }

  watch(state, async (newVal, oldVal) => {
    if (!newVal || oldVal) return

    const selectDefault = () => {
      _path.value = instances.value[0]?.path ?? ''
    }

    try {
      // Migrate ownership once from old launcher builds. The path list and the
      // cold-start marker are migration hints only; all future ownership checks
      // use instance.managed. The authlib flag is a final fallback for the
      // canonical profile created by early LoM Launcher builds.
      const wasEmpty = newVal.instances.length === 0
      let managedPath = newVal.instances.find((candidate) =>
        candidate.managed?.provider === LOM_MANAGED_INSTANCE.provider &&
        candidate.managed.profileId === LOM_MANAGED_INSTANCE.profileId,
      )?.path

      if (!managedPath) {
        const legacy = newVal.instances.find((candidate) =>
          isLegacyLoMProfile(candidate) && (
            legacyManagedPaths.value.includes(candidate.path) ||
            coldStartPendingPath.value === candidate.path ||
            candidate.disableAuthlibInjector === true
          ),
        )
        if (legacy) {
          await editInstance({
            instancePath: legacy.path,
            managed: JSON.parse(JSON.stringify(LOM_MANAGED_INSTANCE)),
          })
          managedPath = legacy.path
          legacyManagedPaths.value = legacyManagedPaths.value.filter((value) => value !== legacy.path)
          if (coldStartPendingPath.value === legacy.path) coldStartPendingPath.value = ''
        }
      }

      // Launcher updates own the managed profile definition. Existing managed
      // instances inherit source/channel/Java/runtime changes here; ordinary
      // XMCL instances never enter this reconciliation path.
      if (managedPath) {
        const managedProfile = newVal.instances.find((candidate) => candidate.path === managedPath)
        const managedChanged = JSON.stringify(managedProfile?.managed) !== JSON.stringify(LOM_MANAGED_INSTANCE)
        const runtimeChanged =
          managedProfile?.runtime.minecraft !== LOM_PROFILE_RUNTIME.minecraft ||
          managedProfile?.runtime.forge !== LOM_PROFILE_RUNTIME.forge
        if (managedChanged || runtimeChanged) {
          await editInstance({
            instancePath: managedPath,
            ...(managedChanged ? { managed: JSON.parse(JSON.stringify(LOM_MANAGED_INSTANCE)) } : {}),
            ...(runtimeChanged ? { runtime: { ...LOM_PROFILE_RUNTIME } } : {}),
          })
        }
      }

      // The official profile exists independently from user-created XMCL
      // instances. Re-provision its lightweight instance metadata when missing,
      // but never auto-download the pack or replace the user's current
      // selection merely because they also have their own instances.
      if (!managedPath) {
        managedPath = await createInstance({
          name: LOM_PROFILE_NAME,
          runtime: { ...LOM_PROFILE_RUNTIME },
          managed: JSON.parse(JSON.stringify(LOM_MANAGED_INSTANCE)),
          disableAuthlibInjector: true,
        })
        coldStartPendingPath.value = ''
      }

      if (wasEmpty) {
        _path.value = managedPath
      } else {
        const lastSelectedPath = _path.value
        if (lastSelectedPath) {
          if (!instances.value.some(i => i.path === lastSelectedPath)) {
            selectDefault()
          } else {
            const badInstance = await validateInstancePath(lastSelectedPath)
            if (badInstance) selectDefault()
          }
        } else {
          selectDefault()
        }
      }

      path.value = _path.value
    } catch (e) {
      console.error('[LoM cold start] Failed to provision default instance', e)
      // Keep the generic XMCL fallback usable if provisioning fails. This also
      // prevents the renderer from being stuck forever in its initializing state.
      selectDefault()
      path.value = _path.value
    } finally {
      initialized.value = true
    }
  })

  watch(path, (newPath) => {
    if (newPath !== _path.value) {
      // save to local storage
      _path.value = newPath
    }
    if (!newPath) return
    editInstance({
      instancePath: newPath,
      lastAccessDate: Date.now(),
    })
  })

  watch(instances, (newInstances) => {
    if (initialized.value && ready.value && !newInstances.some(i => i.path === path.value)) {
      if (newInstances.length > 0) {
        path.value = newInstances[0].path
      } else {
        path.value = ''
      }
    }
  })

  // `ready` means the initial profile selection/provisioning is complete, not
  // merely that the shared service state has arrived. Context.ts relies on
  // this to decide whether an empty launcher should redirect to /me.
  const ready = computed(() => state.value !== undefined && initialized.value)
  const groups = computed(() => {
    const rawGroups = state.value?.groups ?? []
    const isOffline = userProfile?.value?.authority && userProfile?.value?.authority !== AUTHORITY_MICROSOFT
    if (isOffline && state.value) {
      const all = state.value.all
      return rawGroups.map(item => {
        if (typeof item === 'string') {
          const inst = all[item]
          if (inst && inst.edition === 'bedrock') {
            return null
          }
          return item
        } else {
          const filtered = item.instances.filter(instPath => {
            const inst = all[instPath]
            return !(inst && inst.edition === 'bedrock')
          })
          if (filtered.length === 0) return null
          return { ...item, instances: filtered }
        }
      }).filter((v): v is InstanceOrGroupData => v !== null)
    }
    return rawGroups
  })
  const groupsSet = (groups: InstanceOrGroupData[]) => {
    state.value?.instanceGroupsSet(groups)
  }
  return {
    selectedInstance: path,
    groups,
    groupsSet,
    ready,
    instances,
    allInstances,
    isValidating,
    error,
    edit,
    remove,
  }
}