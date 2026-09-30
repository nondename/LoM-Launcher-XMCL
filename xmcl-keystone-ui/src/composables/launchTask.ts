import { injection } from '@/util/inject'
import { Instance } from '@xmcl/instance'
import { TaskState, type Tasks } from '@xmcl/runtime-api'
import { computed, Ref, InjectionKey } from 'vue'
import { kTaskManager } from './taskManager'

export const kLaunchTask: InjectionKey<ReturnType<typeof useLaunchTask>> = Symbol('LaunchTask')

export function useLaunchTask(path: Ref<string>, version: Ref<Instance['runtime']>, localVersion: Ref<string | undefined>) {
  const { tasks, cancel: cancelTask } = injection(kTaskManager)

  const matches = (task: Tasks) => {
    if (!path.value) return false

    if (task.type === 'installJre') {
      return true
    }
    if (task.type === 'installVersion') {
      return task.version === version.value.minecraft || task.version === localVersion.value
    }
    if (task.type === 'installLibraries') {
      return true
    }
    if (task.type === 'installAssets') {
      return task.version === version.value.minecraft ||
        task.version === localVersion.value ||
        task.version === version.value.minecraft.substring(version.value.minecraft.lastIndexOf('.'))
    }
    if (task.type === 'installForge') {
      return task.version === version.value.forge || task.mcversion === version.value.minecraft
    }
    if (task.type === 'installNeoForge') {
      return task.version === version.value.neoForged || task.minecraft === version.value.minecraft
    }
    if (task.type === 'installLabyMod') {
      return task.version === version.value.labyMod
    }
    if (task.type === 'installOptifine') {
      return task.version === version.value.optifine
    }
    if (task.type === 'installProfile') {
      return task.version === localVersion.value
    }
    if (task.type === 'installFabric') {
      return task.minecraft === version.value.minecraft
    }
    if (task.type === 'installQuilt') {
      return task.minecraft === version.value.minecraft
    }
    if (task.type === 'installInstance') {
      return task.instancePath === path.value
    }
    return false
  }

  // A profile repair/install can spawn multiple concurrent tasks (Minecraft,
  // Forge, libraries, assets, Java, etc.). The old implementation selected
  // only the first matching task, so pressing the main cancel button stopped
  // one download while the rest kept running.
  const matchingTasks = computed(() =>
    tasks.value.filter(task => task.state === TaskState.Running && matches(task)),
  )
  const task = computed(() => matchingTasks.value[0])
  const status = computed(() => matchingTasks.value.length > 0 ? TaskState.Running : undefined)
  const progress = computed(() => task.value?.progress?.progress ?? 0)
  const total = computed(() => task.value?.progress?.total ?? -1)

  return {
    task,
    progress,
    total,
    status,
    cancel: () => {
      for (const runningTask of [...matchingTasks.value]) {
        cancelTask(runningTask)
      }
    },
  }
}
