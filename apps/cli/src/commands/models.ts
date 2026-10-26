import { createReadStream } from 'node:fs';
import { createLLMConfigClient } from '@aervox/api-client/transport';
import { CliError, identifier } from '../config.js';
import { readStreamInput } from '../input.js';
import { terminalText } from '../output.js';
import type { CommandContext } from './types.js';

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
const usage = () => new CliError('usage', '使用 models providers、config show/set --file、test --file 或 presets list/create/activate/delete；配置与密钥不接受命令行参数。', 2);

function secretsIn(values: unknown[], environmentKey?: string): string[] {
  return [...new Set([environmentKey, ...values.map(value => fields(value).apiKey)]
    .filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
function encodedSecretPattern(value: string): RegExp {
  // Hex digits in escapes are case-insensitive; ordinary key text is not.
  // Repeated %25 layers encode a percent sign without changing the secret.
  const pattern = value.replace(/%[0-9A-F]{2}|[.*+?^${}()|[\]\\]/g, token => token.startsWith('%')
    ? `%(?:25)*${token.slice(1).replace(/[A-F]/g, hex => `[${hex}${hex.toLowerCase()}]`)}`
    : `\\${token}`);
  return new RegExp(pattern, 'g');
}
function redact(value: string, secrets: string[]): string {
  let text = terminalText(value);
  for (const secret of secrets) {
    text = text.split(secret).join('[redacted]');
    try {
      for (const encoded of new Set([encodeURIComponent(secret), encodeURI(secret)])) {
        text = text.replace(encodedSecretPattern(encoded), '[redacted]');
      }
    } catch {
      // Invalid Unicode still receives exact redaction.
    }
  }
  return text.replace(/[\r\n\t]/g, ' ').slice(0, 200);
}
function containsEncodedSecret(value: string, secrets: string[]): boolean {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (secrets.some(secret => decoded.includes(secret))) return true;
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, sequence => {
      try { return decodeURIComponent(sequence); } catch { return sequence; }
    });
    if (next === decoded) {
      // An undecodable byte sequence cannot be safely inspected for secrets.
      return /%[0-9a-f]{2}/i.test(decoded);
    }
    decoded = next;
  }
  // Bound normalization even for nested encodings supplied by the service.
  return secrets.some(secret => decoded.includes(secret)) || /%[0-9a-f]{2}/i.test(decoded);
}
function safeUrl(value: unknown, secrets: string[]): string {
  if (typeof value !== 'string') return '[unavailable]';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[unavailable]';
    const path = containsEncodedSecret(url.pathname, secrets) ? '/[redacted]' : url.pathname;
    return redact(url.origin + path, secrets);
  } catch { return '[unavailable]'; }
}
function safeLabel(value: unknown, secrets: string[]): string {
  if (typeof value !== 'string') return '[unavailable]';
  if (value.includes('://')) return safeUrl(value, secrets);
  if (value.includes('@') || containsEncodedSecret(value, secrets)) return '[redacted]';
  return redact(value.split(/[?#]/, 1)[0]!, secrets);
}
function safeId(value: unknown, secrets: string[]): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? redact(value, secrets) : '[unavailable]';
}
function configSummary(value: unknown, secrets: string[]): Fields {
  const config = fields(value);
  return {
    enabled: config.enabled, providerType: safeId(config.providerType, secrets),
    baseUrl: safeUrl(config.baseUrl, secrets), modelId: safeLabel(config.modelId, secrets),
    temperature: config.temperature, maxTokens: config.maxTokens,
    apiKeyConfigured: typeof config.apiKey === 'string' && config.apiKey.trim().length > 0,
  };
}
function presetSummary(value: unknown, secrets: string[]): Fields {
  const preset = fields(value);
  return { id: safeId(preset.id, secrets), name: safeLabel(preset.name, secrets), isActive: preset.isActive, ...configSummary(preset, secrets) };
}

async function readModelFile(ctx: CommandContext, signal: AbortSignal): Promise<unknown> {
  if (!ctx.options.file) throw usage();
  try {
    const payload: unknown = JSON.parse(await readStreamInput(createReadStream(ctx.options.file), signal));
    if (ctx.io.env.SIYU_MODEL_API_KEY === undefined) return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_payload');
    return { ...payload, apiKey: ctx.io.env.SIYU_MODEL_API_KEY };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CliError) throw error;
    throw new CliError('invalid_model_config', '无法读取模型 JSON 配置；请检查文件格式与路径。', 2);
  }
}

/** Shared client validates requests/responses; the CLI only emits whitelisted summaries. */
export async function executeModels(ctx: CommandContext): Promise<number> {
  const args = ctx.positionals.slice(1);
  const inputCommand = (args[0] === 'config' && args[1] === 'set' && args.length === 2)
    || (args[0] === 'test' && args.length === 1)
    || (args[0] === 'presets' && args[1] === 'create' && args.length === 3);
  if (ctx.options.file !== undefined && !inputCommand) throw usage();
  const client = createLLMConfigClient(ctx.transport);
  const signal = ctx.track.currentSignal ?? ctx.timedSignal();
  const environmentKey = ctx.io.env.SIYU_MODEL_API_KEY;
  try {
    if (args[0] === 'providers' && args.length === 1) {
      const result = await client.providers(signal);
      const secrets = secretsIn([], environmentKey);
      await ctx.output.value({ generation: result.generation, providers: result.providers.map(provider => ({
        id: safeId(provider.id, secrets), protocol: provider.protocol,
        defaultBaseUrl: safeUrl(provider.defaultBaseUrl, secrets),
        requiresApiKey: provider.requiresApiKey, isLocal: provider.isLocal, available: provider.available,
      })) });
      return 0;
    }
    if (args[0] === 'config' && args[1] === 'show' && args.length === 2) {
      const result = await client.getConfig(signal);
      await ctx.output.value(configSummary(result, secretsIn([result], environmentKey)));
      return 0;
    }
    if (args[0] === 'config' && args[1] === 'set' && args.length === 2) {
      const input = await readModelFile(ctx, signal);
      const result = await client.saveConfig(input, signal);
      await ctx.output.value({ saved: true, ...configSummary(result, secretsIn([input, result], environmentKey)) });
      return 0;
    }
    if (args[0] === 'test' && args.length === 1) {
      const input = await readModelFile(ctx, signal);
      const result = await client.testConnection(input, signal);
      await ctx.output.value({ ok: result.ok, latencyMs: result.latencyMs,
        availableModelCount: result.availableModels?.length,
        capabilities: result.capabilities ? {
          contextWindow: result.capabilities.contextWindow, supportsToolCalls: result.capabilities.supportsToolCalls,
        } : undefined,
      });
      return result.ok ? 0 : 1;
    }
    if (args[0] === 'presets' && args[1] === 'list' && args.length === 2) {
      const result = await client.listPresets(signal);
      const secrets = secretsIn(result.presets, environmentKey);
      await ctx.output.value({ activeId: result.activeId === null ? null : safeId(result.activeId, secrets),
        presets: result.presets.map(preset => presetSummary(preset, secrets)) });
      return 0;
    }
    if (args[0] === 'presets' && args[1] === 'create' && args.length === 3) {
      const input = await readModelFile(ctx, signal);
      const result = await client.createPreset(args[2]!, input, signal);
      await ctx.output.value({ created: true, preset: presetSummary(result, secretsIn([input, result], environmentKey)) });
      return 0;
    }
    if (args[0] === 'presets' && args.length === 3 && ['activate', 'delete'].includes(args[1]!)) {
      const presetId = identifier(args[2]!);
      if (args[1] === 'activate') {
        const result = await client.activatePreset(presetId, signal);
        await ctx.output.value({ activated: result.isActive, preset: presetSummary(result, secretsIn([result], environmentKey)) });
        return result.isActive ? 0 : 1;
      } else {
        const result = await client.deletePreset(presetId, signal);
        await ctx.output.value({ deleted: result.deleted, presetId: safeId(presetId, secretsIn([], environmentKey)) });
        return result.deleted ? 0 : 1;
      }
    }
    throw usage();
  } catch (error) {
    if ((error as Error).name === 'ZodError') {
      throw new CliError('invalid_model_config', '模型配置或服务响应不符合共享契约；请检查 JSON 配置和服务版本。', 2);
    }
    throw error;
  }
}
