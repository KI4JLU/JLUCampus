import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { AdminComponent } from '@justcampus/shared'
import { ApiRequestError } from './api'
import {
  initialFormState,
  isFormDirty,
  selectableTypes,
  serverFieldErrors,
  validateComponentForm
} from './component-form'

// Messages come back as their keys, so the tests see which one was chosen.
const t = ((key: string) => key) as unknown as TFunction

const translator: AdminComponent = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Übersetzer',
  nameTranslations: { en: 'Translator' },
  icon: null,
  iconUrl: null,
  enabled: false,
  sortOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
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
  secrets: { deeplApiKey: false, llmApiKey: false }
}

describe('selectableTypes', () => {
  it('offers only ordinary types for new and ordinary components', () => {
    expect(selectableTypes(null)).toEqual(['iframe', 'rss', 'link'])
    expect(
      selectableTypes({
        ...translator,
        type: 'link',
        config: { url: 'https://x.org' },
        secrets: {}
      })
    ).toEqual(['iframe', 'rss', 'link'])
  })

  it('keeps a module on its own type', () => {
    expect(selectableTypes(translator)).toEqual(['translator'])
  })

  it('keeps a desktop component on its own type', () => {
    expect(selectableTypes({ ...translator, type: 'files', config: {}, secrets: {} })).toEqual([
      'files'
    ])
  })
})

describe('initialFormState', () => {
  it('has a field per language, empty where the component has no translation', () => {
    expect(initialFormState(translator).nameTranslations).toEqual({ de: '', en: 'Translator' })
    expect(initialFormState(null).nameTranslations).toEqual({ de: '', en: '' })
  })
})

describe('isFormDirty', () => {
  const baseline = initialFormState(translator)

  it('sees a changed field, deep inside the config too', () => {
    expect(isFormDirty(baseline, baseline)).toBe(false)
    expect(isFormDirty({ ...baseline, name: 'Translator' }, baseline)).toBe(true)
    expect(
      isFormDirty(
        { ...baseline, nameTranslations: { de: 'Übersetzer', en: 'Translator' } },
        baseline
      )
    ).toBe(true)
    expect(
      isFormDirty(
        {
          ...baseline,
          config: { ...translator.config, llmModels: [{ id: 'llama', label: 'Llama' }] }
        },
        baseline
      )
    ).toBe(true)
  })

  it('forgets an edit that was undone', () => {
    const edited = { ...baseline, name: 'Translator', config: { ...translator.config } }
    expect(isFormDirty({ ...edited, name: translator.name }, baseline)).toBe(false)
  })

  it('counts a secret only when saving would change it', () => {
    expect(
      isFormDirty(
        { ...baseline, secrets: { deeplApiKey: { value: ' ', remove: false } } },
        baseline
      )
    ).toBe(false)
    expect(
      isFormDirty(
        { ...baseline, secrets: { deeplApiKey: { value: 'key', remove: false } } },
        baseline
      )
    ).toBe(true)
    expect(
      isFormDirty({ ...baseline, secrets: { llmApiKey: { value: '', remove: true } } }, baseline)
    ).toBe(true)
  })
})

describe('validateComponentForm', () => {
  it('sends secrets only when one changed', () => {
    const state = initialFormState(translator)
    const unchanged = validateComponentForm(state, t)
    expect(unchanged.ok && 'secrets' in unchanged.input).toBe(false)

    const changed = validateComponentForm(
      { ...state, secrets: { deeplApiKey: { value: ' key ', remove: false } } },
      t
    )
    expect(changed).toMatchObject({ ok: true, input: { secrets: { deeplApiKey: 'key' } } })
  })

  it('sends only the translations that were filled in', () => {
    const result = validateComponentForm(
      { ...initialFormState(translator), nameTranslations: { de: ' Übersetzer ', en: '  ' } },
      t
    )
    expect(result.ok && result.input.nameTranslations).toEqual({ de: 'Übersetzer' })
  })

  it('reports an overlong translation on its field', () => {
    const result = validateComponentForm(
      { ...initialFormState(translator), nameTranslations: { de: '', en: 'x'.repeat(81) } },
      t
    )
    expect(result).toEqual({
      ok: false,
      errors: { 'nameTranslations.en': 'admin.form.errors.name' }
    })
  })

  it('reports an overlong secret on its field', () => {
    const result = validateComponentForm(
      {
        ...initialFormState(translator),
        secrets: { deeplApiKey: { value: 'x'.repeat(5000), remove: false } }
      },
      t
    )
    expect(result).toEqual({
      ok: false,
      errors: { 'secrets.deeplApiKey': 'admin.form.errors.secret' }
    })
  })

  it('names the translator fields in its messages, rows of the model list included', () => {
    const result = validateComponentForm(
      {
        ...initialFormState(translator),
        config: {
          defaultTargetLanguage: 'en-gb',
          deeplApiUrl: 'http://api.deepl.com',
          llmBaseUrl: null,
          llmModels: [
            { id: 'llama', label: 'Llama' },
            { id: ' ', label: 'Mistral' }
          ],
          llmProviderName: null,
          defaultEngine: null,
          documentsEnabled: false
        }
      },
      t
    )
    expect(result).toEqual({
      ok: false,
      errors: {
        'config.deeplApiUrl': 'admin.form.errors.url',
        'config.llmModels.1.id': 'component.translator.configErrors.modelId'
      }
    })
  })
})

describe('serverFieldErrors', () => {
  it('maps a rejected secret onto its field', () => {
    const error = new ApiRequestError(400, {
      error: {
        code: 'validation',
        message: 'Invalid',
        issues: [{ path: ['secrets', 'deeplApiKey'], message: 'Too long' }]
      }
    })
    expect(serverFieldErrors(error, 'translator', t)).toEqual({
      'secrets.deeplApiKey': 'admin.form.errors.secret'
    })
  })
})
