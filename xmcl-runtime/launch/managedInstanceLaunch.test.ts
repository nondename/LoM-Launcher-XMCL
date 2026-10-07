import { InstanceSchema } from '@xmcl/instance'
import { describe, expect, it } from 'vitest'
import { shouldRunManagedInstanceUpdate } from './managedInstanceLaunch'

describe('managed instance pre-launch ownership', () => {
  it('skips the managed updater for ordinary XMCL instances', () => {
    const instance = InstanceSchema.parse({
      name: 'user instance 1.7.10',
      runtime: { minecraft: '1.7.10' },
    })

    expect(shouldRunManagedInstanceUpdate(instance)).toBe(false)
  })

  it('runs the managed updater only for explicitly managed instances', () => {
    const instance = InstanceSchema.parse({
      name: 'Legends of Medieval',
      runtime: { minecraft: '1.20.1', forge: '47.4.22' },
      managed: {
        provider: 'lom-distribution',
        profileId: 'legends-of-medieval',
        manifestUrl: 'https://example.invalid/distribution.json',
      },
    })

    expect(shouldRunManagedInstanceUpdate(instance)).toBe(true)
  })

  it('skips when the selected instance cannot be resolved', () => {
    expect(shouldRunManagedInstanceUpdate(undefined)).toBe(false)
  })
})
