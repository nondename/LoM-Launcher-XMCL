import { InstanceInstallStatus } from '@xmcl/runtime-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef, triggerRef } from 'vue'
import { LaunchMenuItemIssue, useInstanceLaunchMenuItems } from './instanceLaunchMenuItems'
import type { InstanceJavaIssue } from './instanceJavaDiagnose'
import type { InstanceInstallInstruction } from './instanceVersionInstall'

const { installJava, refreshJava } = vi.hoisted(() => ({
  installJava: vi.fn(),
  refreshJava: vi.fn(),
}))

vi.mock('./instance', () => ({ kInstance: Symbol('instance') }))
vi.mock('./instanceFiles', () => ({ kInstanceFiles: Symbol('files') }))
vi.mock('./instanceVersionInstall', () => ({ kInstanceVersionInstall: Symbol('version') }))
vi.mock('./instanceJavaDiagnose', () => ({ kInstanceJavaDiagnose: Symbol('javaDiagnose') }))
vi.mock('./java', () => ({ kJavaContext: Symbol('java') }))
vi.mock('./service', () => ({ useService: () => ({ install: installJava }) }))
vi.mock('./instanceUpdate', () => ({ UnresolvedFilesDialogKey: 'unresolved' }))
vi.mock('./launch', () => ({ LaunchStatusDialogKey: 'launch-status' }))
vi.mock('./dialog', () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock('@/util/inject', () => ({ injection: () => context }))

const status = shallowRef(new InstanceInstallStatus())
const context = {
  path: ref('instance'),
  instruction: ref<InstanceInstallInstruction | undefined>(undefined),
  instanceInstallStatus: status,
  resumeInstall: vi.fn(),
  isResumingInstall: () => false,
  isValidating: ref(false),
  unzipFileNotFound: ref(undefined),
  issue: ref<InstanceJavaIssue | undefined>(undefined),
  refresh: refreshJava,
}

describe('instance launch pending files', () => {
  beforeEach(() => {
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useI18n', () => ({
      t: (key: string, options?: unknown) => options ? `${key}:${JSON.stringify(options)}` : key,
    }))
    context.path.value = 'instance'
    status.value = Object.assign(new InstanceInstallStatus(), { instance: 'instance', pendingFileCount: 2 })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('updates the launch action when the same shared state object is mutated', () => {
    const menu = useInstanceLaunchMenuItems()
    expect(menu.issues.value & LaunchMenuItemIssue.PendingFiles).toBeTruthy()
    expect(menu.launchMenuItems.value).toHaveLength(1)
    expect(menu.launchMenuItems.value[0].description).toContain('"counts":2')

    status.value.pendingFileCountSet(1)
    triggerRef(status)
    expect(menu.launchMenuItems.value[0].description).toContain('"counts":1')

    status.value.pendingFileCountSet(0)
    triggerRef(status)
    expect(menu.issues.value & LaunchMenuItemIssue.PendingFiles).toBe(0)
    expect(menu.launchMenuItems.value).toHaveLength(0)

    status.value.pendingFileCount = 1
    triggerRef(status)
    expect(menu.issues.value & LaunchMenuItemIssue.PendingFiles).toBeTruthy()
    expect(menu.launchMenuItems.value).toHaveLength(1)
  })

  it('updates unresolved-file actions from in-place shared state mutations', () => {
    const menu = useInstanceLaunchMenuItems()
    expect(menu.hasUnresolvedFiles.value).toBe(false)
    status.value.unresolvedFiles = [{ path: 'mods/missing.jar', hashes: {} }]
    triggerRef(status)
    expect(menu.hasUnresolvedFiles.value).toBe(true)
    expect(menu.issues.value & LaunchMenuItemIssue.UnresolvedFiles).toBeTruthy()

    status.value.unresolvedFilesSet([])
    triggerRef(status)
    expect(menu.hasUnresolvedFiles.value).toBe(false)
    expect(menu.issues.value & LaunchMenuItemIssue.UnresolvedFiles).toBe(0)
  })

  it('updates unresolved-file actions when the same array is mutated', () => {
    const menu = useInstanceLaunchMenuItems()
    expect(menu.hasUnresolvedFiles.value).toBe(false)

    status.value.unresolvedFiles.push({ path: 'mods/missing.jar', hashes: {} })
    triggerRef(status)
    expect(menu.hasUnresolvedFiles.value).toBe(true)
    expect(menu.issues.value & LaunchMenuItemIssue.UnresolvedFiles).toBeTruthy()

    status.value.unresolvedFiles.splice(0)
    triggerRef(status)
    expect(menu.hasUnresolvedFiles.value).toBe(false)
    expect(menu.issues.value & LaunchMenuItemIssue.UnresolvedFiles).toBe(0)
  })

  it('does not carry pending actions over to a different selected instance', () => {
    const menu = useInstanceLaunchMenuItems()
    expect(menu.issues.value & LaunchMenuItemIssue.PendingFiles).toBeTruthy()

    context.path.value = 'other-instance'
    expect(menu.issues.value).toBe(LaunchMenuItemIssue.None)
    expect(menu.launchMenuItems.value).toHaveLength(0)

    status.value.instance = 'other-instance'
    triggerRef(status)
    expect(menu.issues.value & LaunchMenuItemIssue.PendingFiles).toBeTruthy()
  })
})

describe('instance launch missing java', () => {
  const requiredJava = { component: 'java-runtime-gamma', majorVersion: 17 }

  beforeEach(() => {
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useI18n', () => ({
      t: (key: string, options?: unknown) => options ? `${key}:${JSON.stringify(options)}` : key,
    }))
    context.path.value = 'instance'
    context.issue.value = 'missing'
    context.instruction.value = {
      instance: 'instance',
      runtime: { minecraft: '1.20.1' },
      version: '1.20.1',
      java: requiredJava,
    }
    installJava.mockResolvedValue({ path: '/java/17', version: '17.0.1', majorVersion: 17 })
    refreshJava.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('auto-installs the required java when the missing-java item is clicked', async () => {
    const menu = useInstanceLaunchMenuItems()
    expect(menu.issues.value & LaunchMenuItemIssue.MissingJava).toBeTruthy()

    const item = menu.launchMenuItems.value.find((i) => i.title === 'diagnosis.missingJava.name')
    expect(item).toBeTruthy()
    expect(item?.onClick).toBeTruthy()

    await item?.onClick?.()

    expect(installJava).toHaveBeenCalledWith({ type: 'java', target: requiredJava })
    expect(refreshJava).toHaveBeenCalledWith(true)
  })

  it('falls back to the launch status dialog when the java install fails', async () => {
    installJava.mockRejectedValue(new Error('download failed'))
    const menu = useInstanceLaunchMenuItems()

    const item = menu.launchMenuItems.value.find((i) => i.title === 'diagnosis.missingJava.name')
    await item?.onClick?.()

    expect(installJava).toHaveBeenCalledWith({ type: 'java', target: requiredJava })
    expect(refreshJava).not.toHaveBeenCalled()
  })
})
