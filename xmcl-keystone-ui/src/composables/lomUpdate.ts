import { injection } from '@/util/inject'
import { isBedrockInstance } from '@xmcl/instance'
import { XUpdateServiceKey, type LoMUpdateProgress, type LoMUpdateStatus } from '@xmcl/runtime-api'
import { kInstance } from './instance'
import { isLoMProfile } from './lomProfile'
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
  const { checkLoMUpdate, applyLoMUpdate, cancelLoMUpdate, getLoMUpdateProgress } = useService(XUpdateServiceKey)

  const status = ref<LoMUpdateStatus>()
  const progress = ref<LoMUpdateProgress>(idleProgress())
  const checking = ref(false)
  const skippedRemoteVersion = ref<string>()

  const isBedrock = computed(() => isBedrockInstance(instance.value))
  const isLoM = computed(() => isLoMProfile(instance.value))
  const updating = computed(() =>
    progress.value.phase === 'checking' ||
    progress.value.phase === 'downloading' ||
    progress.value.phase === 'cancelling' ||
    progress.value.phase === 'installing',
  )
  const cancellable = computed(() => isLoM.value && progress.value.phase === 'downloading')
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
    if (!isLoM.value) return undefined
    if (initialChecking.value) return 'Проверка обновлений…'
    switch (progress.value.phase) {
      case 'checking': return 'Проверка обновлений…'
      case 'downloading': return percentage.value > 0 ? `Отменить загрузку (${percentage.value}%)` : 'Отменить загрузку'
      case 'cancelling': return 'Отмена…'
      case 'installing': return 'Установка…'
      case 'error': return status.value?.installedVersion ? 'Повторить обновление' : 'Повторить установку'
    }
    if (status.value?.available) {
      if (status.value.installedVersion && skippedRemoteVersion.value === status.value.remoteVersion) return undefined
      return status.value.installedVersion ? 'Обновить' : 'Установить'
    }
    return undefined
  })

  // Keep the main launch button clickable while downloading so it can act as
  // the cancellation control. Checking/cancelling/installing remain locked.
  const buttonLoading = computed(() => isLoM.value && (
    initialChecking.value ||
    progress.value.phase === 'checking' ||
    progress.value.phase === 'cancelling' ||
    progress.value.phase === 'installing'
  ))
  const actionable = computed(() => isLoM.value && (
    cancellable.value ||
    progress.value.phase === 'error' ||
    (!!status.value?.available && !buttonLoading.value && !(
      !!status.value.installedVersion && skippedRemoteVersion.value === status.value.remoteVersion
    ))
  ))

  let statusRequest = 0
  async function refresh() {
    const instancePath = path.value
    if (!instancePath || !isLoM.value || isBedrock.value || updating.value) return
    const request = ++statusRequest
    checking.value = true
    try {
      const next = await checkLoMUpdate(instancePath)
      if (request === statusRequest && path.value === instancePath && isLoM.value) {
        if (skippedRemoteVersion.value && skippedRemoteVersion.value !== next.remoteVersion) skippedRemoteVersion.value = undefined
        status.value = next
      }
    } catch (e) {
      console.error('[LoM updater] Failed to check update status', e)
    } finally {
      if (request === statusRequest) checking.value = false
    }
  }

  async function syncProgress() {
    if (!isLoM.value) return
    try {
      progress.value = await getLoMUpdateProgress()
    } catch (e) {
      console.error('[LoM updater] Failed to read progress', e)
    }
  }

  let progressTimer: ReturnType<typeof setInterval> | undefined
  async function run(instancePath = path.value) {
    if (!instancePath || !isLoM.value || isBedrock.value || updating.value) return
    skippedRemoteVersion.value = undefined
    progress.value = { ...idleProgress(), phase: 'checking' }
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = setInterval(() => { void syncProgress() }, 250)
    try {
      await applyLoMUpdate(instancePath)
    } catch (e) {
      await syncProgress()
      // A user cancellation returns the updater to idle and is not an error.
      if (progress.value.phase !== 'idle') console.error('[LoM updater] Update failed', e)
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer)
        progressTimer = undefined
      }
      await syncProgress()
      await refresh()
    }
  }

  async function cancel(instancePath = path.value) {
    if (!instancePath || !isLoM.value || !cancellable.value) return false
    if (status.value?.installedVersion && status.value.remoteVersion) {
      // After cancelling an optional update, let the user launch the currently
      // installed revision. A newer remote revision will be offered again.
      skippedRemoteVersion.value = status.value.remoteVersion
    }
    progress.value = { ...progress.value, phase: 'cancelling', bytesPerSecond: 0 }
    try {
      const accepted = await cancelLoMUpdate(instancePath)
      if (!accepted) await syncProgress()
      return accepted
    } catch (e) {
      console.error('[LoM updater] Failed to cancel update', e)
      await syncProgress()
      return false
    }
  }

  // Startup and profile changes only check whether an install/update exists.
  // Downloading starts exclusively from the user's explicit launch-button click.
  watch([path, isBedrock, isLoM], () => {
    status.value = undefined
    progress.value = idleProgress()
    checking.value = false
    skippedRemoteVersion.value = undefined
    statusRequest++
    if (isLoM.value) void refresh()
  }, { immediate: true })

  setInterval(() => {
    if (isLoM.value) void refresh()
  }, 60_000)

  return {
    status,
    progress,
    checking,
    updating,
    cancellable,
    initialChecking,
    percentage,
    buttonText,
    buttonLoading,
    actionable,
    refresh,
    run,
    cancel,
  }
}

export function useLomUpdate() {
  if (!sharedLomUpdate) sharedLomUpdate = createLomUpdate()
  return sharedLomUpdate
}
