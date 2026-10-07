import { describe, expect, it } from 'vitest'
import { InstanceSchema } from './instance'

describe('managed instance metadata', () => {
  it('persists a provider-owned profile identity', () => {
    const instance = InstanceSchema.parse({
      name: 'Legends of Medieval',
      runtime: { minecraft: '1.20.1', forge: '47.4.22' },
      managed: {
        provider: 'lom-distribution',
        profileId: 'legends-of-medieval',
        manifestUrl: 'https://example.invalid/distribution.json',
        channel: 'dev',
        java: {
          majorVersion: 17,
          component: 'java-runtime-gamma',
        },
      },
    })

    expect(instance.managed).toEqual({
      provider: 'lom-distribution',
      profileId: 'legends-of-medieval',
      manifestUrl: 'https://example.invalid/distribution.json',
      channel: 'dev',
      java: {
        majorVersion: 17,
        component: 'java-runtime-gamma',
      },
    })
  })

  it('leaves ordinary XMCL instances unmanaged', () => {
    const instance = InstanceSchema.parse({
      name: 'My Forge Pack',
      runtime: { minecraft: '1.20.1', forge: '47.4.22' },
    })

    expect(instance.managed).toBeUndefined()
  })

  it('drops malformed managed metadata instead of granting ownership', () => {
    const instance = InstanceSchema.parse({
      name: 'Looks Like LoM',
      runtime: { minecraft: '1.20.1', forge: '47.4.22' },
      managed: {
        provider: '',
        profileId: 'legends-of-medieval',
        manifestUrl: 'not-a-url',
      },
    })

    expect(instance.managed).toBeUndefined()
  })
})
