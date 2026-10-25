import { z } from 'zod';
import type { ApiEndpoint } from './http-api.js';
import { skillRegistrationResponseSchema } from './skills-api.js';
import {
  personaSchema, personaRevisionSchema, activePersonaSelectionSchema,
  createPersonaRequestSchema, updatePersonaRequestSchema, activatePersonaRequestSchema,
  importPersonaRequestSchema, personaBundleResponseSchema,
} from './persona-schemas.js';

export const personaListResponseSchema = z.object({
  personas: z.array(personaSchema), active: activePersonaSelectionSchema.nullable(),
});
export const personaDetailResponseSchema = z.object({
  persona: personaSchema, revision: personaRevisionSchema.nullable(), active: z.boolean(),
});
export const personaMutationResponseSchema = z.object({ persona: personaSchema, revision: personaRevisionSchema });
export const personaImportResponseSchema = personaMutationResponseSchema.extend({
  skills: z.array(skillRegistrationResponseSchema.pick({name: true, description: true, checksum: true})),
  missingDependencies: z.array(z.string()),
});
export type CreatePersonaRequest = z.input<typeof createPersonaRequestSchema>;
export type UpdatePersonaRequest = z.input<typeof updatePersonaRequestSchema>;
export type PersonaListResponse = z.output<typeof personaListResponseSchema>;
export type PersonaDetailResponse = z.output<typeof personaDetailResponseSchema>;
export type PersonaMutationResponse = z.output<typeof personaMutationResponseSchema>;
export type PersonaImportResponse = z.output<typeof personaImportResponseSchema>;
export type PersonaBundleResponse = z.output<typeof personaBundleResponseSchema>;

const params = z.object({ personaId: z.string().min(1) });
export const personaApi = {
  list: { method: 'get', path: '/v1/personas', operationId: 'get_v1_personas', summary: '列出人格', tags: ['Persona'], response: personaListResponseSchema },
  create: { method: 'post', path: '/v1/personas', operationId: 'post_v1_personas', summary: '创建人格', tags: ['Persona'], body: createPersonaRequestSchema, response: personaMutationResponseSchema, status: 201, validationErrorCode: 'INVALID_PERSONA', errors: {400: 'INVALID_PERSONA'} },
  get: { method: 'get', path: '/v1/personas/{personaId}', operationId: 'get_v1_personas_personaId', summary: '读取人格', tags: ['Persona'], params, response: personaDetailResponseSchema, errors: {404: 'PERSONA_NOT_FOUND'} },
  update: { method: 'patch', path: '/v1/personas/{personaId}', operationId: 'patch_v1_personas_personaId', summary: '创建人格新修订', tags: ['Persona'], params, body: updatePersonaRequestSchema, response: personaMutationResponseSchema, validationErrorCode: 'INVALID_PERSONA', errors: {400: 'INVALID_PERSONA', 404: 'PERSONA_NOT_FOUND', 409: 'PERSONA_REVISION_CONFLICT'} },
  delete: { method: 'delete', path: '/v1/personas/{personaId}', operationId: 'delete_v1_personas_personaId', summary: '归档人格', tags: ['Persona'], params, response: z.object({deleted: z.boolean(), personaId: z.string()}), errors: {404: 'PERSONA_NOT_FOUND'} },
  activate: { method: 'post', path: '/v1/personas/{personaId}/activate', operationId: 'post_v1_personas_personaId_activate', summary: '激活人格', tags: ['Persona'], params, body: activatePersonaRequestSchema.optional(), response: activePersonaSelectionSchema, validationErrorCode: 'INVALID_PERSONA', errors: {400: 'INVALID_PERSONA', 404: 'PERSONA_NOT_FOUND'} },
  export: { method: 'post', path: '/v1/personas/{personaId}/export', operationId: 'post_v1_personas_personaId_export', summary: '导出人格及实际生效 Skills', tags: ['Persona'], params, response: personaBundleResponseSchema, errors: {404: 'EXPORT_FAILED', 500: 'EXPORT_FAILED'} },
  import: { method: 'post', path: '/v1/personas/import', operationId: 'post_v1_personas_import', summary: '导入人格及 Skills', tags: ['Persona'], body: importPersonaRequestSchema, response: personaImportResponseSchema, status: 201, validationErrorCode: 'INVALID_BUNDLE', errors: {400: 'INVALID_BUNDLE', 409: 'SKILL_CONFLICT'} },
} as const satisfies Record<string, ApiEndpoint>;
