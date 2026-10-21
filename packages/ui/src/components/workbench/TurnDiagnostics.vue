<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Activity, Download, RefreshCw } from 'lucide-vue-next';
import { useAervoxTurnDiagnostics } from '@aervox/api-client';
import type { TurnDiagnostics } from '@aervox/contracts';
import { AervoxButton, AervoxDialog } from '../../primitives';

const props = defineProps<{ turnId: string }>();
const api = useAervoxTurnDiagnostics();
const open = ref(false);
const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const report = ref<TurnDiagnostics | null>(null);
const attemptId = ref('');
let generation = 0;
const selected = computed(() => report.value?.attempts.find(item => item.id === report.value?.selectedAttemptId));
const labels: Record<string, string> = {
  Created: '等待执行', Running: '执行中', CancelRequested: '正在取消', Completed: '已完成', Failed: '失败',
  Interrupted: '已中断', Cancelled: '已取消', completed: '已完成', failed: '失败', started: '执行中',
  executed: '已执行', rejected: '已拒绝', duplicate: '重复调用', timeout_error: '已超时',
  pending_approval: '等待审批', reserved: '已预留', executing: '执行中', pending: '待决定', granted: '已批准', denied: '已拒绝',
  cancelled: '已取消', deadline_exceeded: '执行期限已到', max_steps: '达到步数上限',
  MODEL_UNAVAILABLE: '模型不可用', deletion_blocked: '删除门禁阻止执行', turn_timeout: '回合超时',
  lease_lost: '执行租约已失效', tools_disabled: '工具已禁用', repeat_tool: '工具重复调用达到上限',
  budget_exhausted: '预算已用尽', token_budget_exceeded: 'Token 预算已用尽',
  token_or_call_budget_exceeded: 'Token 或调用预算已用尽', model_incomplete: '模型输出未完成',
  model_length: '模型输出达到长度上限', model_content_filter: '模型内容过滤',
};
const label = (value: string) => labels[value] ?? value;
const incomplete = computed(() => report.value && Object.values(report.value.truncated).some(Boolean));

async function load(id?: string) {
  const stamp = ++generation;
  loading.value = true; error.value = '';
  try {
    const value = await api.get(props.turnId, id || undefined);
    if (stamp !== generation) return;
    report.value = value; attemptId.value = value.selectedAttemptId ?? '';
  } catch {
    if (stamp === generation) { report.value = null; error.value = '无法读取运行详情，记录可能已删除。请稍后重试。'; }
  } finally { if (stamp === generation) loading.value = false; }
}
watch(open, value => {
  if (value) { report.value = null; attemptId.value = ''; void load(); }
  else { generation++; loading.value = false; error.value = ''; report.value = null; }
});
onBeforeUnmount(() => { generation++; open.value = false; });
watch(() => props.turnId, () => { generation++; open.value = false; report.value = null; });

async function download() {
  const turnId = props.turnId;
  const stamp = generation;
  exporting.value = true; error.value = '';
  try {
    // Re-read the same Attempt before export; never export a stale deleted Turn.
    const value = await api.get(turnId, attemptId.value || undefined);
    if (!open.value || stamp !== generation || turnId !== props.turnId) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'aervox-run-diagnostics.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch { if (stamp === generation) error.value = '导出失败，请刷新运行详情后重试。'; }
  finally { exporting.value = false; }
}
</script>

<template>
  <AervoxButton variant="ghost" type="button" class="run-details-entry" @click="open = true">
    <Activity :size="14" aria-hidden="true" />运行详情
  </AervoxButton>
  <AervoxDialog v-model="open" title="运行详情" subtitle="来自已保存的执行记录" :icon="Activity" size="lg" destroy-on-close>
    <section class="run-details" aria-label="运行诊断" :aria-busy="loading">
      <div class="run-details-controls">
        <label v-if="report?.attempts.length" class="run-attempt-picker">执行尝试
          <select v-model="attemptId" :disabled="loading || exporting" @change="load(attemptId)">
            <option v-for="item in report.attempts" :key="item.id" :value="item.id">第 {{ item.attempt }} 次 · {{ label(item.status) }}</option>
          </select>
        </label>
        <AervoxButton variant="ghost" type="button" :disabled="loading || exporting" @click="load(attemptId)"><RefreshCw :size="14" />刷新</AervoxButton>
      </div>
      <p v-if="loading" role="status">正在读取运行记录…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="report && !loading">
        <dl class="run-details-summary">
          <div><dt>执行状态</dt><dd>{{ label(selected?.status ?? report.status) }}</dd></div>
          <div><dt>结束原因</dt><dd>{{ report.terminationReason ? label(report.terminationReason) : '暂无记录' }}</dd></div>
          <div><dt>回合标识</dt><dd>{{ report.turnId }}</dd></div>
          <div><dt>尝试标识</dt><dd>{{ report.selectedAttemptId ?? '尚未开始' }}</dd></div>
        </dl>
        <p v-if="incomplete" role="status">记录较多，本次仅展示部分记录。</p>
        <h3>模型调用</h3>
        <p v-if="!report.modelRuns.length">暂无记录</p>
        <ul v-else class="run-record-list">
          <li v-for="run in report.modelRuns" :key="run.id">
            <strong>步骤 {{ run.step ?? '未知' }} · {{ label(run.status) }}</strong>
            <span>{{ run.provider }} / {{ run.modelId }} · {{ run.latencyMs === null ? '耗时暂无记录' : `${run.latencyMs} ms` }}</span>
            <small>模型记录：{{ run.id }}<br>上下文清单：{{ run.contextManifestId ?? '暂无记录' }}</small>
          </li>
        </ul>
        <h3>工具执行</h3>
        <p v-if="!report.tools.length">暂无记录</p>
        <ul v-else class="run-record-list"><li v-for="tool in report.tools" :key="tool.invocationId"><strong>{{ tool.name }} · {{ label(tool.status) }}</strong><small>{{ tool.invocationId }}</small></li></ul>
        <h3>审批</h3>
        <p v-if="!report.approvals.length">暂无记录</p>
        <ul v-else class="run-record-list"><li v-for="approval in report.approvals" :key="approval.id"><strong>{{ approval.toolName }} · {{ label(approval.state) }}</strong><small>{{ approval.id }}</small></li></ul>
        <p class="run-details-note">裁剪报告、插件时间线与工具步骤关联暂无记录。执行期间刷新可能看到新增记录；暂无记录不表示未发生。</p>
      </template>
      <div class="run-details-export">
        <AervoxButton variant="secondary" type="button" :disabled="!report || loading || exporting" @click="download"><Download :size="14" />{{ exporting ? '正在导出…' : '导出诊断摘要' }}</AervoxButton>
        <p class="run-details-note">摘要不含对话正文、工具参数和输出；保留运行标识及模型、工具名称。此摘要不用于重放工具。</p>
      </div>
    </section>
  </AervoxDialog>
</template>

<style scoped>
.run-details { color: var(--text-primary); font-size: 14px; }
.run-details-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.run-attempt-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
select { max-width: 100%; padding: 6px 10px; color: var(--text-primary); background: var(--bg-main); border: 1px solid var(--border); border-radius: 8px; }
.run-details-summary { display: grid; gap: 12px; margin: 0 0 24px; }
.run-details-summary > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 12px; }
dt, .run-details-note, small { color: var(--text-secondary); }
dd { margin: 0; overflow-wrap: anywhere; }
h3 { margin: 24px 0 10px; font-size: 14px; }
.run-record-list { list-style: none; padding: 0; margin: 0; }
.run-record-list li { display: grid; gap: 6px; padding: 12px 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.run-record-list strong { font-weight: 500; }
.run-details-note { font-size: 12px; line-height: 1.7; }
.run-details-export { margin-top: 24px; }
</style>
