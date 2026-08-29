import {describe, expect, it} from 'vitest'
import type {LLMConfigDto, PresetProviderInfo} from '@aervox/api-client'
import {applyOnboardingProvider, validateOnboardingModel} from '../src/renderer/src/onboarding-model.js'

const draft: LLMConfigDto = {
  enabled: true,
  providerType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelId: 'llama3.2',
  temperature: 0.7,
  maxTokens: 4096,
  settings: {},
}

describe('desktop onboarding model configuration', () => {
  it('切换提供商时应用其端点和首个推荐模型', () => {
    const preset: PresetProviderInfo = {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'test',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
      requiresApiKey: true,
    }
    expect(applyOnboardingProvider(draft, 'deepseek', preset)).toMatchObject({
      providerType: 'deepseek',
      baseUrl: preset.defaultBaseUrl,
      modelId: 'deepseek-chat',
    })
  })

  it('按顺序拒绝缺失的端点、模型和必填密钥', () => {
    expect(validateOnboardingModel({...draft, baseUrl: '  ', modelId: '', apiKey: ''}, true)).toBe('请填写服务 Base URL')
    expect(validateOnboardingModel({...draft, modelId: '  ', apiKey: ''}, true)).toBe('请填写模型 ID')
    expect(validateOnboardingModel({...draft, apiKey: '  '}, true)).toBe('当前服务需要 API Key')
  })

  it('本地或可选密钥提供商允许空密钥', () => {
    expect(validateOnboardingModel({...draft, apiKey: ''}, false)).toBeNull()
  })
})
