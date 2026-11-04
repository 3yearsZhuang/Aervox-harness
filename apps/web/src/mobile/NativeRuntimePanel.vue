<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Activity, Bell, BookOpen, Database, FolderDown, KeyRound, Menu, RefreshCw, Smartphone, Sparkles } from 'lucide-vue-next';
import { getClientTransport } from '@aervox/api-client';
import NativeLearningPanel from './NativeLearningPanel.vue';
import { nativeRequest } from './native-channel';
import { deviceError, grantDeviceCapability, readDeviceStatus, type DeviceCapability, type DeviceStatus } from './native-device';
// inject() only resolves during setup; handlers must reuse this capture.
const clientTransport = getClientTransport();

type PageId = 'model' | 'device' | 'data' | 'reminder' | 'persona' | 'learning';
const page = ref<PageId>('model');
/** 一级菜单收进左侧抽屉：页面上不再有「分类首页」这一层。 */
const drawerOpen = ref(false);
const pageMeta: Record<PageId, { title: string; subtitle: string }> = {
  model: { title: '模型与状态', subtitle: '连接配置与本机运行状态。' },
  device: { title: '设备与能力', subtitle: '执行通道、设备操作与能力状态。' },
  data: { title: '数据管理', subtitle: '备份恢复与题库导入。' },
  reminder: { title: '提醒', subtitle: '复习提醒与通知。' },
  persona: { title: '人格', subtitle: '陪伴者的身份、设定与切换。' },
  learning: { title: '学习与复习', subtitle: '开始练习、查看报告和完成今日复习。' },
};
function openPage(target: PageId) { page.value = target; drawerOpen.value = false; if (target === 'persona') void loadPersonas(); }
function menuSummary(target: PageId): string {
  if (target === 'model') return modelStatus.value || (loading.value ? '读取中' : '未配置');
  if (target === 'device') return device.value ? (device.value.root ? 'Root 可用' : device.value.shizuku ? 'Shizuku 就绪' : '需授权') : '未检测';
  if (target === 'data') return '导出 / 恢复 / 题库';
  if (target === 'learning') return '练习 / 今日复习';
  if (target === 'persona') return personaBusy.value ? '读取中' : `${personas.value.length} 个`;
  return reminderOn.value ? '已开启' : '未开启';
}

/* ---------- 人格：陪伴者的身份与设定 ---------- */
interface PersonaRow { id: string; name: string; description: string; currentRevisionId: string }
const personas = ref<PersonaRow[]>([]);
const activePersonaId = ref('');
const editingPersonaId = ref('');
const draftConfig = ref<Record<string, unknown>>({});
const personaBusy = ref(false);
const personaFeedback = ref('');
const personaError = ref('');
const draftName = ref('');
const draftDescription = ref('');
const draftPrompt = ref('');
const draftRevision = ref(1);
let personaLoaded = false;

async function loadPersonaDetail() {
  const id = activePersonaId.value;
  if (!id) return;
  const detail = await clientTransport.request<{
    persona: PersonaRow;
    revision: { revision: number; config: { systemPromptAppend: string; [key: string]: unknown } } | null;
  }>('GET', `/v1/personas/${encodeURIComponent(id)}`);
  editingPersonaId.value = id;
  draftConfig.value = detail.revision?.config ?? {};
  draftName.value = detail.persona.name;
  draftDescription.value = detail.persona.description ?? '';
  draftPrompt.value = detail.revision?.config.systemPromptAppend ?? '';
  draftRevision.value = detail.revision?.revision ?? 1;
}

async function loadPersonas(force = false) {
  if (personaLoaded && !force) return;
  // 保存后的强制刷新不能顺手清掉刚写下的回执，否则用户看不到「已保存」。
  personaError.value = '';
  if (!force) personaFeedback.value = '';
  personaBusy.value = true;
  try {
    const list = await clientTransport.request<{ personas: PersonaRow[]; active: { personaId: string } | null }>('GET', '/v1/personas');
    personas.value = list.personas ?? [];
    activePersonaId.value = list.active?.personaId ?? '';
    editingPersonaId.value = activePersonaId.value;
    await loadPersonaDetail();
    personaLoaded = true;
  } catch {
    personaError.value = '人格列表读取失败，可以下拉刷新重试。';
  } finally { personaBusy.value = false; }
}

async function switchPersona(id: string) {
  if (personaBusy.value || id === activePersonaId.value && id === editingPersonaId.value) return;
  personaBusy.value = true; personaError.value = ''; personaFeedback.value = '';
  try {
    await clientTransport.request('POST', `/v1/personas/${encodeURIComponent(id)}/activate`, {});
    activePersonaId.value = id;
    await loadPersonaDetail();
    personaFeedback.value = `已切换到「${draftName.value}」。`;
  } catch {
    personaError.value = '切换没有完成，当前人格保持不变。';
  } finally { personaBusy.value = false; }
}

function newPersona() {
  editingPersonaId.value = '';
  draftConfig.value = {};
  draftName.value = ''; draftDescription.value = ''; draftPrompt.value = '';
  draftRevision.value = 1; personaFeedback.value = ''; personaError.value = '';
}

async function refreshPage() {
  if (personaBusy.value) return;
  if (page.value === 'persona') await loadPersonas(true);
  else await readStatus();
}

async function savePersona() {
  // 新建草稿独立于当前激活选择，保存前不切换正在使用的人格。
  if (personaBusy.value) return;
  const name = draftName.value.trim();
  if (!name) { personaError.value = '名字不能为空。'; return; }
  const prompt = draftPrompt.value.trim();
  if (!prompt) { personaError.value = '设定不能为空，它是陪伴者说话的依据。'; return; }
  personaBusy.value = true; personaError.value = ''; personaFeedback.value = '';
  const description = draftDescription.value.trim();
  const config = { ...draftConfig.value, systemPromptAppend: prompt };
  try {
    if (!editingPersonaId.value) {
      // 新建完成后明确启用，新旧人格保留各自的修订。
      const created = await clientTransport.request<{ persona: PersonaRow; revision: { revision: number } }>(
        'POST', '/v1/personas', { name, description, config },
      );
      await clientTransport.request('POST', `/v1/personas/${encodeURIComponent(created.persona.id)}/activate`, {});
      personaFeedback.value = '已建立并启用这个人格。';
    } else {
      const saved = await clientTransport.request<{ persona: PersonaRow; revision: { revision: number } }>(
        'PATCH', `/v1/personas/${encodeURIComponent(editingPersonaId.value)}`,
        { expectedRevision: draftRevision.value, name, description, config },
      );
      await clientTransport.request('POST', `/v1/personas/${encodeURIComponent(editingPersonaId.value)}/activate`, {});
      draftRevision.value = saved.revision.revision;
      personaFeedback.value = '已保存，下一次对话就会用上新设定。';
    }
    personaLoaded = false;
    await loadPersonas(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    personaError.value = message === 'PERSONA_REVISION_CONFLICT'
      ? '这份人格在别处被改过，请刷新后再保存。'
      : '保存没有完成，设定未变。';
  } finally { personaBusy.value = false; }
}

interface RuntimeSummary { kind: 'runtime'; connectionEpoch: string; sqlite: 'ready'; mode: 'foreground' }
interface ModelSummary { kind: 'summary'; hasCredential: boolean; endpoint?: string; model?: string }
const runtime = ref<RuntimeSummary>();
const model = ref<ModelSummary>();
const device = ref<DeviceStatus>();
const deviceFailed = ref(false);
const deviceBusy = ref(false);
const deviceFeedback = ref('');
const confirmingClear = ref(false);
const clearing = ref(false);
const clearFeedback = ref('');
const loading = ref(true);
const configuring = ref(false);
const testing = ref(false);
const testFeedback = ref('');
const testFailed = ref(false);
const runtimeFailed = ref(false);
const modelFailed = ref(false);
const feedback = ref('');
const importBusy = ref(false);
const importFeedback = ref('');
const importError = ref('');
const importUrl = ref('');
const reminderOn = ref(false);
const reminderFeedback = ref('');
const backupBusy = ref(false);
const backupFeedback = ref('');
const backupError = ref('');
const restoreOpen = ref(false);
const confirmingRestore = ref(false);
const restoreText = ref('');
let disposed = false;
let readGeneration = 0;
const modelStatus = computed(() => loading.value ? '正在读取…' : modelFailed.value ? '读取失败' : model.value?.hasCredential ? '已保存配置' : '未配置');
const modelHeading = computed(() => loading.value ? '正在读取模型配置' : modelFailed.value ? '检查你的模型服务' : model.value?.hasCredential ? model.value.model : '连接模型，开始对话');
const rootText = computed(() => deviceFailed.value ? '无法读取 root 状态。可以刷新后重试。'
  : !device.value ? '正在检查 root 授权…'
  : device.value.root ? `Root 可用${device.value.device ? ` · ${device.value.device}` : ''}，设备操作由你逐项开启。`
    : '设备操作需要 root。检测到授权请求时请允许本应用；普通对话和学习无需 root。');
const rootValue = computed(() => deviceFailed.value ? '未知' : !device.value ? '读取中' : device.value.root ? '可用' : '不可用');

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
async function readDevice() {
  try {
    const next = await readDeviceStatus();
    if (disposed) return;
    device.value = next; deviceFailed.value = false;
  } catch {
    if (disposed) return;
    device.value = undefined; deviceFailed.value = true;
  }
}
async function toggleDevice(capability: DeviceCapability, enabled: boolean) {
  if (deviceBusy.value) return;
  deviceBusy.value = true; deviceFeedback.value = '';
  try {
    const next = await grantDeviceCapability(capability, enabled);
    if (disposed) return;
    device.value = next; deviceFailed.value = false;
  } catch (error) {
    if (!disposed) deviceFeedback.value = deviceError(error);
  } finally { if (!disposed) deviceBusy.value = false; }
}
async function clearModel() {
  if (clearing.value || loading.value || configuring.value || testing.value) return;
  clearing.value = true; clearFeedback.value = '';
  try {
    await nativeRequest({ op: 'model', operation: 'clear' });
    if (disposed) return;
    confirmingClear.value = false;
    await readStatus();
    if (!disposed) clearFeedback.value = '已清除模型配置。这台手机不再保存密钥，已有对话不受影响。';
  } catch {
    if (!disposed) clearFeedback.value = '清除没有完成，原有配置保持不变。可以稍后重试。';
  } finally { if (!disposed) clearing.value = false; }
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
  await readDevice();
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
async function importQuestionFile() {
  if (importBusy.value) return;
  importBusy.value = true; importFeedback.value = ''; importError.value = '';
  try {
    const transport = clientTransport;
    if (!transport.pickTextFile) throw new Error('FILE_PICK_NOT_SUPPORTED');
    const picked = await transport.pickTextFile();
    const result = await transport.request<{ importedCount: number }>('POST', '/v1/questions/import', { content: picked.text });
    importFeedback.value = `已从「${picked.name}」导入 ${result.importedCount} 道题。`;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    importError.value = code === 'FILE_PICK_CANCELLED' ? '已取消选择。'
      : code === 'FILE_TOO_LARGE' ? '文件超过 2 MiB 上限，未导入。'
      : code === 'NO_VALID_QUESTIONS' ? '文件里没有可识别的题目，未导入。'
      : '导入尚未完成，请刷新学习页检查已保存的题目，再决定是否重试。';
  } finally { importBusy.value = false; }
}

async function importFromUrl() {
  if (importBusy.value || !importUrl.value.trim()) return;
  importBusy.value = true; importFeedback.value = ''; importError.value = '';
  try {
    const transport = clientTransport;
    if (!transport.fetchUrlText) throw new Error('URL_IMPORT_NOT_SUPPORTED');
    const picked = await transport.fetchUrlText(importUrl.value.trim());
    const result = await transport.request<{ importedCount: number }>('POST', '/v1/questions/import', { content: picked.text });
    importFeedback.value = `已从「${picked.name}」导入 ${result.importedCount} 道题。`;
    importUrl.value = '';
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    importError.value = code === 'FILE_URL_INVALID' ? '只支持 https 链接。'
      : code === 'FILE_TOO_LARGE' ? '内容超过 2 MiB 上限，未导入。'
      : code === 'NO_VALID_QUESTIONS' ? '链接内容里没有可识别的题目，未导入。'
      : '链接读取失败，未导入。';
  } finally { importBusy.value = false; }
}

async function toggleReminder() {
  const next = !reminderOn.value;
  try {
    const transport = clientTransport;
    if (!transport.configureReviewReminder) throw new Error('NOTIFY_NOT_SUPPORTED');
    const result = await transport.configureReviewReminder({ enabled: next });
    reminderOn.value = result.enabled;
    reminderFeedback.value = next ? '已开启：每天 9 点提醒今日复习。' : '已关闭复习提醒。';
  } catch {
    reminderFeedback.value = '提醒设置没有成功，保持原状。';
  }
}

async function exportBackup() {
  if (backupBusy.value) return;
  backupBusy.value = true; backupFeedback.value = ''; backupError.value = ''; confirmingRestore.value = false;
  try {
    const transport = clientTransport;
    if (!transport.exportBackup) throw new Error('BACKUP_NOT_SUPPORTED');
    const file = await transport.exportBackup();
    if (transport.shareTextFile) await transport.shareTextFile({ title: 'Aervox 备份', text: file.text });
    else if (transport.shareText) await transport.shareText({ title: 'Aervox 备份', text: file.text });
    else throw new Error('SHARE_UNAVAILABLE');
    const records = Object.values(file.tableCounts).reduce((total, count) => total + count, 0);
    backupFeedback.value = `备份已生成并交给系统分享（${records} 条记录，${file.createdAt.slice(0, 10)}）。`;
  } catch (error) {
    console.warn('[Aervox] backup export failed', error);
    const code = error instanceof Error ? error.message : '';
    backupError.value = code === 'BACKUP_FILE_TOO_LARGE' || code === 'BACKUP_TOO_LARGE' ? '备份超过 16 MiB 文件上限，未导出。'
      : code === 'SHARE_UNAVAILABLE' ? '备份已生成，但系统分享没有打开。'
      : code === 'BACKUP_ROW_TOO_LARGE' ? '有记录超过当前版本的单条备份上限，未导出；原数据保留。'
      : code === 'BACKUP_TABLE_UNEXPECTED' ? '备份没有导出：数据表名不符合备份结构。'
      : '备份没有导出，数据未受影响。';
  } finally { backupBusy.value = false; }
}

async function importBackupFile() {
  backupFeedback.value = ''; backupError.value = '';
  try {
    const transport = clientTransport;
    if (!transport.pickTextFile) throw new Error('FILE_PICK_NOT_SUPPORTED');
    const picked = await transport.pickTextFile();
    restoreText.value = picked.text;
    restoreOpen.value = true;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code !== 'FILE_PICK_CANCELLED' && code !== 'NATIVE_RECEIPT_UNKNOWN') backupError.value = '没有读到文件内容，请重试或粘贴备份文本。';
  }
}

async function importBackup() {
  if (backupBusy.value) return;
  if (!confirmingRestore.value) { confirmingRestore.value = true; return; }
  backupBusy.value = true; backupFeedback.value = ''; backupError.value = '';
  try {
    const transport = clientTransport;
    if (!transport.importBackup) throw new Error('BACKUP_NOT_SUPPORTED');
    const result = await transport.importBackup(restoreText.value);
    const records = Object.values(result.imported).reduce((total, count) => total + count, 0);
    backupFeedback.value = `恢复完成（${records} 条记录已写入）。请关闭并重新打开应用，载入已恢复的数据。`;
    restoreText.value = ''; restoreOpen.value = false;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    backupError.value = code === 'BACKUP_CORRUPTED' ? '备份校验不通过，未写入任何数据。'
      : code === 'BACKUP_SCHEMA_MISMATCH' ? '备份与当前版本的数据结构不一致，未写入任何数据。'
      : code === 'BACKUP_FORMAT_UNKNOWN' ? '无法识别这个备份格式，未写入任何数据。'
      : code === 'BACKUP_RESTORE_BLOCKED' ? '备份依赖不完整或当前版本无法恢复，未写入任何数据。'
      : code === 'BACKUP_DELETION_CONFLICT' ? '这台手机已有删除记录，恢复旧备份可能带回已删除的内容，已拒绝且未写入任何数据。'
      : code === 'BACKUP_MALFORMED' ? '备份内容无法解析，未写入任何数据。'
      : code === 'HOST_BUSY' || code === 'BACKUP_RESTORE_BUSY' || code === 'BACKUP_RESTORE_IN_PROGRESS' ? '请先停止当前对话或等待操作结束，再恢复备份。'
      : '恢复结果尚未确认，请关闭并重新打开应用检查数据，勿重复恢复。';
  } finally { backupBusy.value = false; confirmingRestore.value = false; }
}

onMounted(() => {
  try {
    const transport = clientTransport;
    void transport.reviewReminderStatus?.().then(status => {
      reminderOn.value = status.enabled;
    }).catch(() => undefined);
  } catch { /* The panel still works without reminder state. */ } void readStatus(); });
onBeforeUnmount(() => { disposed = true; readGeneration++; });
</script>

<template>
  <div class="native-runtime-panel" :aria-busy="loading || configuring || testing || deviceBusy">
    <div class="runtime-drawer-scrim" :class="{ 'is-open': drawerOpen }" @click="drawerOpen = false" />
    <nav class="runtime-drawer" :class="{ 'is-open': drawerOpen }" aria-label="设置分区" :aria-hidden="drawerOpen ? 'false' : 'true'">
      <p class="runtime-drawer-title">本机运行</p>
      <button v-for="target in (['model', 'device', 'data', 'reminder', 'persona', 'learning'] as const)" :key="target" type="button"
        class="runtime-menu-card" :class="{ 'is-active': page === target }" @click="openPage(target)">
        <component :is="target === 'model' ? KeyRound : target === 'device' ? Smartphone : target === 'data' ? FolderDown : target === 'reminder' ? Bell : target === 'learning' ? BookOpen : Sparkles" :size="22" aria-hidden="true" />
        <span class="runtime-menu-copy"><strong>{{ pageMeta[target].title }}</strong><small>{{ pageMeta[target].subtitle }}</small></span>
        <span class="runtime-menu-badge">{{ menuSummary(target) }}</span>
      </button>
    </nav>
    <header class="runtime-heading">
      <component :is="'md-icon-button'" type="button" :aria-label="drawerOpen ? '收起设置分区' : '展开设置分区'" :aria-expanded="drawerOpen ? 'true' : 'false'" @click="drawerOpen = !drawerOpen">
        <Menu :size="24" aria-hidden="true" />
      </component>
      <div class="runtime-heading-copy"><h2>{{ pageMeta[page].title }}</h2><p>{{ pageMeta[page].subtitle }}</p></div>
      <component :is="'md-icon-button'" v-if="page !== 'learning'" type="button" aria-label="刷新运行状态" :disabled="loading || configuring || testing" @click="refreshPage">
        <RefreshCw :size="24" aria-hidden="true" />
      </component>
    </header>
    <component v-if="loading" :is="'md-linear-progress'" indeterminate aria-label="正在读取本机状态" />

    <section v-if="page === 'model'" class="runtime-model" aria-labelledby="runtime-model-title">
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
      <div v-if="model?.hasCredential" class="runtime-model-clear">
        <template v-if="confirmingClear">
          <p role="alert">清除后，这台手机不再保存密钥；已保存的对话不受影响。</p>
          <div class="runtime-model-actions">
            <component :is="'md-filled-button'" class="runtime-clear-confirm" type="button" :disabled="clearing" @click="clearModel">
              {{ clearing ? '正在清除…' : '确认清除' }}
            </component>
            <component :is="'md-text-button'" type="button" :disabled="clearing" @click="confirmingClear = false">取消</component>
          </div>
        </template>
        <component v-else :is="'md-text-button'" class="runtime-clear-model" type="button"
          :disabled="loading || configuring || testing || clearing" @click="confirmingClear = true">清除模型配置</component>
      </div>
      <p v-if="clearFeedback" class="runtime-model-note" role="status">{{ clearFeedback }}</p>
      <p v-if="feedback" class="runtime-error runtime-feedback" role="alert">{{ feedback }}</p>
    </section>

    <section v-if="page === 'model'" aria-labelledby="runtime-storage-title">
      <h3 id="runtime-storage-title"><Activity :size="20" aria-hidden="true" />运行状态</h3>
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

    <section v-if="page === 'device'" aria-labelledby="runtime-device-title">
      <h3 id="runtime-device-title"><Smartphone :size="20" aria-hidden="true" />设备能力</h3>
      <dl class="runtime-group">
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>Root 授权</dt><dd>{{ rootText }}</dd></div>
          <dd class="runtime-value" :class="{ 'runtime-error': deviceFailed }">{{ rootValue }}</dd>
        </div>
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>Shizuku 扩展</dt><dd>当前安装包尚未集成 Shizuku，安装服务不会自动开放设备操作。</dd></div>
          <dd class="runtime-value"><span class="runtime-badge runtime-badge--off">未开放</span></dd>
        </div>
      </dl>
      <h4 class="runtime-subtitle">设备操作开关</h4>
      <label class="runtime-device-toggle">
        <span class="runtime-device-label"><strong>控制手机</strong><small>点击、滑动、按键与输入文本</small></span>
        <component :is="'md-switch'" aria-label="控制手机" :selected="device?.capabilities.control ? 'true' : undefined"
          :disabled="deviceBusy || !(device?.root || device?.shizuku) ? 'true' : undefined" @change="toggleDevice('control', !device?.capabilities.control)" />
      </label>
      <label class="runtime-device-toggle">
        <span class="runtime-device-label"><strong>打开应用</strong><small>按包名启动已安装应用的首页</small></span>
        <component :is="'md-switch'" aria-label="打开应用" :selected="device?.capabilities.apps ? 'true' : undefined"
          :disabled="deviceBusy || !(device?.root || device?.shizuku) ? 'true' : undefined" @change="toggleDevice('apps', !device?.capabilities.apps)" />
      </label>
      <div class="runtime-device-toggle">
        <span class="runtime-device-label"><strong>Root 高级实验</strong><small>尚未开放，不接受自定义命令</small></span>
        <span class="runtime-badge runtime-badge--off">未开放</span>
      </div>
      <p class="runtime-capability-note">设备操作只在应用位于前台时执行，且只包含固定动作。设置授权后，每个新动作仍需你在对话中批准；不接受自定义命令。</p>
      <p v-if="deviceFeedback" class="runtime-error runtime-feedback" role="alert">{{ deviceFeedback }}</p>
    </section>

    <section v-if="page === 'device'" aria-labelledby="runtime-capabilities-title">
      <h3 id="runtime-capabilities-title"><Sparkles :size="20" aria-hidden="true" />能力状态</h3>
      <dl class="runtime-group runtime-capabilities">
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>对话与学习</dt><dd>会话历史、学习计划、练习与复习，数据都保存在这台手机。</dd></div>
          <dd class="runtime-value"><span class="runtime-badge runtime-badge--beta">试用中</span></dd>
        </div>
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>语音输入与朗读</dt><dd>按住麦克风听写消息，朗读当前回复。</dd></div>
          <dd class="runtime-value"><span class="runtime-badge runtime-badge--beta">试用中</span></dd>
        </div>
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>通知与用户文件</dt><dd>复习提醒、单文件题库导入；需要时按项申请系统权限。</dd></div>
          <dd class="runtime-value"><span class="runtime-badge runtime-badge--beta">试用中</span></dd>
        </div>
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>屏幕采集</dt><dd>让助手看到屏幕内容，需要专门的隐私设计。</dd></div>
          <dd class="runtime-value"><span class="runtime-badge runtime-badge--off">未开放</span></dd>
        </div>
      </dl>
      <p class="runtime-capability-note">「未开放」表示还没有写进这个版本，能力按需逐项接入。带开关的项在「设备能力」中。</p>
    </section>

    <section v-if="page === 'data'" aria-labelledby="runtime-backup-title">
      <h3 id="runtime-backup-title"><FolderDown :size="20" aria-hidden="true" />备份与恢复</h3>
      <div class="runtime-group">
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>导出备份</dt><dd>把会话、学习、人格与日记等业务数据打包为带校验的备份文本，交给系统分享保存。模型密钥、插件凭据和设备连接不进入备份，换机后需重新配置。</dd></div>
          <component :is="'md-filled-tonal-button'" :disabled="backupBusy ? 'true' : undefined" @click="exportBackup">导出</component>
        </div>
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>恢复备份</dt><dd>粘贴备份文本，校验通过后覆盖这台手机上的当前数据。</dd></div>
          <component :is="'md-filled-tonal-button'" :disabled="backupBusy ? 'true' : undefined" @click="restoreOpen = !restoreOpen; confirmingRestore = false">恢复</component>
        </div>
      </div>
      <div v-if="restoreOpen" class="runtime-model-clear">
        <p>恢复会覆盖当前全部数据，且只接受与本版本结构一致的备份。</p>
        <div class="runtime-url-import">
          <textarea v-model="restoreText" rows="4" class="runtime-backup-text" aria-label="备份文本" placeholder="把备份文本粘贴到这里"></textarea>
          <component :is="'md-filled-tonal-button'" class="runtime-pick-file" @click="importBackupFile">从文件选择</component>
        </div>
        <component :is="'md-filled-button'" :disabled="backupBusy || !restoreText.trim() ? 'true' : undefined" @click="importBackup">
          {{ confirmingRestore ? '确认覆盖当前数据' : '校验并恢复' }}
        </component>
      </div>
      <p v-if="backupFeedback" class="runtime-model-note" role="status">{{ backupFeedback }}</p>
      <p v-if="backupError" class="runtime-error runtime-feedback" role="alert">{{ backupError }}</p>
      <h4 class="runtime-subtitle">题库导入</h4>
      <div class="runtime-group">
        <div class="runtime-row">
          <div class="runtime-row-copy"><dt>从文件导入题库</dt><dd>选择一份 JSON 或 CSV 题库文件（2 MiB 内），只读取这一份文件。</dd></div>
          <component :is="'md-filled-tonal-button'" :disabled="importBusy ? 'true' : undefined" @click="importQuestionFile">选择文件</component>
        </div>
        <div class="runtime-row runtime-row--stack">
          <div class="runtime-row-copy"><dt>从链接导入题库</dt><dd>粘贴 https 链接的 JSON/CSV 题库（2 MiB 内）。</dd></div>
          <div class="runtime-url-import">
            <input v-model="importUrl" class="runtime-backup-text" aria-label="题库链接" placeholder="https://…" />
            <component :is="'md-filled-tonal-button'" :disabled="importBusy || !importUrl.trim() ? 'true' : undefined" @click="importFromUrl">导入</component>
          </div>
        </div>
      </div>
      <p v-if="importFeedback" class="runtime-model-note" role="status">{{ importFeedback }}</p>
      <p v-if="importError" class="runtime-error runtime-feedback" role="alert">{{ importError }}</p>
    </section>

    <section v-if="page === 'reminder'" aria-labelledby="runtime-learn-title">
      <h3 id="runtime-learn-title"><Bell :size="20" aria-hidden="true" />提醒</h3>
      <div class="runtime-group">
        <label class="runtime-device-toggle">
          <span class="runtime-device-label"><strong>复习提醒</strong><small>每天 9 点提醒今日复习，随时可关</small></span>
          <component :is="'md-switch'" aria-label="复习提醒" :selected="reminderOn ? 'true' : undefined" @change="toggleReminder()" />
        </label>
      </div>
      <p v-if="reminderFeedback" class="runtime-model-note" role="status">{{ reminderFeedback }}</p>
    </section>

    <NativeLearningPanel v-if="page === 'learning'" />

    <section v-if="page === 'persona'" aria-labelledby="runtime-persona-title">
      <h3 id="runtime-persona-title"><Sparkles :size="20" aria-hidden="true" />人格</h3>
      <p v-if="loading || personaBusy" class="runtime-model-description">正在读取人格…</p>
      <p v-else-if="!personas.length" class="runtime-model-description">还没有保存过人格。填写下面的名字与设定，保存后会直接生效。</p>
      <div v-else class="runtime-group">
        <button v-for="item in personas" :key="item.id" type="button" class="runtime-row runtime-persona-row"
          :class="{ 'is-active': item.id === activePersonaId }" @click="switchPersona(item.id)">
          <span class="runtime-row-copy">
            <strong>{{ item.name }}</strong>
            <small>{{ item.description || '还没有写简介。' }}</small>
          </span>
          <span v-if="item.id === activePersonaId" class="runtime-persona-current">当前</span>
        </button>
      </div>
      <component :is="'md-text-button'" type="button" :disabled="personaBusy" @click="newPersona">新建人格</component>
      <h4 class="runtime-subtitle">{{ editingPersonaId ? '编辑设定' : '新建人格' }}</h4>
      <div class="runtime-persona-form">
        <label class="runtime-persona-field">
          <span>名字</span>
          <input v-model="draftName" aria-label="人格名字" :disabled="personaBusy" placeholder="小隅" />
        </label>
        <label class="runtime-persona-field">
          <span>简介</span>
          <input v-model="draftDescription" aria-label="人格简介" :disabled="personaBusy" placeholder="一句话说明这个人格是谁" />
        </label>
        <label class="runtime-persona-field">
          <span>人格设定</span>
          <textarea v-model="draftPrompt" aria-label="人格设定" rows="6" :disabled="personaBusy"
            placeholder="她怎么称呼你、说话的语气、在意什么、不会做什么…" />
        </label>
        <component :is="'md-filled-tonal-button'" class="runtime-configure" type="button" :disabled="personaBusy" @click="savePersona">保存设定</component>
      </div>
      <p v-if="personaFeedback" class="runtime-model-note" role="status">{{ personaFeedback }}</p>
      <p v-if="personaError" class="runtime-error runtime-feedback" role="alert">{{ personaError }}</p>
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
.runtime-model-clear { display: grid; gap: 8px; margin-top: 12px; }
.runtime-model-clear p { margin: 0; font-size: 13px; line-height: 20px; }
.runtime-clear-model, .runtime-clear-confirm { min-height: 48px; --md-filled-button-container-height: 48px; --md-text-button-container-height: 48px; --md-text-button-label-text-color: var(--md-sys-color-on-primary-container); }
.runtime-group { margin: 0; border-radius: 24px; background: var(--md-sys-color-surface-container); overflow: hidden; }
.runtime-row { display: flex; align-items: center; gap: 12px; min-height: 76px; padding: 16px; box-sizing: border-box; }
.runtime-row + .runtime-row { border-top: 1px solid var(--md-sys-color-outline-variant); }
.runtime-icon { flex: 0 0 24px; color: var(--md-sys-color-on-surface-variant); }
.runtime-row-copy { flex: 1; min-width: 0; }
dt { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; overflow-wrap: anywhere; }
dd { margin: 4px 0 0; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
.runtime-value { flex: 0 0 auto; max-width: 96px; margin: 0; text-align: end; color: var(--md-sys-color-on-surface-variant); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.runtime-capabilities .runtime-value { max-width: none; }
.runtime-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 18px; letter-spacing: .2px; white-space: nowrap; }
.runtime-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.runtime-badge--beta { color: var(--md-sys-color-primary); background: color-mix(in srgb, var(--md-sys-color-primary) 14%, transparent); }
.runtime-badge--ready { color: var(--md-sys-color-tertiary); background: color-mix(in srgb, var(--md-sys-color-tertiary) 16%, transparent); }
.runtime-badge--off { color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-highest); }
.runtime-badge--error { color: var(--md-sys-color-error); background: color-mix(in srgb, var(--md-sys-color-error) 14%, transparent); }
.runtime-capability-note { margin: 12px 16px 0; font-size: 12px; line-height: 18px; color: var(--md-sys-color-on-surface-variant); }
.runtime-device-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 64px; margin-top: 8px; padding: 12px 16px; border-radius: 20px; background: var(--md-sys-color-surface-container); }
.runtime-device-label { display: grid; gap: 2px; min-width: 0; }
.runtime-device-label strong { font-size: 16px; font-weight: 500; line-height: 24px; }
.runtime-device-label small { color: var(--md-sys-color-on-surface-variant); font-size: 13px; line-height: 18px; }
.runtime-error { color: var(--md-sys-color-error) !important; }
.runtime-feedback { margin: 12px 0 0; font-size: 14px; line-height: 20px; }
.runtime-row--stack { flex-wrap: wrap; }
.runtime-heading-copy { flex: 1 1 auto; min-width: 0; }
.runtime-drawer {
  position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 40;
  width: min(292px, 84vw); box-sizing: border-box;
  padding: 24px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  display: flex; flex-direction: column; gap: 10px; overflow-y: auto;
  background: var(--md-sys-color-surface-container-low, #1b1d22);
  border-inline-end: 1px solid var(--md-sys-color-outline-variant, rgba(255,255,255,.12));
  transform: translateX(-104%); visibility: hidden;
  transition: transform .26s cubic-bezier(.2,.8,.2,1), visibility .26s;
}
.runtime-drawer.is-open { transform: none; visibility: visible; }
.runtime-drawer-scrim {
  position: fixed; inset: 0; z-index: 39;
  background: rgba(0,0,0,.52); opacity: 0; pointer-events: none;
  transition: opacity .26s ease;
}
.runtime-drawer-scrim.is-open { opacity: 1; pointer-events: auto; }
.runtime-drawer-title { margin: 0 0 6px; padding-inline: 8px; font-size: 13px; font-weight: 600; letter-spacing: .1em; color: var(--md-sys-color-on-surface-variant); }
.runtime-menu-card.is-active { border-color: var(--md-sys-color-primary); background: color-mix(in srgb, var(--md-sys-color-primary) 16%, transparent); }
.runtime-persona-row { width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.runtime-persona-row.is-active { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); }
.runtime-persona-row .runtime-row-copy { display: grid; gap: 4px; }
.runtime-persona-row strong { font-size: 16px; font-weight: 500; line-height: 24px; }
.runtime-persona-row small { color: var(--md-sys-color-on-surface-variant); font-size: 13px; line-height: 19px; }
.runtime-persona-current { flex: 0 0 auto; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  color: var(--md-sys-color-primary); background: color-mix(in srgb, var(--md-sys-color-primary) 16%, transparent); }
.runtime-persona-form { display: grid; gap: 12px; }
.runtime-persona-field { display: grid; gap: 6px; font-size: 13px; color: var(--md-sys-color-on-surface-variant); }
.runtime-persona-field :is(input, textarea) {
  width: 100%; box-sizing: border-box; padding: 10px 14px; border-radius: 14px; font: inherit; font-size: 15px;
  color: var(--md-sys-color-on-surface); background: var(--md-sys-color-surface-container-high);
  border: 1px solid var(--md-sys-color-outline-variant); resize: vertical;
}
.runtime-persona-field textarea { line-height: 22px; min-height: 120px; }
.runtime-menu-card { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; cursor: pointer;
  padding: 16px; border-radius: 18px; border: 1px solid var(--pc-line, rgba(255,255,255,.12));
  background: var(--pc-card, rgba(255,255,255,.05)); color: var(--pc-ink, #fff); font-family: inherit; }
.runtime-menu-card:active { background: rgba(155,122,255,.14); }
.runtime-menu-copy { flex: 1 1 auto; min-width: 0; display: grid; gap: 3px; }
.runtime-menu-copy strong { font-size: 15px; }
.runtime-menu-copy small { color: var(--pc-ink-3, rgba(255,255,255,.55)); font-size: 12px; line-height: 1.5; }
.runtime-menu-badge { flex: 0 0 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; padding: 4px 10px; border-radius: 999px; background: rgba(155,122,255,.16); color: var(--pc-accent, #9b7aff); }
.native-runtime-panel h3 { display: flex; align-items: center; gap: 8px; }
.runtime-subtitle { margin: 14px 0 6px; font-size: 13px; font-weight: 600; color: var(--pc-ink-2); }
.runtime-pick-file { align-self: flex-start; }
.runtime-url-import { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 4px; }
.runtime-url-import .runtime-backup-text { flex: 1 1 auto; width: auto; min-height: 44px; }
.runtime-backup-text { width: 100%; box-sizing: border-box; min-height: 88px; padding: 12px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 16px; background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); font: inherit; font-size: 13px; line-height: 18px; resize: vertical; }
@media (max-width: 360px) { .runtime-model { padding: 16px; } .runtime-row { gap: 10px; padding: 14px 12px; } .runtime-icon { display: none; } .runtime-value { max-width: 60px; } }
/* 窄列换行时避免单字孤行（如「态。」「存。」）；不支持的 WebView 静默降级为普通换行。 */
.native-runtime-panel :where(p, dd, small) { text-wrap: pretty; }
</style>
