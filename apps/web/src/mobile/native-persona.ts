/** 人格（persona）在手机上的本地读写。
 *
 * 桌面/API 侧的人格路由（host-runtime 的 companion/persona 模块）仍是语义真源，
 * 这里只把同一组契约方法落到本机 SQLite：列表、详情、新建、修订、激活。
 * 修订校验和必须与桌面端同算法（sha256 over JSON.stringify(config)），
 * 否则同一份配置在两个宿主上会算出不同的 checksum。
 */
import { AervoxHttpError } from '@aervox/api-client';
import {
  activatePersonaRequestSchema,
  createPersonaRequestSchema,
  updatePersonaRequestSchema,
} from '@aervox/contracts';
import type { IPersonaRepository, LocalContext } from '@aervox/repositories/persona';

const fail = (status: number, code: string): never => {
  throw new AervoxHttpError(status, 'native', { code, message: code });
};

let seq = 0;
const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

type PersonaRepoPort = Pick<
  IPersonaRepository,
  'listPersonas' | 'getPersona' | 'getPersonaRevision' | 'createPersona' | 'updatePersona' | 'activatePersona' | 'getActivePersona'
>;

export interface PersonaRouteDeps {
  repo: PersonaRepoPort;
  ctx: LocalContext;
  /** 与桌面端一致的修订校验和：sha256(JSON.stringify(config)) */
  checksum: (config: unknown) => string;
}

export type PersonaRouteResult = { handled: true; result: unknown } | { handled: false };

const identifier = (value: string) => {
  if (!value || value.length > 128 || value.includes('\0')) return fail(400, 'INVALID_IDENTIFIER');
  return value;
};

export function createPersonaRouteHandler({ repo, ctx, checksum }: PersonaRouteDeps) {
  return async function handlePersonaRoute(
    method: string,
    url: URL,
    body: unknown,
  ): Promise<PersonaRouteResult> {
    const path = url.pathname;

    // ── 列表：当前启用的人格随列表一起返回，避免二次往返 ─────────────
    if (path === '/v1/personas' && method === 'GET') {
      const [personas, active] = await Promise.all([repo.listPersonas(ctx), repo.getActivePersona(ctx)]);
      return { handled: true, result: { personas, active: active ?? null } };
    }

    if (path === '/v1/personas' && method === 'POST') {
      const parsed = createPersonaRequestSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_PERSONA');
      const created = await repo.createPersona(ctx, {
        id: id('persona'),
        name: parsed.data.name.trim(),
        description: parsed.data.description?.trim() ?? '',
        source: 'user_created',
        config: parsed.data.config,
        checksum: checksum(parsed.data.config),
      });
      return { handled: true, result: created };
    }

    const detail = /^\/v1\/personas\/([^/]+)$/.exec(path);
    if (detail && method === 'GET') {
      const personaId = identifier(decodeURIComponent(detail[1]!));
      const persona = await repo.getPersona(ctx, personaId);
      if (!persona) return fail(404, 'PERSONA_NOT_FOUND');
      const [revision, active] = await Promise.all([
        repo.getPersonaRevision(ctx, personaId, persona.currentRevisionId),
        repo.getActivePersona(ctx),
      ]);
      return { handled: true, result: { persona, revision: revision ?? null, active: active?.personaId === personaId } };
    }

    if (detail && method === 'PATCH') {
      const personaId = identifier(decodeURIComponent(detail[1]!));
      const parsed = updatePersonaRequestSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_PERSONA');
      try {
        const updated = await repo.updatePersona(ctx, {
          personaId,
          expectedRevision: parsed.data.expectedRevision,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description.trim() } : {}),
          config: parsed.data.config,
          checksum: checksum(parsed.data.config),
        });
        if (!updated) return fail(404, 'PERSONA_NOT_FOUND');
        return { handled: true, result: updated };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'INVALID_PERSONA';
        return fail(message === 'PERSONA_REVISION_CONFLICT' ? 409 : 400, message);
      }
    }

    const activate = /^\/v1\/personas\/([^/]+)\/activate$/.exec(path);
    if (activate && method === 'POST') {
      const personaId = identifier(decodeURIComponent(activate[1]!));
      const parsed = activatePersonaRequestSchema.safeParse(body ?? {});
      if (!parsed.success) return fail(400, 'INVALID_PERSONA');
      const selection = await repo.activatePersona(ctx, personaId, parsed.data.revisionId);
      if (!selection) return fail(404, 'PERSONA_NOT_FOUND');
      return { handled: true, result: selection };
    }

    return { handled: false };
  };
}
