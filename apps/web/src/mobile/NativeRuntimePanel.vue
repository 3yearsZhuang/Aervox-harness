<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Database, KeyRound, RefreshCw, Smartphone } from 'lucide-vue-next';
import { nativeRequest } from './native-channel';

interface RuntimeSummary { kind: 'runtime'; connectionEpoch: string; sqlite: 'ready'; mode: 'foreground' }
interface ModelSummary { kind: 'summary'; hasCredential: boolean; endpoint?: string; model?: string }
const runtime = ref<RuntimeSummary>();
const model = ref<ModelSummary>();
const loading = ref(true);
const configuring = ref(false);
const testing = ref(false);
const testFeedback = ref('');
const testFailed = ref(false);
const runtimeFailed = ref(false);
const modelFailed = ref(false);
const feedback = ref('');
let disposed = false;
let readGeneration = 0;
const modelStatus = computed(() => loading.value ? '正在读取…' : modelFailed.value ? '读取失败' : model.value?.hasCredential ? '已保存配置' : '未配置');
const modelHeading = computed(() => loading.value ? '正在读取模型配置' : modelFailed.value ? '检查你的模型服务' : model.value?.hasCredential ? model.value.model : '连接模型，开始对话');

function isRuntime(value: unknown): value is RuntimeSummary {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<RuntimeSummary>;
  return item.kind === 'runtime' && item.sqlite === 'ready' && item.mode === 'foreground'
    && typeof item.connectionEpoch === 'string' && item.connectionEpoch.length > 0;
}
function isModel(value: unknown): value is ModelSummary {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<ModelSummary>;
  return item.kind === 'summary' && typeof item.hasCredential === 'boolean'
    && (!item.hasCredential || typeof item.endpoint === 'string' && typeof item.model === 'string');
}
async function readStatus() {
  if (testing.value) return;
  const generation = ++readGeneration;
  loading.value = true;
  testFeedback.value = '';
  const [runtimeResult, modelResult] = await Promise.allSettled([
    nativeRequest({ op: 'runtime' }),
    nativeRequest({ op: 'model', operation: 'summary' }),
  ]);
  if (disposed || generation !== readGeneration) return;
  runtime.value = runtimeResult.status === 'fulfilled' && isRuntime(runtimeResult.value) ? runtimeResult.value : undefined;
  model.value = modelResult.status === 'fulfilled' && isModel(modelResult.value) ? modelResult.value : undefined;
  runtimeFailed.value = !runtime.value;
  modelFailed.value = !model.value;
  loading.value = false;
}
async function configureModel() {
  if (loading.value || configuring.value || testing.value) return;
  configuring.value = true;
  feedback.value = '';
  try {
    await nativeRequest({ op: 'model', operation: 'configure' });
    if (!disposed) await readStatus();
  } catch {
    if (!disposed) feedback.value = '原生模型设置未完成，请重试。';
  } finally { if (!disposed) configuring.value = false; }
}
function connectionError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'PROVIDER_AUTH_REJECTED': return '服务拒绝了密钥。请在模型设置中检查密钥与访问权限。';
    case 'PROVIDER_RATE_LIMITED': return '服务暂时限流，请稍后重试或检查服务额度。';
    case 'MODEL_NOT_CONFIGURED': return '请先保存模型地址、名称和密钥，再测试连接。';
    case 'NETWORK_UNAVAILABLE': return '无法连接模型服务。请检查手机网络与服务地址。';
    case 'NETWORK_TIMEOUT':
    case 'DEADLINE_EXCEEDED': return '模型服务响应超时，请检查网络后重试。';
    case 'REDIRECT_REJECTED': return '服务地址发生跳转，请在模型设置中填写最终 HTTPS 地址。';
    case 'CREDENTIAL_RECOVERY_REQUIRED': return '已保存的凭据暂不可用。请在模型设置中检查，原有凭据已保留。';
    case 'BUSY':
    case 'NATIVE_BUSY': return '已有请求正在运行，请等待回复结束后再测试。';
    case 'NATIVE_RECEIPT_UNKNOWN': return '未收到测试结果。请等待当前请求结束后重试。';
    case 'CANCELLED':
    case 'CONNECTION_TEST_CANCELLED':
    case 'MODEL_CANCELLED': return '测试已停止，请保持应用在前台后重试。';
    case 'EMPTY_MODEL_RESPONSE': return '服务已响应，但没有返回文本。请检查模型是否支持文本对话。';
    case 'INVALID_RESPONSE':
    case 'TRUNCATED_RESPONSE':
    case 'INVALID_TEST_RECEIPT': return '未收到有效的模型回复，请检查服务地址和模型名称。';
    default: return '连接测试未完成。请检查网络、模型名称和服务配置后重试。';
  }
}
async function testConnection() {
  if (loading.value || configuring.value || testing.value || !model.value?.hasCredential) return;
  testing.value = true;
  testFeedback.value = '';
  testFailed.value = false;
  try {
    const result = await nativeRequest({ op: 'model', operation: 'test' });
    if (disposed) return;
    if (result?.kind !== 'connection_test' || result.ok !== true || !Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) {
      throw new Error('INVALID_TEST_RECEIPT');
    }
    testFeedback.value = `测试连接成功 · ${result.latencyMs.toLocaleString('zh-CN')} ms`;
  } catch (error) {
    if (!disposed) { testFailed.value = true; testFeedback.value = connectionError(error); }
  } finally { if (!disposed) testing.value = false; }
}
onMounted(() => { void readStatus(); });
onBeforeUnmount(() => { disposed = true; readGeneration++; });
</script>

<template>
  <div class="native-runtime-panel" :aria-busy="loading || configuring || testing">
    <header class="runtime-heading">
      <div><h2>本机运行</h2><p>管理手机上的对话与连接。</p></div>
      <component :is="'md-icon-button'" type="button" aria-label="刷新运行状态" :disabled="loading || configuring || testing" @click="readStatus">
        <RefreshCw :size="24" aria-hidden="true" />
      </component>
    </header>
    <component v-if="loading" :is="'md-linear-progress'" indeterminate aria-label="正在读取本机状态" />

    <section class="runtime-model" aria-labelledby="runtime-model-title">
      <div class="runtime-model-label">
        <h3 id="runtime-model-title"><KeyRound :size="20" aria-hidden="true" />模型服务</h3>
        <span class="runtime-model-status" :class="{ 'runtime-error': modelFailed }" role="status">{{ modelStatus }}</span>
      </div>
      <h4 class="runtime-model-title">{{ modelHeading }}</h4>
      <p v-if="loading" class="runtime-model-description">正在检查已保存的配置，请稍候。</p>
      <p v-else-if="modelFailed" class="runtime-model-description runtime-error" role="alert">模型配置读取失败，可以刷新或打开原生设置检查。</p>
      <p v-else-if="model?.hasCredential" class="runtime-model-description runtime-endpoint">{{ model.endpoint }}</p>
      <p v-else class="runtime-model-description">填写服务地址、模型和密钥。完成后，返回对话页发送第一条消息。</p>
      <div class="runtime-model-actions">
        <component :is="'md-filled-tonal-button'" class="runtime-configure" type="button" :disabled="loading || configuring || testing" @click="configureModel">
          {{ configuring ? '正在打开…' : model?.hasCredential ? '管理模型服务' : '配置模型服务' }}
        </component>
        <component :is="'md-outlined-button'" class="runtime-test" type="button" :disabled="loading || configuring || testing || !model?.hasCredential" @click="testConnection">
          {{ testing ? '正在测试…' : '测试连接' }}
        </component>
      </div>
      <p class="runtime-test-note">测试会向已配置服务发送一条简短请求。</p>
      <component v-if="testing" :is="'md-linear-progress'" indeterminate aria-label="正在测试模型连接" />
      <p v-if="testFeedback" class="runtime-test-feedback" :class="{ 'runtime-error': testFailed }" :role="testFailed ? 'alert' : 'status'">{{ testFeedback }}</p>
      <p v-if="!loading && model?.hasCredential && !testFeedback" class="runtime-model-note">配置已保存。服务连接和模型响应会在发送消息时验证。</p>
      <p v-else-if="!loading && !modelFailed && !model?.hasCredential" class="runtime-model-note">密钥由安卓端保存，基础对话无需额外系统授权。</p>
      <p v-if="feedback" class="runtime-error runtime-feedback" role="alert">{{ feedback }}</p>
    </section>

    <section aria-labelledby="runtime-storage-title">
      <h3 id="runtime-storage-title">运行状态</h3>
      <dl class="runtime-group">
        <div class="runtime-row">
          <Database class="runtime-icon" :size="24" aria-hidden="true" />
          <div class="runtime-row-copy"><dt>本机存储</dt><dd>{{ loading ? '正在检查本机存储…' : runtimeFailed ? '本机存储不可用，请关闭应用后重新打开。已有数据保留。' : '会话与历史保存在这台手机' }}</dd></div>
          <dd class="runtime-value" :class="{ 'runtime-error': runtimeFailed }">{{ loading ? '正在读取…' : runtime?.sqlite === 'ready' ? '就绪' : '不可用' }}</dd>
        </div>
        <div class="runtime-row">
          <Smartphone class="runtime-icon" :size="24" aria-hidden="true" />
          <div class="runtime-row-copy"><dt>运行方式</dt><dd>保持应用在前台完成回复。</dd></div>
          <dd class="runtime-value">{{ loading ? '正在读取…' : runtime?.mode === 'foreground' ? '前台' : '未知' }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="runtime-capabilities-title">
      <h3 id="runtime-capabilities-title">功能与授权</h3>
      <dl class="runtime-group runtime-capabilities">
        <div class="runtime-row"><span class="runtime-tier" aria-hidden="true">P0</span><div class="runtime-row-copy"><dt>基础对话 · 普通权限</dt><dd>会话、历史、停止与删除，需配置模型。</dd></div><dd class="runtime-value">前台原型</dd></div>
        <div class="runtime-row"><span class="runtime-tier" aria-hidden="true">P1</span><div class="runtime-row-copy"><dt>系统授权功能</dt><dd>语音、通知、文件和屏幕采集。</dd></div><dd class="runtime-value">未接入</dd></div>
        <div class="runtime-row"><span class="runtime-tier" aria-hidden="true">P2</span><div class="runtime-row-copy"><dt>Shizuku 扩展</dt><dd>按具体功能授权的系统诊断与操作。</dd></div><dd class="runtime-value">未接入</dd></div>
        <div class="runtime-row"><span class="runtime-tier" aria-hidden="true">P3</span><div class="runtime-row-copy"><dt>Root 扩展</dt><dd>需要更高权限的特定功能，单独授权。</dd></div><dd class="runtime-value">未接入</dd></div>
      </dl>
      <p class="runtime-capability-note">增强能力按需接入。安装 Shizuku 或取得 root 权限，不会自动开启尚未接入的功能。</p>
    </section>
  </div>
</template>

<style scoped>
.native-runtime-panel { display: grid; gap: 24px; min-width: 0; color: var(--md-sys-color-on-surface); }
.runtime-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.runtime-heading > div { min-width: 0; }
.runtime-heading h2 { margin: 0; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -.4px; }
.runtime-heading p { margin: 4px 0 0; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; }
.runtime-heading md-icon-button { flex: 0 0 48px; width: 48px; height: 48px; }
section { min-width: 0; }
h3 { margin: 0 0 8px; padding-inline: 16px; color: var(--md-sys-color-primary); font-size: 14px; font-weight: 500; line-height: 20px; }
.runtime-model { padding: 20px; border-radius: 28px; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.runtime-model-label { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.runtime-model-label h3 { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; color: inherit; }
.runtime-model-status { font-size: 12px; line-height: 20px; font-weight: 500; }
.runtime-model-title { margin: 20px 0 8px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.2px; text-wrap: balance; overflow-wrap: anywhere; }
.runtime-model-description { margin: 0 0 20px; font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.runtime-endpoint { font-size: 13px; }
.runtime-model-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.runtime-configure { display: flex; flex: 1 1 144px; min-height: 48px; --md-filled-tonal-button-container-height: 48px; --md-filled-tonal-button-container-color: var(--md-sys-color-primary); --md-filled-tonal-button-label-text-color: var(--md-sys-color-on-primary); }
.runtime-test { display: flex; flex: 1 1 96px; min-height: 48px; --md-outlined-button-container-height: 48px; --md-outlined-button-label-text-color: var(--md-sys-color-on-primary-container); }
.runtime-test-note { margin: 10px 0 0; font-size: 12px; line-height: 18px; }
.runtime-test-feedback { margin: 12px 0 0; font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.runtime-model md-linear-progress { margin-top: 12px; }
.runtime-model-note { margin: 12px 0 0; font-size: 12px; line-height: 18px; }
.runtime-group { margin: 0; border-radius: 24px; background: var(--md-sys-color-surface-container); overflow: hidden; }
.runtime-row { display: flex; align-items: center; gap: 12px; min-height: 76px; padding: 16px; box-sizing: border-box; }
.runtime-row + .runtime-row { border-top: 1px solid var(--md-sys-color-outline-variant); }
.runtime-icon { flex: 0 0 24px; color: var(--md-sys-color-on-surface-variant); }
.runtime-row-copy { flex: 1; min-width: 0; }
dt { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; overflow-wrap: anywhere; }
dd { margin: 4px 0 0; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
.runtime-value { flex: 0 0 auto; max-width: 72px; margin: 0; text-align: end; color: var(--md-sys-color-on-surface-variant); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.runtime-tier { display: grid; place-items: center; flex: 0 0 32px; min-height: 32px; border-radius: 10px; color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-highest); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.runtime-capability-note { margin: 12px 16px 0; font-size: 12px; line-height: 18px; color: var(--md-sys-color-on-surface-variant); }
.runtime-error { color: var(--md-sys-color-error) !important; }
.runtime-feedback { margin: 12px 0 0; font-size: 14px; line-height: 20px; }
@media (max-width: 360px) { .runtime-model { padding: 16px; } .runtime-row { gap: 10px; padding: 14px 12px; } .runtime-icon, .runtime-tier { display: none; } .runtime-value { max-width: 60px; } }
</style>
