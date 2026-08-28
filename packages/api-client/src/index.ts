/** Aervox｜思隅 @aervox/api-client 入口 */
export {
  configureAervoxClient,
  getTransport,
  getSessionId,
  getApiBase,
  createFetchTransport,
  type AervoxTransport,
  type AervoxClientConfig,
  type TurnCallbacks,
} from './transport';
export { desktopTransport } from './desktop-transport';
export { useAervoxApi, type GoalDto, type ReviewItemDto, type NotificationDto, type DiaryDto } from './useAervoxApi';
export { useAervoxPlugins, type PluginSummaryDto, type PluginPageDto } from './useAervoxPlugins';
export {
  useAervoxPersonas,
  type PersonaDto,
  type PersonaRevisionDto,
  type PersonaRevisionConfigDto,
  type ActivePersonaSelectionDto,
  type CreatePersonaInputDto,
  type UpdatePersonaInputDto,
  type ToolItemDto,
  type SkillItemDto,
} from './useAervoxPersonas';
export { streamAervoxTurn, type StreamAervoxTurnCallbacks } from './useAervoxTurn';
export {
  useAervoxVoice,
  canPickDirectory,
  basenameOf,
  type LocalVoiceConfigDto,
  type VoiceModelDto,
  type VoiceSynthesisInput,
  type VoiceSynthesisResultDto,
} from './useAervoxVoice';
export {
  useAervoxLLM,
  PRESET_PROVIDERS,
  type LLMProviderType,
  type LLMConfigDto,
  type LLMTestConnectionInput,
  type LLMTestConnectionResultDto,
  type PresetProviderInfo,
} from './useAervoxLLM';
