import { describe, expect, it } from 'vitest'
import { hasMismatchedInstanceSnapshot } from './launchButton'

describe('launch button instance snapshot guard', () => {
  it('does not block launch when an optional snapshot is missing', () => {
    expect(hasMismatchedInstanceSnapshot(
      'C:/XMCL/instances/vanilla-1.7.10',
      'C:/XMCL/instances/vanilla-1.7.10',
      undefined,
      'C:/XMCL/instances/vanilla-1.7.10',
    )).toBe(false)
  })

  it('blocks while an existing snapshot belongs to another instance', () => {
    expect(hasMismatchedInstanceSnapshot(
      'C:/XMCL/instances/vanilla-1.7.10',
      'C:/XMCL/instances/Legends of Medieval',
      undefined,
      'C:/XMCL/instances/vanilla-1.7.10',
    )).toBe(true)
  })

  it('allows launch when every snapshot is missing after loading has settled', () => {
    expect(hasMismatchedInstanceSnapshot(
      'C:/XMCL/instances/vanilla-1.7.10',
      undefined,
      undefined,
      undefined,
    )).toBe(false)
  })
})
