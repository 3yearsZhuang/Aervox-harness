import type {LLMConfigDto, LLMProviderType, PresetProviderInfo} from '@aervox/api-client'

export function applyOnboardingProvider(
  draft: LLMConfigDto,
  providerType: LLMProviderType,
  preset?: PresetProviderInfo,
): LLMConfigDto {
  return {
    ...draft,
    providerType,
    baseUrl: preset?.defaultBaseUrl ?? draft.baseUrl,
    modelId: preset?.recommendedModels[0] ?? draft.modelId,
  }
}

export function validateOnboardingModel(draft: LLMConfigDto, requiresApiKey: boolean): string | null {
  if (!draft.baseUrl.trim()) return '请填写服务 Base URL'
  if (!draft.modelId.trim()) return '请填写模型 ID'
  if (requiresApiKey && !draft.apiKey?.trim()) return '当前服务需要 API Key'
  return null
}
