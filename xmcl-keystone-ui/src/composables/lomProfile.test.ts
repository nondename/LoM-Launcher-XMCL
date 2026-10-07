import { InstanceSchema } from '@xmcl/instance'
import { describe, expect, it } from 'vitest'
import { isLegacyLoMProfile, isManagedLoMProfile, LOM_MANAGED_INSTANCE, LOM_PROFILE_NAME, LOM_PROFILE_RUNTIME } from './lomProfile'

function instance(data: Record<string, unknown>) {
  return {
    ...InstanceSchema.parse(data),
    path: 'C:/XMCL/instances/test',
  }
}

describe('LoM managed profile ownership', () => {
  it('does not claim a user instance just because name/runtime match LoM', () => {
    const userInstance = instance({
      name: LOM_PROFILE_NAME,
      runtime: { ...LOM_PROFILE_RUNTIME },
    })

    expect(isManagedLoMProfile(userInstance)).toBe(false)
    expect(isLegacyLoMProfile(userInstance)).toBe(true)
  })

  it('recognizes the persisted managed identity', () => {
    const managed = instance({
      name: 'Renamed by user',
      runtime: { ...LOM_PROFILE_RUNTIME },
      managed: LOM_MANAGED_INSTANCE,
    })

    expect(isManagedLoMProfile(managed)).toBe(true)
    expect(isLegacyLoMProfile(managed)).toBe(false)
  })

  it('rejects a different managed profile from the LoM updater', () => {
    const managed = instance({
      name: LOM_PROFILE_NAME,
      runtime: { ...LOM_PROFILE_RUNTIME },
      managed: {
        ...LOM_MANAGED_INSTANCE,
        profileId: 'another-pack',
      },
    })

    expect(isManagedLoMProfile(managed)).toBe(false)
  })
})
