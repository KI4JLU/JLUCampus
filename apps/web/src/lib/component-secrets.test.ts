import { describe, expect, it } from 'vitest'
import type { AdminComponent, ComponentInput } from '@justcampus/shared'
import {
  applyComponentInput,
  isSecretSet,
  secretKeysOf,
  secretsPatch,
  secretStatus
} from './component-secrets'
import { toComponentInput } from './queries'

const stored = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Übersetzer',
  nameTranslations: { en: 'Translator' },
  icon: 'languages',
  iconUrl: null,
  enabled: false,
  sortOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const translator: AdminComponent = {
  ...stored,
  type: 'translator',
  config: {
    defaultTargetLanguage: 'en-gb',
    deeplApiUrl: null,
    llmBaseUrl: null,
    llmModels: [],
    llmProviderName: null,
    defaultEngine: null,
    documentsEnabled: false
  },
  secrets: { deeplApiKey: true, llmApiKey: false }
}

const iframe: AdminComponent = {
  ...stored,
  type: 'iframe',
  config: { url: 'https://example.org' },
  secrets: {}
}

describe('secretKeysOf', () => {
  it('lists the secrets of a type', () => {
    expect(secretKeysOf('translator')).toEqual(['deeplApiKey', 'llmApiKey'])
    expect(secretKeysOf('iframe')).toEqual([])
  })
})

describe('secretsPatch', () => {
  it('leaves secrets out when nothing changed', () => {
    expect(secretsPatch(['deeplApiKey'], {})).toBeUndefined()
    expect(
      secretsPatch(['deeplApiKey'], { deeplApiKey: { value: '', remove: false } })
    ).toBeUndefined()
    expect(
      secretsPatch(['deeplApiKey'], { deeplApiKey: { value: '   ', remove: false } })
    ).toBeUndefined()
  })

  it('sets a typed value and removes a marked secret', () => {
    expect(secretsPatch(['deeplApiKey'], { deeplApiKey: { value: 'key', remove: false } })).toEqual(
      {
        deeplApiKey: 'key'
      }
    )
    expect(secretsPatch(['deeplApiKey'], { deeplApiKey: { value: '', remove: true } })).toEqual({
      deeplApiKey: null
    })
  })

  it('ignores drafts for secrets the type does not keep', () => {
    expect(secretsPatch([], { deeplApiKey: { value: 'key', remove: false } })).toBeUndefined()
  })
})

describe('secretStatus', () => {
  it('reports the saved state without a change', () => {
    expect(secretStatus(true, undefined)).toBe('saved')
    expect(secretStatus(false, undefined)).toBe('unset')
    expect(secretStatus(true, { value: ' ', remove: false })).toBe('saved')
  })

  it('reports the pending change', () => {
    expect(secretStatus(true, { value: 'new', remove: false })).toBe('replace')
    expect(secretStatus(false, { value: 'new', remove: false })).toBe('set')
    expect(secretStatus(true, { value: '', remove: true })).toBe('remove')
    // Nothing to remove while no value is saved.
    expect(secretStatus(false, { value: '', remove: true })).toBe('unset')
  })
})

describe('isSecretSet', () => {
  it('reads the status from the admin component', () => {
    expect(isSecretSet(translator, 'deeplApiKey')).toBe(true)
    expect(
      isSecretSet(
        { ...translator, secrets: { deeplApiKey: false, llmApiKey: false } },
        'deeplApiKey'
      )
    ).toBe(false)
    expect(isSecretSet(iframe, 'deeplApiKey')).toBe(false)
    expect(isSecretSet(null, 'deeplApiKey')).toBe(false)
  })
})

describe('applyComponentInput', () => {
  it('keeps the secrets status when the input leaves secrets out', () => {
    const next = applyComponentInput(translator, { ...toComponentInput(translator), enabled: true })
    expect(next).toEqual({ ...translator, enabled: true })
  })

  it('follows secret changes without keeping their values', () => {
    const input: Extract<ComponentInput, { type: 'translator' }> = {
      name: translator.name,
      nameTranslations: translator.nameTranslations,
      icon: translator.icon,
      iconUrl: translator.iconUrl,
      enabled: translator.enabled,
      type: 'translator',
      config: translator.config
    }
    expect(
      applyComponentInput(translator, { ...input, secrets: { deeplApiKey: null } })
    ).toMatchObject({
      secrets: { deeplApiKey: false, llmApiKey: false }
    })
    const unset = { ...translator, secrets: { deeplApiKey: false, llmApiKey: false } }
    expect(
      applyComponentInput(unset, { ...input, secrets: { deeplApiKey: 'key' } }).secrets
    ).toEqual({
      deeplApiKey: true,
      llmApiKey: false
    })
  })
})

describe('toComponentInput', () => {
  it('never sends secrets, so a full replace keeps them', () => {
    expect(toComponentInput(translator)).toEqual({
      name: 'Übersetzer',
      nameTranslations: { en: 'Translator' },
      icon: 'languages',
      iconUrl: null,
      enabled: false,
      type: 'translator',
      config: translator.config
    })
  })
})
