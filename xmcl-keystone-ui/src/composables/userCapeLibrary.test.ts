import { describe, expect, it } from 'vitest'
import { CapeLibraryItem, resolveLocalCapeUrl } from './userCapeLibrary'

const capeA: CapeLibraryItem = { id: 'cape-a', name: 'A', url: 'https://lom/cape-a.png', dateAdded: 1 }
const capeB: CapeLibraryItem = { id: 'cape-b', name: 'B', url: 'https://lom/cape-b.png', dateAdded: 2 }

const resolve = (equippedCapeIds: Record<string, string>, capes: CapeLibraryItem[], userId = 'user-1', profileId = 'profile-1') =>
  resolveLocalCapeUrl({ capes, equippedCapeIds }, userId, profileId)

describe('resolveLocalCapeUrl', () => {
  // The key format is duplicated by LocalCapeService.prepareLaunchCape (what the
  // game gets) and by the wardrobe dialogs (what the preview shows). A mismatch
  // leaves the side panel rendering the player without the cape the game loads.
  it('resolves the cape equipped under the `${userId}:${profileId}` key', () => {
    expect(resolve({ 'user-1:profile-1': 'cape-b' }, [capeA, capeB])).toBe(capeB.url)
  })

  it('is empty when the cape is equipped for another profile of the same account', () => {
    expect(resolve({ 'user-1:profile-2': 'cape-a' }, [capeA])).toBe('')
  })

  it('is empty when the cape is equipped for another account', () => {
    expect(resolve({ 'user-2:profile-1': 'cape-a' }, [capeA])).toBe('')
  })

  it('is empty when nothing is equipped', () => {
    expect(resolve({}, [capeA])).toBe('')
  })

  it('is empty when the equipped cape id is no longer in the library', () => {
    expect(resolve({ 'user-1:profile-1': 'cape-a' }, [])).toBe('')
  })
})
