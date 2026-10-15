<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { AervoxButton, AervoxCard, AervoxSettingsHeading, AervoxSwitch } from '@aervox/ui/primitives';
import { useAervoxBots } from '@aervox/api-client';
import type { BotAdapterDescriptor, BotConnection, BotConnectionConfig, BotDelivery, BotLogin, BotPairing } from '@aervox/contracts';
import { toDataURL } from 'qrcode';

const api = useAervoxBots();
const adapters = ref<BotAdapterDescriptor[]>([]);
const connections = ref<BotConnection[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const loadError = ref('');
const actionError = ref('');
const notice = ref('');
const busy = ref(false);
const selectedId = ref<string | null>(null);
const selected = computed(() => connections.value.find(connection => connection.id === selectedId.value));
const selectedAdapter = computed(() => adapters.value.find(adapter => adapter.id === selected.value?.adapterId));
const deliveries = ref<BotDelivery[]>([]);
const detailsLoading = ref(false);
const detailsError = ref('');
const login = ref<BotLogin | null>(null);
const qrImage = ref('');
const pairing = ref<BotPairing | null>(null);
const deleteId = ref<string | null>(null);
const retryId = ref<string | null>(null);
const time = ref(Date.now());
const formOpen = ref(false);
const formError = ref('');
const formConflict = ref(false);
const editing = ref<BotConnection | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const form = reactive({ adapterId: '', displayName: '', endpoint: '', accountId: '', groups: '', token: '', enabled: true });
const formAdapter = computed(() => adapters.value.find(adapter => adapter.id === form.adapterId));
const pairingActive = computed(() => Boolean(pairing.value?.expiresAt && Date.parse(pairing.value.expiresAt) > time.value));
const loginActive = computed(() => login.value?.status === 'waiting' || login.value?.status === 'scanned');
let alive = true;
let listVersion = 0;
let detailVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const stateLabels: Record<BotConnection['state'], string> = {
  stopped: '已停用', connecting: '连接中', connected: '已连接', reconnecting: '重连中', login_required: '需要登录', error: '连接异常',
};
const deliveryLabels: Record<BotDelivery['status'], string> = {
  queued: '等待发送', sending: '正在发送', accepted: '平台已接收', failed: '发送失败', unknown: '结果未知',
};
const loginLabels: Record<BotLogin['status'], string> = {
  waiting: '等待扫码', scanned: '已扫码，请在微信中确认', confirmed: '登录成功', expired: '二维码已过期，请重新获取',
};

function errorText(error: unknown, fallback: string): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 409) return '连接状态已变化或操作已过期，请刷新后重试。';
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}

function formatTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function refreshConnections(): Promise<void> {
  const version = ++listVersion;
  const result = await api.listConnections();
  if (!alive || version !== listVersion) return;
  const previous = selected.value;
  connections.value = result;
  if (selectedId.value && !selected.value) closeDetails();
  else if (previous && selected.value && (previous.revision !== selected.value.revision || !selected.value.enabled)) {
    // Login sessions and pairing candidates belong to one connection generation.
    // Account switching can complete in a replacement adapter after the old poll fails.
    detailVersion++;
    login.value = null;
    qrImage.value = '';
    pairing.value = null;
    retryId.value = null;
  }
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  loadError.value = '';
  try {
    const results = await Promise.allSettled([api.listAdapters(), refreshConnections()]);
    if (!alive) return;
    if (results[0].status === 'fulfilled') adapters.value = results[0].value;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') loadError.value = errorText(failure.reason, '读取连接失败');
    if (selectedId.value) await refreshDetails();
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function replaceConnection(connection: BotConnection): void {
  listVersion++;
  const index = connections.value.findIndex(item => item.id === connection.id);
  if (index < 0) connections.value.push(connection);
  else connections.value[index] = connection;
}

function closeDetails(): void {
  detailVersion++;
  selectedId.value = null;
  login.value = null;
  qrImage.value = '';
  pairing.value = null;
  deliveries.value = [];
  detailsError.value = '';
  detailsLoading.value = false;
  retryId.value = null;
}

async function openDetails(connection: BotConnection): Promise<void> {
  closeDetails();
  selectedId.value = connection.id;
  detailsLoading.value = true;
  await refreshDetails();
}

async function setLogin(value: BotLogin, version: number): Promise<void> {
  if (!alive || version !== detailVersion) return;
  login.value = value;
  if (value.status === 'confirmed' || value.status === 'expired') qrImage.value = '';
  else if (value.qrCodeUrl) {
    // The login URL is encoded locally. It is never sent to a remote QR rendering service.
    const data = await toDataURL(value.qrCodeUrl, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
    if (alive && version === detailVersion) qrImage.value = data;
  }
}

async function refreshDetails(): Promise<void> {
  const connection = selected.value;
  if (!connection) return;
  const version = ++detailVersion;
  detailsLoading.value = true;
  try {
    const [items, nextPairing, nextLogin] = await Promise.allSettled([
      api.listDeliveries(connection.id),
      selectedAdapter.value?.capabilities.directMessages ? api.getPairing(connection.id) : Promise.resolve(null),
      connection.enabled && loginActive.value ? api.getLogin(connection.id) : Promise.resolve(null),
    ]);
    if (!alive || version !== detailVersion) return;
    const errors: string[] = [];
    if (items.status === 'fulfilled') deliveries.value = items.value;
    else errors.push(errorText(items.reason, '读取投递状态失败'));
    if (nextPairing.status === 'fulfilled' && nextPairing.value) {
      const code = pairing.value?.expiresAt === nextPairing.value.expiresAt ? pairing.value?.code : undefined;
      pairing.value = { ...nextPairing.value, ...(code ? { code } : {}) };
    } else if (nextPairing.status === 'rejected') errors.push(errorText(nextPairing.reason, '读取配对状态失败'));
    if (nextLogin.status === 'fulfilled' && nextLogin.value) {
      try { await setLogin(nextLogin.value, version); }
      catch (error) { errors.push(errorText(error, '生成登录二维码失败')); }
    } else if (nextLogin.status === 'rejected') errors.push(errorText(nextLogin.reason, '读取登录状态失败'));
    if (version === detailVersion) {
      detailsError.value = errors.join(' ');
    }
  } catch (error) {
    if (alive && version === detailVersion) detailsError.value = errorText(error, '读取登录、配对或投递状态失败');
  } finally {
    if (version === detailVersion) detailsLoading.value = false;
  }
}

async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  actionError.value = '';
  notice.value = '';
  detailVersion++;
  detailsLoading.value = false;
  try { await action(); }
  catch (error) { if (alive) actionError.value = errorText(error, '操作失败'); }
  finally { busy.value = false; }
}

async function openForm(connection?: BotConnection): Promise<void> {
  editing.value = connection ? structuredClone({ ...connection, config: { ...connection.config, allowedGroupIds: connection.config.allowedGroupIds ? [...connection.config.allowedGroupIds] : undefined } }) : null;
  Object.assign(form, {
    adapterId: connection?.adapterId ?? adapters.value[0]?.id ?? '', displayName: connection?.displayName ?? '',
    endpoint: connection?.config.endpoint ?? '', accountId: connection?.config.accountId ?? '',
    groups: connection?.config.allowedGroupIds?.join('\n') ?? '', token: '', enabled: connection?.enabled ?? true,
  });
  formError.value = '';
  formConflict.value = false;
  formOpen.value = true;
  await nextTick();
  nameInput.value?.focus();
}

function closeForm(): void {
  if (busy.value) return;
  form.token = '';
  formOpen.value = false;
  editing.value = null;
}

function connectionConfig(): BotConnectionConfig {
  if (!form.displayName.trim()) throw new Error('请填写连接名称。');
  if (!formAdapter.value && !editing.value) throw new Error('请选择可用的平台适配器。');
  const config: BotConnectionConfig = {};
  const endpoint = form.endpoint.trim();
  if (form.adapterId === 'onebot' && !endpoint) throw new Error('请填写 OneBot WebSocket 地址。');
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('请填写完整的服务地址。'); }
    const protocols = form.adapterId === 'onebot' ? ['ws:', 'wss:'] : ['https:'];
    if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(form.adapterId === 'onebot' ? 'OneBot 地址需使用 ws:// 或 wss://，且不含凭据、查询参数或片段。' : '服务地址需使用 https://，且不含凭据、查询参数或片段。');
    }
    config.endpoint = endpoint;
  }
  if (form.accountId.trim()) config.accountId = form.accountId.trim();
  if (form.adapterId === 'onebot' && !/^\d+$/.test(config.accountId ?? '')) throw new Error('请填写机器人 QQ 号（仅数字）。');
  if (formAdapter.value?.capabilities.groupMessages || editing.value?.config.allowedGroupIds) {
    const groups = [...new Set(form.groups.split(/[\s,，]+/).filter(Boolean))];
    if (groups.length > 100 || groups.some(group => group.length > 200)) throw new Error('最多配置 100 个群，每个群号不超过 200 个字符。');
    if (form.adapterId === 'onebot' && (!groups.length || groups.some(group => !/^\d+$/.test(group)))) throw new Error('请填写至少一个允许响应的 QQ 群号（仅数字）。');
    config.allowedGroupIds = groups;
  }
  return config;
}

async function saveConnection(): Promise<void> {
  if (busy.value || formConflict.value) return;
  formError.value = '';
  let config: BotConnectionConfig;
  try { config = connectionConfig(); } catch (error) { formError.value = (error as Error).message; return; }
  const original = editing.value;
  const input = {
    displayName: form.displayName.trim(), enabled: form.enabled, config,
    ...(form.token ? { secretValues: { token: form.token } } : {}),
  };
  form.token = '';
  await runAction(async () => {
    try {
      const saved = original
        ? await api.updateConnection(original.id, { ...input, revision: original.revision })
        : await api.createConnection({ ...input, adapterId: form.adapterId });
      if (!alive) return;
      replaceConnection(saved);
      formOpen.value = false;
      editing.value = null;
      notice.value = '连接已保存。';
      await openDetails(saved);
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        formConflict.value = true;
        formError.value = '连接已被其他操作修改。请载入最新配置后重新编辑；本次修改尚未保存。';
      } else formError.value = errorText(error, '保存失败，请重试；如填写过令牌，请重新输入');
    }
  });
}

async function reloadDraft(): Promise<void> {
  const id = editing.value?.id;
  if (!id) return;
  await runAction(async () => {
    await refreshConnections();
    const current = connections.value.find(connection => connection.id === id);
    if (current) await openForm(current);
    else formError.value = '此连接已被删除，请取消编辑后新建连接。';
  });
}

async function toggleConnection(connection: BotConnection): Promise<void> {
  await runAction(async () => {
    replaceConnection(await api.updateConnection(connection.id, { revision: connection.revision, enabled: !connection.enabled }));
    if (selectedId.value === connection.id) {
      login.value = null;
      qrImage.value = '';
      pairing.value = null;
      await refreshDetails();
    }
    notice.value = connection.enabled ? '连接已停用。' : '连接已启用。';
  });
}

async function removeConnection(connection: BotConnection): Promise<void> {
  await runAction(async () => {
    await api.deleteConnection(connection.id);
    listVersion++;
    connections.value = connections.value.filter(item => item.id !== connection.id);
    if (selectedId.value === connection.id) closeDetails();
    deleteId.value = null;
    notice.value = '连接已移除。';
  });
}

async function startLogin(): Promise<void> {
  const id = selectedId.value;
  if (!id) return;
  await runAction(async () => {
    const version = detailVersion;
    qrImage.value = '';
    login.value = null;
    await setLogin(await api.startLogin(id), version);
  });
}

async function startPairing(): Promise<void> {
  const id = selectedId.value;
  if (!id) return;
  await runAction(async () => {
    const version = detailVersion;
    const result = await api.startPairing(id);
    if (alive && version === detailVersion) pairing.value = result;
  });
}

async function confirmPairing(): Promise<void> {
  const id = selectedId.value;
  const candidate = pairing.value?.candidateSenderId;
  if (!id || !candidate || !pairingActive.value) return;
  await runAction(async () => {
    const result = await api.confirmPairing(id, candidate);
    if (alive && selectedId.value === id) pairing.value = result;
    await refreshConnections();
    notice.value = '已确认本人账号，只有该账号的私聊会进入会话。';
  });
}

async function retryDelivery(delivery: BotDelivery): Promise<void> {
  const id = selectedId.value;
  if (!id) return;
  await runAction(async () => {
    await api.retryDelivery(id, delivery.id);
    retryId.value = null;
    await refreshDetails();
    notice.value = '已请求重试，请查看后续投递状态。';
  });
}

function schedulePoll(): void {
  timer = setTimeout(async () => {
    if (!alive) return;
    time.value = Date.now();
    if (!busy.value && !refreshing.value) {
      try {
        await refreshConnections();
        loadError.value = '';
      } catch (error) { loadError.value = errorText(error, '连接状态刷新失败'); }
      if (alive && !busy.value) await refreshDetails();
    }
    if (alive) schedulePoll();
  }, 4000);
}

onMounted(async () => {
  await refresh();
  if (alive) schedulePoll();
});
onBeforeUnmount(() => {
  alive = false;
  listVersion++;
  detailVersion++;
  clearTimeout(timer);
  form.token = '';
  pairing.value = null;
  qrImage.value = '';
});
</script>

<template>
  <section class="bot-panel" aria-label="机器人连接">
    <AervoxSettingsHeading title="机器人连接" description="接入微信本人私聊与指定 QQ 群，收发文字消息。">
      <AervoxButton :disabled="busy || formOpen || !adapters.length" @click="openForm()">添加连接</AervoxButton>
    </AervoxSettingsHeading>
    <div class="bot-toolbar">
      <span class="bot-muted">{{ connections.length }} 个连接 · 启用后保持后台连接</span>
      <AervoxButton size="sm" :loading="refreshing" :disabled="busy" @click="refresh">刷新状态</AervoxButton>
    </div>
    <p v-if="loadError" role="alert" class="bot-error">{{ loadError }}</p>
    <p v-if="actionError" role="alert" class="bot-error">{{ actionError }}</p>
    <p v-if="notice" role="status" class="bot-notice">{{ notice }}</p>
    <p v-if="loading" role="status" class="bot-empty">正在读取机器人连接…</p>
    <p v-else-if="!adapters.length" class="bot-empty">暂无可用的平台适配器。请先在扩展插件中启用微信或 QQ 群机器人插件，再刷新状态。</p>

    <form v-if="formOpen" class="bot-form" aria-label="连接配置" @submit.prevent="saveConnection" @keydown.esc.prevent="closeForm">
      <h3>{{ editing ? '编辑连接' : '添加连接' }}</h3>
      <fieldset :disabled="busy">
        <label class="bot-field">
          <span>连接名称</span>
          <input ref="nameInput" v-model="form.displayName" aria-label="连接名称" maxlength="100" required autocomplete="off" placeholder="例如：我的微信" />
        </label>
        <label class="bot-field">
          <span>平台</span>
          <select v-model="form.adapterId" aria-label="平台" :disabled="!!editing" required>
            <option v-if="editing && !formAdapter" :value="editing.adapterId">{{ editing.adapterId }}（适配器不可用）</option>
            <option v-for="adapter in adapters" :key="adapter.id" :value="adapter.id">{{ adapter.displayName }}</option>
          </select>
        </label>
        <label class="bot-field">
          <span>{{ form.adapterId === 'onebot' ? 'OneBot WebSocket 地址' : '服务地址（可选）' }}</span>
          <input v-model="form.endpoint" aria-label="服务地址" maxlength="2048" :required="form.adapterId === 'onebot'" :placeholder="form.adapterId === 'onebot' ? 'ws://127.0.0.1:3001' : 'https://ilinkai.weixin.qq.com'" autocomplete="off" spellcheck="false" />
          <small v-if="form.adapterId === 'onebot'">填写已登录 QQ 的 OneBot v11 正向 WebSocket 服务地址。</small>
        </label>
        <label v-if="!formAdapter?.capabilities.login || form.accountId" class="bot-field">
          <span>{{ form.adapterId === 'onebot' ? '机器人 QQ 号' : '平台账号 ID' }}</span>
          <input v-model="form.accountId" aria-label="平台账号 ID" maxlength="200" :required="form.adapterId === 'onebot'" autocomplete="off" :inputmode="form.adapterId === 'onebot' ? 'numeric' : 'text'" />
        </label>
        <label v-if="formAdapter?.capabilities.groupMessages || editing?.config.allowedGroupIds" class="bot-field">
          <span>允许响应的群号</span>
          <textarea v-model="form.groups" aria-label="允许响应的群号" rows="3" :required="form.adapterId === 'onebot'" placeholder="每行一个群号，也可用逗号分隔" spellcheck="false" />
          <small>仅处理名单内明确 @ 机器人的文字消息；不会响应其他群。</small>
        </label>
        <label class="bot-field">
          <span>访问令牌（可选）</span>
          <input v-model="form.token" type="password" aria-label="访问令牌" maxlength="16384" autocomplete="new-password" :placeholder="editing?.hasCredentials ? '已保存凭据；留空保留' : '填写服务配置的访问令牌'" />
          <small>{{ formAdapter?.capabilities.login ? '微信可在保存并启用连接后扫码登录。' : '令牌仅用于服务认证。' }}凭据不会回显；提交或关闭表单后清空输入。</small>
        </label>
        <label class="bot-toggle-row">
          <span>保存后启用连接</span>
          <AervoxSwitch v-model="form.enabled" aria-label="保存后启用连接" />
        </label>
      </fieldset>
      <p v-if="formError" role="alert" class="bot-error">{{ formError }}</p>
      <div class="bot-actions">
        <AervoxButton v-if="formConflict" :disabled="busy" @click="reloadDraft">放弃草稿并载入最新配置</AervoxButton>
        <AervoxButton :disabled="busy" @click="closeForm">取消</AervoxButton>
        <AervoxButton variant="primary" type="submit" :loading="busy" :disabled="formConflict">保存连接</AervoxButton>
      </div>
    </form>

    <p v-if="!loading && !connections.length && adapters.length && !formOpen" class="bot-empty">尚未添加连接。添加微信后扫码登录并确认本人账号，或配置允许响应的 QQ 群。</p>
    <div class="settings-list bot-list">
      <AervoxCard v-for="connection in connections" :key="connection.id" class="bot-connection" :selected="selectedId === connection.id">
        <div class="bot-connection-head">
          <div class="bot-connection-copy">
            <h3>{{ connection.displayName }}</h3>
            <p class="bot-muted">{{ adapters.find(adapter => adapter.id === connection.adapterId)?.displayName ?? connection.adapterId }} · {{ connection.enabled ? stateLabels[connection.state] : '已停用' }}</p>
          </div>
          <AervoxSwitch :model-value="connection.enabled" :disabled="busy || formOpen" :aria-label="`启用 ${connection.displayName}`" @update:model-value="toggleConnection(connection)" />
        </div>
        <p v-if="connection.lastError" class="bot-error">{{ connection.lastError }}</p>
        <p v-if="connection.ownerSenderId" class="bot-muted">本人账号：{{ connection.ownerSenderId }}</p>
        <p v-if="connection.config.allowedGroupIds?.length" class="bot-muted">允许的群：{{ connection.config.allowedGroupIds.join('、') }}</p>
        <div class="bot-actions">
          <AervoxButton size="sm" :disabled="busy || formOpen" :aria-expanded="selectedId === connection.id" @click="selectedId === connection.id ? closeDetails() : openDetails(connection)">{{ selectedId === connection.id ? '收起详情' : '登录与投递' }}</AervoxButton>
          <AervoxButton size="sm" :disabled="busy || formOpen" @click="openForm(connection)">编辑</AervoxButton>
          <AervoxButton size="sm" variant="ghost" :disabled="busy || formOpen" @click="deleteId = connection.id">移除</AervoxButton>
        </div>
        <div v-if="deleteId === connection.id" class="bot-confirm" role="group" aria-label="移除连接确认">
          <p>移除「{{ connection.displayName }}」会停止收发，并删除该连接的凭据与配对信息。</p>
          <div class="bot-actions">
            <AervoxButton size="sm" :disabled="busy" @click="deleteId = null">取消移除</AervoxButton>
            <AervoxButton size="sm" variant="danger" :loading="busy" @click="removeConnection(connection)">确认移除</AervoxButton>
          </div>
        </div>
      </AervoxCard>
    </div>
    <section v-if="selected" class="bot-details" :aria-label="`${selected.displayName} 详情`">
      <div class="bot-toolbar">
        <h3>{{ selected.displayName }} · 连接详情</h3>
        <AervoxButton size="sm" :disabled="busy" :loading="detailsLoading" @click="refreshDetails">刷新详情</AervoxButton>
      </div>
      <p v-if="!selected.enabled" class="bot-muted">启用此连接后可登录、配对或重试消息。</p>
      <p v-if="detailsError" role="alert" class="bot-error">{{ detailsError }}</p>
      <section v-if="selectedAdapter?.capabilities.login" class="bot-detail-section" aria-label="扫码登录">
        <h4>1. 登录微信</h4>
        <p class="bot-muted">用微信扫描二维码，并在手机上确认登录。</p>
        <div class="bot-actions bot-actions-start">
          <AervoxButton :disabled="busy || !selected.enabled || formOpen" @click="startLogin">{{ login ? '重新获取二维码' : '获取登录二维码' }}</AervoxButton>
          <span v-if="login" role="status">{{ loginLabels[login.status] }}</span>
        </div>
        <img v-if="qrImage && loginActive" class="bot-qr" :src="qrImage" width="256" height="256" alt="微信登录二维码，请使用微信扫码" />
        <p v-if="login?.message" class="bot-muted">{{ login.message }}</p>
        <p v-if="login?.expiresAt && loginActive" class="bot-muted">有效期至 {{ formatTime(login.expiresAt) }}</p>
        <p v-if="login?.accountId" class="bot-muted">已登录账号：{{ login.accountId }}</p>
      </section>

      <section v-if="selectedAdapter?.capabilities.directMessages" class="bot-detail-section" aria-label="本人账号配对">
        <h4>{{ selectedAdapter.capabilities.login ? '2. ' : '' }}确认本人账号</h4>
        <p class="bot-muted">登录完成后，用你的本人账号私聊机器人发送下面的配对码，再在这里核对并确认发送者。未确认的私聊不会进入会话。</p>
        <p v-if="selected.ownerSenderId">当前本人账号：<strong>{{ selected.ownerSenderId }}</strong></p>
        <AervoxButton :disabled="busy || !selected.enabled || formOpen" @click="startPairing">{{ selected.ownerSenderId ? '重新配对本人账号' : pairingActive ? '重新生成配对码' : '生成配对码' }}</AervoxButton>
        <template v-if="pairingActive">
          <label v-if="pairing?.code" class="bot-field bot-pairing-code">
            <span>发送此配对码</span>
            <input :value="pairing.code" readonly aria-label="配对码" spellcheck="false" @focus="($event.target as HTMLInputElement).select()" />
          </label>
          <p v-else class="bot-muted">已有配对正在等待确认；需要配对码时请重新生成。</p>
          <p class="bot-muted">有效期至 {{ formatTime(pairing?.expiresAt) }}</p>
          <div v-if="pairing?.candidateSenderId" class="bot-confirm" role="group" aria-label="确认本人账号">
            <p>收到配对码的发送者：<strong>{{ pairing.candidateSenderId }}</strong></p>
            <p class="bot-muted">核对该 ID 属于你本人后再确认。确认会替换当前本人账号。</p>
            <AervoxButton variant="primary" :disabled="busy || !selected.enabled || formOpen" @click="confirmPairing">确认此发送者是我本人</AervoxButton>
          </div>
          <p v-else role="status" class="bot-muted">等待本人账号发送配对码…</p>
        </template>
        <p v-else-if="pairing?.code" role="status" class="bot-muted">配对码已过期，请重新生成。</p>
      </section>

      <section class="bot-detail-section" aria-label="消息投递记录">
        <h4>最近投递</h4>
        <p class="bot-muted">“平台已接收”表示平台接受了发送请求。结果未知可能已经送达，重试前请检查原会话。</p>
        <p v-if="detailsLoading" role="status" class="bot-empty">正在读取投递记录…</p>
        <p v-else-if="!deliveries.length && !detailsError" class="bot-empty">暂无投递记录。收到符合条件的文字消息后，回复会出现在这里。</p>
        <ol v-if="deliveries.length" class="bot-deliveries">
          <li v-for="delivery in deliveries" :key="delivery.id" class="bot-delivery">
            <div class="bot-toolbar">
              <strong :class="{ 'bot-error-text': delivery.status === 'failed' || delivery.status === 'unknown' }">{{ deliveryLabels[delivery.status] }}</strong>
              <span class="bot-muted">第 {{ delivery.partIndex + 1 }} 段 · {{ formatTime(delivery.createdAt) }}</span>
            </div>
            <p class="bot-delivery-text">{{ delivery.text }}</p>
            <p v-if="delivery.lastError" class="bot-error">{{ delivery.lastError }}</p>
            <p v-if="delivery.platformMessageId" class="bot-muted">平台消息 ID：{{ delivery.platformMessageId }}</p>
            <AervoxButton v-if="delivery.status === 'failed' || delivery.status === 'unknown'" size="sm" :disabled="busy || !selected.enabled || formOpen" @click="retryId = delivery.id">重试此消息</AervoxButton>
            <div v-if="retryId === delivery.id && (delivery.status === 'failed' || delivery.status === 'unknown')" class="bot-confirm" role="group" aria-label="重试消息确认">
              <p>{{ delivery.status === 'unknown' ? '这条消息可能已经送达。再次发送可能产生重复消息，请确认原会话后重试。' : '将重新发送这段文字。请确认后重试。' }}</p>
              <div class="bot-actions">
                <AervoxButton size="sm" :disabled="busy" @click="retryId = null">取消重试</AervoxButton>
                <AervoxButton size="sm" variant="primary" :disabled="!selected.enabled || formOpen" :loading="busy" @click="retryDelivery(delivery)">确认重新发送</AervoxButton>
              </div>
            </div>
          </li>
        </ol>
      </section>
    </section>
  </section>
</template>

<style scoped>
.bot-panel { min-width: 0; color: var(--text-primary); font-size: 13px; line-height: 1.6; }
.bot-panel h3, .bot-panel h4, .bot-panel p { margin: 0; overflow-wrap: anywhere; }
.bot-panel h3 { font-size: 15px; font-weight: 600; }
.bot-panel h4 { font-size: 14px; font-weight: 600; }
.bot-toolbar, .bot-connection-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.bot-toolbar { margin-bottom: 16px; }
.bot-toolbar > *, .bot-connection-copy { min-width: 0; }
.bot-connection-head { flex-wrap: nowrap; }
.bot-muted { color: var(--text-secondary); font-size: 12px; }
.bot-panel .bot-error { margin-block: 12px; padding: 10px 12px; border-inline-start: 2px solid var(--danger, #c55252); background: var(--bg-soft); color: var(--text-primary); }
.bot-error-text { color: var(--danger, #c55252); }
.bot-panel .bot-notice { margin-block: 12px; color: var(--accent); }
.bot-panel .bot-empty { padding-block: 20px; color: var(--text-secondary); }
.bot-form { margin-block: 20px; padding-block: 20px; border-block: 1px solid var(--border); }
.bot-form fieldset { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; margin: 16px 0; padding: 0; border: 0; }
.bot-field { display: grid; gap: 6px; min-width: 0; }
.bot-field > span { font-weight: 500; }
.bot-field small { color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.bot-field :is(input, select, textarea) { box-sizing: border-box; width: 100%; min-width: 0; min-height: 38px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--avx-radius-xs, 6px); color: var(--text-primary); background: var(--bg-main); font: inherit; }
.bot-field textarea { resize: vertical; }
.bot-field :is(input, select, textarea):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bot-field :is(input, select, textarea):disabled { opacity: 0.6; }
.bot-toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.bot-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.bot-actions-start { justify-content: flex-start; align-items: center; }
.bot-list { display: grid; gap: 12px; margin-block: 16px; }
.bot-connection > p { margin-top: 8px; }
.bot-panel .bot-confirm { margin-top: 12px; padding: 12px; border-inline-start: 2px solid var(--accent); background: var(--bg-soft); }
.bot-confirm > p + p { margin-top: 8px; }
.bot-confirm > .aervox-btn { margin-top: 12px; }
.bot-details { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 24px; }
.bot-detail-section { padding-block: 20px; border-bottom: 1px solid var(--border); }
.bot-detail-section > p { margin-block: 8px 12px; }
.bot-qr { display: block; max-width: 100%; height: auto; margin-top: 16px; border-radius: 6px; background: white; }
.bot-pairing-code { margin-top: 16px; }
.bot-pairing-code input { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
.bot-deliveries { list-style: none; margin: 0; padding: 0; }
.bot-delivery { min-width: 0; padding-block: 16px; border-bottom: 1px solid var(--border); }
.bot-delivery:last-child { border-bottom: 0; padding-bottom: 0; }
.bot-delivery .bot-toolbar { margin-bottom: 8px; }
.bot-delivery-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; }
.bot-delivery > .aervox-btn { margin-top: 12px; }
@media (max-width: 680px) {
  .bot-toolbar { align-items: flex-start; }
  .bot-actions > .aervox-btn { min-width: 0; max-width: 100%; height: auto; min-height: 36px; }
  .bot-actions :deep(.btn-text) { white-space: normal; overflow-wrap: anywhere; }
}
</style>
