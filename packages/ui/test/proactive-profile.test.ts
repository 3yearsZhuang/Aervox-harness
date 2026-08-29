import {describe, expect, it} from 'vitest'
import {
  PROFILE_CAPABILITY_CATALOG,
  PROFILE_SOURCE_IDS,
  deriveProfileEffectiveState,
  hasAllRequiredProfileCapabilities,
  type ProfileCapabilityState,
} from '@aervox/contracts/proactive'

function capabilities(status: ProfileCapabilityState['osStatus'] = 'granted'): ProfileCapabilityState[] {
  return PROFILE_CAPABILITY_CATALOG.map((entry) => ({
    ...entry,
    osStatus: status,
    lastVerifiedAt: '2026-08-29T00:00:00.000Z',
  }))
}

const readyHost = {available: true, trusted: true, localReady: true}
const activation = {
  epoch: 'epoch-test',
  expiresAt: '2026-08-29T01:00:00.000Z',
  lastHeartbeatAt: '2026-08-29T00:00:00.000Z',
}

describe('CAP-033 profile authorization contract', () => {
  it('enumerates every full-profile source and action scope', () => {
    expect(PROFILE_SOURCE_IDS).toContain('device.browser_activity')
    expect(PROFILE_SOURCE_IDS).toContain('filesystem.full_disk_watch')
    expect(PROFILE_SOURCE_IDS).toContain('action.local')
    expect(PROFILE_SOURCE_IDS).toContain('action.external')
    expect(PROFILE_SOURCE_IDS).toContain('action.privileged')
    expect(PROFILE_SOURCE_IDS).toContain('action.irreversible')
    expect(PROFILE_CAPABILITY_CATALOG.every((entry) => entry.required)).toBe(true)
  })

  it('requires an actual granted snapshot for every required source', () => {
    const snapshot = capabilities()
    expect(hasAllRequiredProfileCapabilities(snapshot)).toBe(true)
    snapshot[0] = {...snapshot[0], osStatus: 'unknown'}
    expect(hasAllRequiredProfileCapabilities(snapshot)).toBe(false)
  })

  it('keeps tool, desired, host and OS state axes separate', () => {
    expect(deriveProfileEffectiveState({
      desiredState: 'none',
      toolApprovalMode: 'full_access',
      host: readyHost,
      activation,
      capabilities: capabilities(),
    })).toBe('inactive')

    expect(deriveProfileEffectiveState({
      desiredState: 'enabled',
      toolApprovalMode: 'ask',
      host: readyHost,
      activation,
      capabilities: capabilities(),
    })).toBe('suspended')

    expect(deriveProfileEffectiveState({
      desiredState: 'enabled',
      toolApprovalMode: 'full_access',
      host: readyHost,
      activation,
      capabilities: capabilities('unknown'),
    })).toBe('limited')

    expect(deriveProfileEffectiveState({
      desiredState: 'enabled',
      toolApprovalMode: 'full_access',
      host: readyHost,
      capabilities: capabilities('unknown'),
    })).toBe('limited')

    expect(deriveProfileEffectiveState({
      desiredState: 'enabled',
      toolApprovalMode: 'full_access',
      host: readyHost,
      activation,
      capabilities: capabilities(),
    })).toBe('active')

    expect(deriveProfileEffectiveState({
      desiredState: 'enabled',
      toolApprovalMode: 'full_access',
      host: {...readyHost, trusted: false},
      activation,
      capabilities: capabilities(),
    })).toBe('suspended')
  })
})
