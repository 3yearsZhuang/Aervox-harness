/** Aervox｜思隅 @aervox/api-client 入口 */
export {
  configureAervoxClient,
  getTransport,
  getSessionId,
  getApiBase,
  createFetchTransport,
  type AervoxTransport,
  type AervoxClientConfig,
  type StreamTurnOptions,
  type TurnCallbacks,
  type AttachmentUploadInput,
  type UploadedAttachment,
} from './transport';
export { desktopTransport } from './desktop-transport';
export {
  useAervoxApi,
  type GoalDto,
  type ReviewItemDto,
  type LearningPlanDto,
  type PlanMilestoneDto,
  type PlanTaskDto,
} from './useAervoxApi';
export { useAervoxPlugins, type PluginSummaryDto, type PluginPageDto } from './useAervoxPlugins';
export {
  useAervoxSkills,
  type SkillDto,
  type SkillInstallResultDto,
} from './useAervoxSkills';
export {
  useAervoxTools,
  type ToolRegistrationDto,
  type RegisterToolInputDto,
  type McpToolListItemDto,
  type McpCallToolResultDto,
} from './useAervoxTools';
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
export { streamAervoxTurn, uploadAervoxAttachment, submitQuestionAnswers, exploreTerm, decideToolApproval, type StreamAervoxTurnCallbacks } from './useAervoxTurn';
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
export {
  useAervoxVoiceInput,
  type VoiceInputEngineType,
  type VoiceInputConfigDto,
  type VoiceTranscribeResultDto,
  type VoiceInputModelStatusDto,
  type VoiceInputModelDownloadResultDto,
} from './useAervoxVoiceInput';
export {
  VoiceInputRecorder,
  type VoiceInputRecorderOptions,
} from './voice-input-recorder';
