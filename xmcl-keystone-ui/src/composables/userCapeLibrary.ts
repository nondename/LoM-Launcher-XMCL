import { useService } from '@/composables'
import { LocalCape, LocalCapeServiceKey } from '@xmcl/runtime-api'
import { createSharedComposable } from '@vueuse/core'
import { onMounted, ref } from 'vue'

export type CapeLibraryItem = LocalCape

function normalizeCapeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string' && value.message) {
      return new Error(value.message)
    }
    const exception = value.exception
    if (exception && typeof exception === 'object') {
      const nested = exception as Record<string, unknown>
      if (typeof nested.message === 'string' && nested.message) {
        return new Error(nested.message)
      }
    }
    try {
      return new Error(JSON.stringify(error))
    } catch {
      return new Error('Unknown cape service error')
    }
  }
  return new Error(String(error))
}

export const useUserCapeLibrary = createSharedComposable(() => {
  const service = useService(LocalCapeServiceKey)
  const capes = ref<CapeLibraryItem[]>([])
  const equippedCapeIds = ref<Record<string, string>>({})
  const loading = ref(false)
  let refreshRequest = 0

  async function refresh() {
    const request = ++refreshRequest
    loading.value = true
    try {
      const state = await service.getState()
      if (request === refreshRequest) {
        capes.value = state.capes
        equippedCapeIds.value = state.equippedCapeIds
      }
    } catch (error) {
      throw normalizeCapeError(error)
    } finally {
      if (request === refreshRequest) loading.value = false
    }
  }

  async function addCape(item: { name: string; url: string }) {
    try {
      const cape = await service.addCape({ name: item.name, source: item.url })
      capes.value = [cape, ...capes.value]
      return cape
    } catch (error) {
      throw normalizeCapeError(error)
    }
  }

  async function updateCape(id: string, updates: Partial<Pick<CapeLibraryItem, 'name'>>) {
    try {
      const updated = await service.updateCape(id, updates)
      const index = capes.value.findIndex(cape => cape.id === id)
      if (index !== -1) {
        capes.value[index] = updated
        capes.value = [...capes.value]
      }
      return updated
    } catch (error) {
      throw normalizeCapeError(error)
    }
  }

  async function removeCape(id: string) {
    try {
      await service.removeCape(id)
      capes.value = capes.value.filter(cape => cape.id !== id)
      equippedCapeIds.value = Object.fromEntries(Object.entries(equippedCapeIds.value).filter(([, capeId]) => capeId !== id))
    } catch (error) {
      throw normalizeCapeError(error)
    }
  }

  async function setEquippedCape(account: string, id: string) {
    try {
      await service.setEquippedCape(account, id)
      const next = { ...equippedCapeIds.value }
      if (id) next[account] = id
      else delete next[account]
      equippedCapeIds.value = next
    } catch (error) {
      throw normalizeCapeError(error)
    }
  }

  onMounted(refresh)

  return {
    capes,
    equippedCapeIds,
    loading,
    refresh,
    addCape,
    updateCape,
    removeCape,
    setEquippedCape,
  }
})