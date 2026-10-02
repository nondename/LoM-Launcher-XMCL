import { useService } from '@/composables'
import { LocalCape, LocalCapeServiceKey } from '@xmcl/runtime-api'
import { createSharedComposable } from '@vueuse/core'
import { onMounted, ref } from 'vue'

export type CapeLibraryItem = LocalCape

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
    } finally {
      if (request === refreshRequest) loading.value = false
    }
  }

  async function addCape(item: { name: string; url: string }) {
    const cape = await service.addCape({ name: item.name, source: item.url })
    capes.value = [cape, ...capes.value]
    return cape
  }

  async function updateCape(id: string, updates: Partial<Pick<CapeLibraryItem, 'name'>>) {
    const updated = await service.updateCape(id, updates)
    const index = capes.value.findIndex(cape => cape.id === id)
    if (index !== -1) {
      capes.value[index] = updated
      capes.value = [...capes.value]
    }
    return updated
  }

  async function removeCape(id: string) {
    await service.removeCape(id)
    capes.value = capes.value.filter(cape => cape.id !== id)
    equippedCapeIds.value = Object.fromEntries(Object.entries(equippedCapeIds.value).filter(([, capeId]) => capeId !== id))
  }

  async function setEquippedCape(account: string, id: string) {
    await service.setEquippedCape(account, id)
    const next = { ...equippedCapeIds.value }
    if (id) next[account] = id
    else delete next[account]
    equippedCapeIds.value = next
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
