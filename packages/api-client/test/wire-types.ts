import type { McpPresetServer, McpServerConfig, McpServerToolEntry, LocalVoiceConfigDraft, RemoteVoiceConfigDraft, VoiceInputConfigInput, VoiceInputConfigOutput, VoicePreset, VoicePresetReceipt } from '@aervox/contracts';
import type { McpPresetDto, McpServerConfigDto, McpServerToolDto } from '../src/useAervoxMcp.js';
import type { LocalVoiceConfigDto, RemoteVoiceConfigDto, VoicePresetDto, VoiceInputConfigRefDto, useAervoxVoice } from '../src/useAervoxVoice.js';
import type { VoiceInputConfigDto } from '../src/useAervoxVoiceInput.js';
import type { CreatePersonaRequest, UpdatePersonaRequest, PersonaDetailResponse, PersonaMutationResponse, PersonaImportResponse } from '@aervox/contracts';
import type { CreatePersonaInputDto, UpdatePersonaInputDto, useAervoxPersonas } from '../src/useAervoxPersonas.js';

type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;
export type WireAliases = [
  Assert<Same<McpPresetDto, McpPresetServer>>,
  Assert<Same<McpServerConfigDto, McpServerConfig>>,
  Assert<Same<McpServerToolDto, McpServerToolEntry>>,
  Assert<Same<LocalVoiceConfigDto, LocalVoiceConfigDraft>>,
  Assert<Same<RemoteVoiceConfigDto, RemoteVoiceConfigDraft>>,
  Assert<Same<VoiceInputConfigDto, VoiceInputConfigInput>>,
  Assert<Same<VoiceInputConfigRefDto, VoiceInputConfigOutput>>,
  Assert<Same<VoicePresetDto, VoicePreset>>,
  Assert<Same<Awaited<ReturnType<ReturnType<typeof useAervoxVoice>['createPreset']>>, VoicePresetReceipt>>,
  Assert<Same<Awaited<ReturnType<ReturnType<typeof useAervoxVoice>['activatePreset']>>, VoicePresetReceipt>>,
  Assert<Same<CreatePersonaInputDto, CreatePersonaRequest>>,
  Assert<Same<UpdatePersonaInputDto, UpdatePersonaRequest>>,
  Assert<Same<Awaited<ReturnType<ReturnType<typeof useAervoxPersonas>['getPersonaDetail']>>, PersonaDetailResponse>>,
  Assert<Same<Awaited<ReturnType<ReturnType<typeof useAervoxPersonas>['createPersona']>>, PersonaMutationResponse>>,
  Assert<Same<Awaited<ReturnType<ReturnType<typeof useAervoxPersonas>['importPersona']>>, PersonaImportResponse>>,
];
