import { injection } from '@/util/inject'
import { isBedrockInstance } from '@xmcl/instance'
import { XUpdateServiceKey, type LoMUpdateProgress, type LoMUpdateStatus } from '@xmcl/runtime-api'
import { kInstance } from './instance'
import { useService } from './service'

const idleProgress = (): LoMUpdateProgress => ({
  phase: 'idle',
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  bytesPerSecond: 0,
})

let sharedLomUpdate: ReturnType<typeof createLomUpdate> | undefined

function createLomUpdate() {
  const { path, instance } = injection(kInstance)
  const { checkLoMUpdate, applyLoMUpdate, getLoMUpdateProgress } = useService(XUpdateServiceKey)

  const status = ref<LoMUpdateStatus>()
  const progress = ref<LoMUpdateProgress>(idleProgress())
  const checking = ref(false)

  const isBedrock = computed(() => isBedrockInstance(instance.value))
  const updating = computed(() =>
    progress.value.phase === 'checking' ||
    progress.value.phase === 'downloading' ||
    progress.value.phase === 'installing',
  )
  const initialChecking = computed(() => checking.value && status.value === undefined)
  const percentage = computed(() => {
    if (progress.value.bytesTotal > 0) {
      return Math.min(100, Math.round((progress.value.bytesDone / progress.value.bytesTotal) * 100))
    }
    if (progress.value.filesTotal > 0) {
      return Math.min(100, Math.round((progress.value.filesDone / progress.value.filesTotal) * 100))
    }
    return 0
  })

  const buttonText = computed<string | undefined>(() => {
    if (initialChecking.value) return 'Проверка обновлений…'
    switch (progress.value.phase) {
      case 'checking': return 'Проверка обновлений…'
      case 'downloading': return `Обновление… ${percentage.value}%`
      case 'installing': return 'Установка…'
      case 'error': return 'Повторить обновление'
    }
    if (status.value?.available) return 'Обновить'
    return undefined
  })

  const buttonLoading = computed(() => initialChecking.value || updating.value)
  const actionable = computed(() =>
    progress.value.phase === 'error' ||
    (!!status.value?.available && !buttonLoading.value),
  )

  let statusRequest = 0
  async function refresh() {
    const instancePath = path.value
    if (!instancePath || isBedrock.value || updating.value) return
    const request = ++statusRequest
    checking.value = true
    try {
      const next = await checkLoMUpdate(instancePath)
      if (request === statusRequest && path.value === instancePath) status.value = next
    } catch (e) {
      console.error('[LoM updater] Failed to check update status', e)
    } finally {
      if (request === statusRequest) checking.value = false
    }
  }

  async function syncProgress() {
    try {
      progress.value = await getLoMUpdateProgress()
    } catch (e) {
      console.error('[LoM updater] Failed to read progress', e)
    }
  }

  let progressTimer: ReturnType<typeof setInterval> | undefined
  async function run(instancePath = path.value) {
    if (!instancePath || isBedrock.value || updating.value) return
    progress.value = { ...idleProgress(), phase: 'checking' }
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = setInterval(() => { void syncProgress() }, 250)
    try {
      await applyLoMUpdate(instancePath)
    } catch (e) {
      console.error('[LoM updater] Update failed', e)
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer)
        progressTimer = undefined
      }
      await syncProgress()
      await refresh()
    }
  }

  watch([path, isBedrock], () => {
    status.value = undefined
    progress.value = idleProgress()
    void refresh()
  }, { immediate: true })

  setInterval(() => { void refresh() }, 60_000)

  return {
    status,
    progress,
    checking,
    updating,
    initialChecking,
    percentage,
    buttonText,
    buttonLoading,
    actionable,
    refresh,
    run,
  }
}

export function useLomUpdate() {
  if (!sharedLomUpdate) sharedLomUpdate = createLomUpdate()
  return sharedLomUpdate
}
