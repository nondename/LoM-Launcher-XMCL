import { useService } from '@/composables'
import { GameProfileAndTexture, LocalCape, LocalCapeServiceKey } from '@xmcl/runtime-api'
import { createSharedComposable } from '@vueuse/core'
import { computed, onMounted, Ref, ref } from 'vue'

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

/**
 * URL of the local wardrobe cape equipped for an account, or `''`.
 *
 * Equipping a cape only writes to `LocalCapeService.state.equippedCapeIds` — it
 * never reaches `gameProfile.capes` / `gameProfile.textures.CAPE`. The launch
 * pipeline (`prepareLaunchCape`) and the wardrobe preview both read that state,
 * so anything rendering the player from the game profile alone shows a bare back.
 *
 * @param userId The `UserProfile.id` the cape is equipped for.
 * @param gameProfile The game profile its cape is keyed by (`${user.id}:${profile.id}`).
 */
export function useLocalCapeUrl(userId: Ref<string>, gameProfile: Ref<GameProfileAndTexture | undefined>) {
  const { capes, equippedCapeIds } = useUserCapeLibrary()
  return computed(() => {
    const profileId = gameProfile.value?.id
    return profileId ? resolveLocalCapeUrl({ capes: capes.value, equippedCapeIds: equippedCapeIds.value }, userId.value, profileId) : ''
  })
}

/**
 * Look up the equipped cape URL.
 *
 * The `${userId}:${profileId}` account key is duplicated by
 * `LocalCapeService.prepareLaunchCape` (what the game gets) and by both wardrobe
 * dialogs (what the preview shows); it is the only link between them.
 */
export function resolveLocalCapeUrl(
  library: { capes: CapeLibraryItem[], equippedCapeIds: Record<string, string> },
  userId: string,
  profileId: string,
): string {
  const capeId = library.equippedCapeIds[`${userId}:${profileId}`]
  if (!capeId) return ''
  return library.capes.find((cape) => cape.id === capeId)?.url || ''
}
