<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { CalendarClock, CalendarDays, MapPin, ListTodo, Route, SlidersHorizontal } from 'lucide-vue-next';
import { AervoxButton, AervoxNavDialog, AervoxSettingsHeading } from '@aervox/ui/primitives';
import { useDialogPrompts, useMobileBackNavigation } from '@aervox/ui/material3';
import { CAMPUS_LIMITS, type CampusEvent, type CampusPlace, type CampusTask, type CampusRoute } from '../domain/index.js';
import { useCampusStore, type CampusView } from './store.js';
import { absoluteDateTime, localDateTime, clock, dateLabel } from './time.js';
import CampusPlanSummary from './CampusPlanSummary.vue';

const store = useCampusStore();
const { drawerOpen, activeView, state, plan, writable, loading, saving, planning, exporting, error, planError, feedback, conflict } = store;
const prompts = useDialogPrompts(undefined, drawerOpen);
const mobileBack = useMobileBackNavigation();
const editorVisible = ref(false);
const editorElement = ref<HTMLElement>();
const formError = ref('');
const confirming = ref(false);
type EditorView = 'places' | 'events' | 'tasks' | 'routes';
const pendingDrafts = ref<Record<EditorView, boolean>>({ places: false, events: false, tasks: false, routes: false });
const blocked = computed(() => !writable.value || confirming.value);
let backLayer: ReturnType<NonNullable<typeof mobileBack>['registerLayer']> | undefined;
let trigger: HTMLElement | undefined;
let disposed = false;
const exportUrls = new Set<string>();

const navItems = [
  { id: 'today', label: '出发计划', icon: CalendarClock },
  { id: 'events', label: '课表与日程', icon: CalendarDays },
  { id: 'places', label: '地点', icon: MapPin },
  { id: 'tasks', label: '空档任务', icon: ListTodo },
  { id: 'routes', label: '路线耗时', icon: Route },
  { id: 'settings', label: '出发设置', icon: SlidersHorizontal },
] as const;
const eventStatuses = { scheduled: '待出发', arrived: '已到达', cancelled: '已取消' } as const;
const priorities = { high: '优先', medium: '普通', low: '有余力再做' } as const;
const sortedEvents = computed(() => [...(state.value?.events ?? [])].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)));
const timezone = computed(() => state.value?.settings.timezone ?? 'Asia/Shanghai');
const placeName = (id: string) => state.value?.places.find(item => item.id === id)?.name ?? '地点不可用';
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const routeKey = (route: Pick<CampusRoute, 'originId' | 'destinationId'>) => `${route.originId}:${route.destinationId}`;

const placeDraft = ref({ id: '', isNew: true, name: '', address: '', latitude: '', longitude: '', coordinateSystem: 'gcj02' as 'gcj02' | 'wgs84' });
const eventDraft = ref({ id: '', isNew: true, title: '', startAt: '', endAt: '', placeId: '', status: 'scheduled' as CampusEvent['status'], timezone: 'Asia/Shanghai',
  originalStartAt: '', originalEndAt: '', initialLocalStart: '', initialLocalEnd: '' });
const taskDraft = ref({ id: '', isNew: true, title: '', estimatedMinutes: 10, priority: 'medium' as CampusTask['priority'], status: 'pending' as CampusTask['status'] });
const routeDraft = ref({ originalKey: '', originId: '', destinationId: '', minutes: 10, observedAt: '' });
const settingsDraft = ref({ originId: '', bufferMinutes: 5, timezone: 'Asia/Shanghai' });
const settingsDirty = ref(false);
watch(state, value => {
  if (value && !settingsDirty.value) settingsDraft.value = { ...value.settings, originId: value.settings.originId ?? '' };
}, { immediate: true });

watch([drawerOpen, editorVisible], ([open, editing]) => {
  if (open && editing && !backLayer) backLayer = mobileBack?.registerLayer({ onBack: closeEditor, canDismiss: () => !saving.value });
  else if (!open || !editing) { backLayer?.close(); backLayer = undefined; }
});
watch(drawerOpen, open => { if (!open) editorVisible.value = false; });
watch(activeView, () => { editorVisible.value = false; formError.value = ''; });
onBeforeUnmount(() => { disposed = true; backLayer?.dispose(); backLayer = undefined; exportUrls.forEach(url => URL.revokeObjectURL(url)); exportUrls.clear(); });

async function exportCampusData() {
  const snapshot = await store.readForExport();
  if (!snapshot || disposed) return;
  try {
    const exportedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify({ format: 'aervox-flowcampus', exportedAt, revision: snapshot.revision, state: snapshot.state }, null, 2)], { type: 'application/json' });
    // Revoke previous downloads before creating a new URL; disposal releases the final URL.
    exportUrls.forEach(url => URL.revokeObjectURL(url)); exportUrls.clear();
    const url = URL.createObjectURL(blob);
    exportUrls.add(url);
    const link = document.createElement('a');
    link.href = url; link.download = `flowcampus-${exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    feedback.value = '已导出宿主保存的校园数据，未提交草稿未包含在文件中。';
  } catch { error.value = '此界面暂时无法下载文件，请通过浏览器打开校园管理后导出。'; }
}

function closeEditor() {
  if (saving.value) return;
  editorVisible.value = false;
  void nextTick(() => { if (!disposed && trigger?.isConnected) trigger.focus(); });
}
function showEditor(event?: MouseEvent) {
  trigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  editorVisible.value = true;
  formError.value = '';
  void nextTick(() => {
    if (disposed || !drawerOpen.value || !editorVisible.value) return;
    const field = editorElement.value?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select');
    field?.focus();
    editorElement.value?.scrollIntoView?.({ block: 'nearest' });
  });
}
function chooseView(key: string) {
  if (navItems.some(item => item.id === key)) activeView.value = key as CampusView;
}
async function beginEditor(view: EditorView, target: string | undefined, apply: () => void, event?: MouseEvent) {
  if (blocked.value || activeView.value !== view) return;
  const currentId = view === 'places' ? placeDraft.value.id : view === 'events' ? eventDraft.value.id : view === 'tasks' ? taskDraft.value.id : routeDraft.value.originalKey;
  if (pendingDrafts.value[view]) {
    if (target === undefined || currentId === target) { showEditor(event); return; }
    confirming.value = true;
    try {
      await prompts.confirm('切换条目会清除当前类别的未保存草稿。', '切换编辑条目', { confirmButtonText: '切换条目', cancelButtonText: '保留草稿' });
      if (disposed || !drawerOpen.value || activeView.value !== view || !writable.value) return;
    } catch { return; }
    finally { if (!disposed) confirming.value = false; }
  }
  apply();
  pendingDrafts.value[view] = true;
  showEditor(event);
}
function editPlace(item?: CampusPlace, event?: MouseEvent) {
  return beginEditor('places', item?.id, () => {
    placeDraft.value = item ? { ...item, isNew: false, latitude: item.coords ? String(item.coords.latitude) : '', longitude: item.coords ? String(item.coords.longitude) : '', coordinateSystem: item.coords?.coordinateSystem ?? 'gcj02' }
      : { id: newId('place'), isNew: true, name: '', address: '', latitude: '', longitude: '', coordinateSystem: 'gcj02' };
  }, event);
}
function editEvent(item?: CampusEvent, event?: MouseEvent) {
  return beginEditor('events', item?.id, () => {
    const initialLocalStart = item ? localDateTime(item.startAt, timezone.value) : '';
    const initialLocalEnd = item ? localDateTime(item.endAt, timezone.value) : '';
    eventDraft.value = item ? { ...item, isNew: false, startAt: initialLocalStart, endAt: initialLocalEnd, timezone: timezone.value,
      originalStartAt: item.startAt, originalEndAt: item.endAt, initialLocalStart, initialLocalEnd }
      : { id: newId('event'), isNew: true, title: '', startAt: '', endAt: '', placeId: state.value?.places[0]?.id ?? '', status: 'scheduled', timezone: timezone.value,
        originalStartAt: '', originalEndAt: '', initialLocalStart, initialLocalEnd };
  }, event);
}
function editTask(item?: CampusTask, event?: MouseEvent) {
  return beginEditor('tasks', item?.id, () => {
    taskDraft.value = item ? { ...item, isNew: false } : { id: newId('task'), isNew: true, title: '', estimatedMinutes: 10, priority: 'medium', status: 'pending' };
  }, event);
}
function editRoute(item?: CampusRoute, event?: MouseEvent) {
  return beginEditor('routes', item ? routeKey(item) : undefined, () => {
    routeDraft.value = item ? { originalKey: routeKey(item), originId: item.originId, destinationId: item.destinationId, minutes: item.durationSeconds / 60, observedAt: new Date().toISOString() }
      : { originalKey: '', originId: state.value?.settings.originId ?? '', destinationId: '', minutes: 10, observedAt: new Date().toISOString() };
  }, event);
}
function requireExisting(id: string, items: readonly { id: string }[]) {
  if (id && !items.some(item => item.id === id)) throw new Error('此条目已被删除。草稿仍保留；可选择“另存为新条目”。');
}
async function submitEditor() {
  if (blocked.value || !state.value) return;
  formError.value = '';
  const current = state.value;
  const view = activeView.value as EditorView;
  try {
    let next = current;
    if (activeView.value === 'places') {
      const draft = placeDraft.value;
      if (!draft.isNew) requireExisting(draft.id, current.places);
      if (Boolean(draft.latitude.trim()) !== Boolean(draft.longitude.trim())) throw new Error('请同时填写经纬度，或同时留空。');
      const item: CampusPlace = { id: draft.id, name: draft.name.trim(), address: draft.address.trim(),
        ...(draft.latitude.trim() && draft.longitude.trim() ? { coords: { latitude: Number(draft.latitude), longitude: Number(draft.longitude), coordinateSystem: draft.coordinateSystem } } : {}) };
      next = { ...current, places: current.places.some(value => value.id === draft.id) ? current.places.map(value => value.id === draft.id ? item : value) : [...current.places, item] };
    } else if (activeView.value === 'events') {
      const draft = eventDraft.value;
      if (!draft.isNew) requireExisting(draft.id, current.events);
      // An unchanged local field retains its known instant, including seconds and DST folds.
      const item: CampusEvent = { id: draft.id, title: draft.title.trim(), placeId: draft.placeId, status: draft.status,
        startAt: draft.originalStartAt && draft.startAt === draft.initialLocalStart ? draft.originalStartAt : absoluteDateTime(draft.startAt, draft.timezone),
        endAt: draft.originalEndAt && draft.endAt === draft.initialLocalEnd ? draft.originalEndAt : absoluteDateTime(draft.endAt, draft.timezone) };
      if (Date.parse(item.endAt) <= Date.parse(item.startAt)) throw new Error('结束时间必须晚于开始时间。');
      next = { ...current, events: current.events.some(value => value.id === draft.id) ? current.events.map(value => value.id === draft.id ? item : value) : [...current.events, item] };
    } else if (activeView.value === 'tasks') {
      const draft = taskDraft.value;
      if (!draft.isNew) requireExisting(draft.id, current.tasks);
      const item: CampusTask = { id: draft.id, title: draft.title.trim(), estimatedMinutes: Number(draft.estimatedMinutes), priority: draft.priority, status: draft.status };
      next = { ...current, tasks: current.tasks.some(value => value.id === draft.id) ? current.tasks.map(value => value.id === draft.id ? item : value) : [...current.tasks, item] };
    } else if (activeView.value === 'routes') {
      const draft = routeDraft.value;
      const item: CampusRoute = { originId: draft.originId, destinationId: draft.destinationId, durationSeconds: Math.round(Number(draft.minutes) * 60), source: 'manual', observedAt: draft.observedAt };
      const committed = current.routes.some(value => routeKey(value) === routeKey(item) && value.observedAt === draft.observedAt);
      if (draft.originalKey && !current.routes.some(value => routeKey(value) === draft.originalKey) && !committed) throw new Error('此路线已被删除。草稿仍保留；可选择“另存为新条目”。');
      const others = current.routes.filter(value => routeKey(value) !== draft.originalKey);
      const previous = others.find(value => routeKey(value) === routeKey(item));
      if (previous && previous.observedAt !== draft.observedAt) throw new Error('这两个地点的同方向路线已存在，请编辑已有路线。');
      if (item.originId === item.destinationId) throw new Error('请选择不同的起点与终点；同一地点无需记录路线。');
      next = { ...current, routes: [...others.filter(value => routeKey(value) !== routeKey(item)), item] };
    }
    if (await store.save(next)) {
      pendingDrafts.value[view] = false;
      if (activeView.value === view) closeEditor();
    }
  } catch (cause) { formError.value = cause instanceof Error ? cause.message : '请核对表单。'; }
}
function saveAsNew() {
  if (activeView.value === 'places') { placeDraft.value.id = newId('place'); placeDraft.value.isNew = true; }
  if (activeView.value === 'events') { eventDraft.value.id = newId('event'); eventDraft.value.isNew = true; }
  if (activeView.value === 'tasks') { taskDraft.value.id = newId('task'); taskDraft.value.isNew = true; }
  if (activeView.value === 'routes') { routeDraft.value.originalKey = ''; routeDraft.value.observedAt = new Date().toISOString(); }
  formError.value = '已转为新增草稿，请核对后保存。';
}
const editingExisting = computed(() => activeView.value === 'places' ? !placeDraft.value.isNew
  : activeView.value === 'events' ? !eventDraft.value.isNew : activeView.value === 'tasks' ? !taskDraft.value.isNew : Boolean(routeDraft.value.originalKey));
const draftAlreadySaved = computed(() => !editingExisting.value && (activeView.value === 'places' ? state.value?.places.some(item => item.id === placeDraft.value.id)
  : activeView.value === 'events' ? state.value?.events.some(item => item.id === eventDraft.value.id)
  : activeView.value === 'tasks' ? state.value?.tasks.some(item => item.id === taskDraft.value.id)
  : state.value?.routes.some(item => routeKey(item) === `${routeDraft.value.originId}:${routeDraft.value.destinationId}` && item.observedAt === routeDraft.value.observedAt)));
function placeInUse(id: string): boolean {
  return Boolean(state.value && (state.value.settings.originId === id || state.value.events.some(item => item.placeId === id)
    || state.value.routes.some(item => item.originId === id || item.destinationId === id)));
}
async function remove(kind: 'places' | 'events' | 'tasks' | 'routes', key: string, title: string) {
  if (blocked.value || !state.value) return;
  confirming.value = true;
  try {
    await prompts.confirm(`删除“${title}”？已保存的其他条目会保留。`, '删除条目', { confirmButtonText: '删除', cancelButtonText: '保留', type: 'warning' });
    if (disposed || !writable.value || !state.value) return;
    const current = state.value;
    if (kind === 'places' && placeInUse(key)) { error.value = '地点已被其他记录引用，请先解除引用再删除。'; return; }
    const exists = kind === 'routes' ? current.routes.some(item => routeKey(item) === key) : current[kind].some(item => item.id === key);
    if (!exists) { feedback.value = '该条目已被删除，其他数据已保留。'; return; }
    if (kind === 'routes') await store.save({ ...current, routes: current.routes.filter(item => routeKey(item) !== key) });
    else await store.save({ ...current, [kind]: current[kind].filter(item => item.id !== key) });
  } catch { /* Closing a confirmation leaves the record intact. */ }
  finally { if (!disposed) confirming.value = false; }
}
async function markEvent(id: string, status: CampusEvent['status']) {
  if (blocked.value || !state.value) return;
  await store.save({ ...state.value, events: state.value.events.map(item => item.id === id ? { ...item, status } : item) });
}
async function markTask(id: string, status: CampusTask['status']) {
  if (blocked.value || !state.value) return;
  await store.save({ ...state.value, tasks: state.value.tasks.map(item => item.id === id ? { ...item, status } : item) });
}
async function saveSettings() {
  if (blocked.value || !state.value) return;
  const draft = settingsDraft.value;
  const ok = await store.save({ ...state.value, settings: { originId: draft.originId || null, bufferMinutes: Number(draft.bufferMinutes), timezone: draft.timezone.trim() } });
  if (ok) settingsDirty.value = false;
}
const editorTitle = computed(() => `${editingExisting.value ? '编辑' : '新增'}${activeView.value === 'events' ? '课程或日程' : activeView.value === 'places' ? '地点' : activeView.value === 'tasks' ? '空档任务' : '路线耗时'}`);
</script>

<template>
  <AervoxNavDialog v-model="drawerOpen" title="只争朝夕" subtitle="把课程、行程与空档安排在一起" :icon="CalendarClock" :items="navItems" :active-key="activeView" nav-aria-label="校园规划分类" custom-class="campus-dialog" width="min(920px, calc(100vw - 28px))" height="min(760px, calc(100dvh - 48px))" @update:active-key="chooseView">
    <template #content>
      <div class="campus-content" :aria-busy="loading || saving">
        <div class="campus-sync-row"><span>{{ saving ? '正在保存…' : loading ? '正在读取…' : '课程与设置由本机服务保存' }}</span><div class="campus-sync-actions"><AervoxButton size="sm" variant="ghost" :disabled="loading || saving || exporting" @click="exportCampusData">{{ exporting ? '正在导出…' : '导出校园数据' }}</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="loading || saving || confirming" @click="store.reload()">{{ conflict ? '重新加载并保留草稿' : '重新加载' }}</AervoxButton></div></div>
        <p v-if="error" class="campus-error" role="alert">{{ error }}</p>
        <p v-else-if="feedback" class="campus-feedback" role="status">{{ feedback }}</p>
        <p v-if="!state && !loading" class="campus-empty">尚未读取到校园数据，请先重新加载。</p>

        <template v-if="state">
          <section v-if="activeView === 'today'" class="campus-section">
            <p v-if="planError" class="campus-error" role="alert">{{ planError }}</p>
            <p v-else-if="!plan" class="campus-empty" role="status">{{ planning ? '正在计算出发计划…' : '请刷新以计算出发计划。' }}</p>
            <CampusPlanSummary v-if="plan" :plan="plan" />
            <div class="campus-actions">
              <AervoxButton v-if="plan?.nextEvent" variant="primary" :disabled="blocked" @click="markEvent(plan.nextEvent.id, 'arrived')">标记已到达</AervoxButton>
              <AervoxButton variant="secondary" :disabled="loading || saving || planning" @click="store.refreshPlan()">刷新计划</AervoxButton>
              <AervoxButton variant="ghost" @click="chooseView(!state.places.length ? 'places' : !state.events.length ? 'events' : 'settings')">{{ !state.places.length ? '先添加地点' : !state.events.length ? '添加课程与日程' : '调整出发设置' }}</AervoxButton>
            </div>
          </section>

          <section v-else-if="activeView === 'settings'" class="campus-section">
            <AervoxSettingsHeading title="从哪里出发" description="当前地点与缓冲会影响每次出发计算。改变时区只改变时间显示，已保存日程的时刻保持。" />
            <form class="campus-form" @submit.prevent="saveSettings" @input="settingsDirty = true" @change="settingsDirty = true">
              <label>当前出发地点<select v-model="settingsDraft.originId" class="aervox-field" :disabled="loading || saving"><option value="">尚未设置</option><option v-for="item in state.places" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
              <label>提前预留（分钟）<input v-model.number="settingsDraft.bufferMinutes" class="aervox-field" type="number" min="0" max="120" step="1" required :disabled="loading || saving" /></label>
              <label>显示时区<input v-model="settingsDraft.timezone" class="aervox-field" placeholder="Asia/Shanghai" maxlength="80" required :disabled="loading || saving" /></label>
              <p class="campus-note">路线耗时使用手工估算。后台通知、持续定位和真实地图查询尚未接入。</p>
              <AervoxButton type="submit" variant="primary" :disabled="blocked">保存出发设置</AervoxButton>
            </form>
          </section>

          <section v-else class="campus-section">
            <div class="campus-section-title">
              <AervoxSettingsHeading :title="navItems.find(item => item.id === activeView)?.label ?? ''" :description="activeView === 'events' ? `按 ${timezone} 录入具体日期；每次课程可分别标记状态。` : activeView === 'places' ? '先添加校园地点，再用于日程和路线。' : activeView === 'tasks' ? '填入预计分钟数，出发前只推荐放得下的待办。' : '分方向记录耗时，所有新增或编辑均为手工估算。'" />
              <AervoxButton v-if="activeView === 'places'" :disabled="blocked || (!pendingDrafts.places && state.places.length >= CAMPUS_LIMITS.places)" @click="editPlace(undefined, $event)">{{ pendingDrafts.places ? '继续地点草稿' : '添加地点' }}</AervoxButton>
              <AervoxButton v-if="activeView === 'events'" :disabled="blocked || !state.places.length || (!pendingDrafts.events && state.events.length >= CAMPUS_LIMITS.events)" @click="editEvent(undefined, $event)">{{ pendingDrafts.events ? '继续日程草稿' : '添加课程或日程' }}</AervoxButton>
              <AervoxButton v-if="activeView === 'tasks'" :disabled="blocked || (!pendingDrafts.tasks && state.tasks.length >= CAMPUS_LIMITS.tasks)" @click="editTask(undefined, $event)">{{ pendingDrafts.tasks ? '继续任务草稿' : '添加任务' }}</AervoxButton>
              <AervoxButton v-if="activeView === 'routes'" :disabled="blocked || state.places.length < 2 || (!pendingDrafts.routes && state.routes.length >= CAMPUS_LIMITS.routes)" @click="editRoute(undefined, $event)">{{ pendingDrafts.routes ? '继续路线草稿' : '添加路线' }}</AervoxButton>
            </div>

            <ul v-if="activeView === 'events'" class="campus-list">
              <li v-for="item in sortedEvents" :key="item.id"><div class="campus-item-main"><strong>{{ item.title }}</strong><span class="campus-item-status">{{ eventStatuses[item.status] }}</span><p>{{ dateLabel(item.startAt, timezone) }} {{ clock(item.startAt, timezone) }}–{{ clock(item.endAt, timezone) }} · {{ placeName(item.placeId) }}</p></div><div class="campus-item-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editEvent(item, $event)">编辑</AervoxButton><AervoxButton v-if="item.status === 'scheduled'" size="sm" variant="ghost" :disabled="blocked" @click="markEvent(item.id, 'arrived')">已到达</AervoxButton><AervoxButton v-if="item.status === 'scheduled'" size="sm" variant="ghost" :disabled="blocked" @click="markEvent(item.id, 'cancelled')">取消日程</AervoxButton><AervoxButton v-else size="sm" variant="ghost" :disabled="blocked" @click="markEvent(item.id, 'scheduled')">恢复待出发</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="remove('events', item.id, item.title)">删除</AervoxButton></div></li>
              <li v-if="!state.events.length" class="campus-empty">{{ state.places.length ? '还没有课程或日程。请按实际日期添加。' : '还没有地点，请先到“地点”添加教室或其他目的地。' }}</li>
            </ul>
            <ul v-if="activeView === 'places'" class="campus-list">
              <li v-for="item in state.places" :key="item.id"><div class="campus-item-main"><strong>{{ item.name }}</strong><p>{{ item.address || '未填写地址' }}</p><small v-if="placeInUse(item.id)">正在被出发设置、日程或路线引用，解除引用后可删除。</small></div><div class="campus-item-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editPlace(item, $event)">编辑</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked || placeInUse(item.id)" @click="remove('places', item.id, item.name)">删除</AervoxButton></div></li>
              <li v-if="!state.places.length" class="campus-empty">添加宿舍、教学楼或食堂等常用地点。</li>
            </ul>
            <ul v-if="activeView === 'tasks'" class="campus-list">
              <li v-for="item in state.tasks" :key="item.id"><div class="campus-item-main"><strong>{{ item.title }}</strong><span class="campus-item-status">{{ item.status === 'done' ? '已完成' : '待完成' }}</span><p>{{ item.estimatedMinutes }} 分钟 · {{ priorities[item.priority] }}</p></div><div class="campus-item-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editTask(item, $event)">编辑</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="markTask(item.id, item.status === 'done' ? 'pending' : 'done')">{{ item.status === 'done' ? '恢复待办' : '完成' }}</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="remove('tasks', item.id, item.title)">删除</AervoxButton></div></li>
              <li v-if="!state.tasks.length" class="campus-empty">录入能在零碎时间完成的任务，例如复习几个单词。</li>
            </ul>
            <ul v-if="activeView === 'routes'" class="campus-list">
              <li v-for="item in state.routes" :key="routeKey(item)"><div class="campus-item-main"><strong>{{ placeName(item.originId) }} → {{ placeName(item.destinationId) }}</strong><p>约 {{ Math.ceil(item.durationSeconds / 60) }} 分钟 · {{ item.source === 'manual' ? '手工估算' : '已有地图路线记录' }}</p><small>反方向需单独记录；不代表实时路况。</small></div><div class="campus-item-actions"><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="editRoute(item, $event)">编辑</AervoxButton><AervoxButton size="sm" variant="ghost" :disabled="blocked" @click="remove('routes', routeKey(item), `${placeName(item.originId)} → ${placeName(item.destinationId)}`)">删除</AervoxButton></div></li>
              <li v-if="!state.routes.length" class="campus-empty">{{ state.places.length < 2 ? '先添加两个地点，再记录步行或其他通勤的耗时。' : '没有路线耗时，暂时无法计算不同地点间的出发时间。' }}</li>
            </ul>

            <section v-if="editorVisible" ref="editorElement" class="campus-editor" :aria-label="editorTitle">
              <div class="campus-editor-heading"><h3>{{ editorTitle }}</h3><AervoxButton size="sm" variant="ghost" :disabled="saving" @click="closeEditor">收起草稿</AervoxButton></div>
              <form class="campus-form" @submit.prevent="submitEditor">
                <template v-if="activeView === 'places'">
                  <label>地点名称<input v-model="placeDraft.name" class="aervox-field" maxlength="160" required :disabled="loading || saving" /></label>
                  <label>地址或说明<input v-model="placeDraft.address" class="aervox-field" maxlength="300" :disabled="loading || saving" /></label>
                  <details class="campus-coordinate-details"><summary>可选：地点坐标</summary><div class="campus-field-pair"><label>纬度<input v-model="placeDraft.latitude" class="aervox-field" type="number" min="-90" max="90" step="any" :disabled="loading || saving" /></label><label>经度<input v-model="placeDraft.longitude" class="aervox-field" type="number" min="-180" max="180" step="any" :disabled="loading || saving" /></label></div><label>坐标系<select v-model="placeDraft.coordinateSystem" class="aervox-field" :disabled="loading || saving"><option value="gcj02">GCJ-02（高德等地图）</option><option value="wgs84">WGS-84（GPS）</option></select></label></details>
                </template>
                <template v-if="activeView === 'events'">
                  <label>课程或日程名称<input v-model="eventDraft.title" class="aervox-field" maxlength="160" required :disabled="loading || saving" /></label>
                  <div class="campus-field-pair"><label>开始时间<input v-model="eventDraft.startAt" class="aervox-field" type="datetime-local" required :disabled="loading || saving" /></label><label>结束时间<input v-model="eventDraft.endAt" class="aervox-field" type="datetime-local" required :disabled="loading || saving" /></label></div>
                  <p class="campus-note">以上草稿时间使用 {{ eventDraft.timezone }}。</p>
                  <label>目的地点<select v-model="eventDraft.placeId" class="aervox-field" required :disabled="loading || saving"><option value="" disabled>选择地点</option><option v-for="item in state.places" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
                  <label>日程状态<select v-model="eventDraft.status" class="aervox-field" :disabled="loading || saving"><option value="scheduled">待出发</option><option value="arrived">已到达</option><option value="cancelled">已取消</option></select></label>
                </template>
                <template v-if="activeView === 'tasks'">
                  <label>任务名称<input v-model="taskDraft.title" class="aervox-field" maxlength="160" required :disabled="loading || saving" /></label>
                  <label>预计用时（分钟）<input v-model.number="taskDraft.estimatedMinutes" class="aervox-field" type="number" min="1" max="1440" step="1" required :disabled="loading || saving" /></label>
                  <label>优先程度<select v-model="taskDraft.priority" class="aervox-field" :disabled="loading || saving"><option value="high">优先</option><option value="medium">普通</option><option value="low">有余力再做</option></select></label>
                  <label>任务状态<select v-model="taskDraft.status" class="aervox-field" :disabled="loading || saving"><option value="pending">待完成</option><option value="done">已完成</option></select></label>
                </template>
                <template v-if="activeView === 'routes'">
                  <label>起点<select v-model="routeDraft.originId" class="aervox-field" required :disabled="loading || saving"><option value="" disabled>选择起点</option><option v-for="item in state.places" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
                  <label>终点<select v-model="routeDraft.destinationId" class="aervox-field" required :disabled="loading || saving"><option value="" disabled>选择终点</option><option v-for="item in state.places" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
                  <label>预计耗时（分钟）<input v-model.number="routeDraft.minutes" class="aervox-field" type="number" min="0" max="1440" step="any" required :disabled="loading || saving" /></label>
                  <p class="campus-note">保存为手工估算，不调用地图服务。反向路线需另建。</p>
                </template>
                <p v-if="formError" class="campus-error" role="alert">{{ formError }}</p>
                <p v-if="draftAlreadySaved" class="campus-note" role="status">重新加载发现此草稿已保存。再保存会更新同一条目。</p>
                <div class="campus-actions"><AervoxButton type="submit" variant="primary" :disabled="blocked">{{ saving ? '正在保存…' : '保存条目' }}</AervoxButton><AervoxButton v-if="editingExisting" variant="ghost" :disabled="blocked" @click="saveAsNew">另存为新条目</AervoxButton></div>
              </form>
            </section>
          </section>
        </template>
      </div>
    </template>
  </AervoxNavDialog>
</template>

<style>
.campus-dialog .aervox-nav-layout, .campus-dialog .aervox-nav-detail { min-width: 0; }
.campus-dialog .aervox-nav-detail { padding: 24px; }
.campus-dialog .aervox-nav-sidebar { flex-shrink: 0; }
@media (max-width: 680px) { .campus-dialog .aervox-nav-detail { padding: 20px 16px 32px; } }
</style>
<style scoped>
.campus-content { color: var(--text-primary); min-width: 0; }
.campus-sync-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; justify-content: space-between; font-size: 12px; color: var(--text-secondary); margin-bottom: 20px; }
.campus-sync-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.campus-section { min-width: 0; }
.campus-section-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.campus-empty { font-size: 14px; color: var(--text-secondary); line-height: 1.7; margin: 20px 0; }
.campus-error { font-size: 13px; line-height: 1.65; color: var(--md-sys-color-error, #ae3333); margin: 12px 0 20px; overflow-wrap: anywhere; }
.campus-feedback { font-size: 12px; line-height: 1.6; color: var(--text-secondary); margin: 0 0 20px; }
.campus-list { list-style: none; padding: 0; margin: 0; }
.campus-list > li { padding: 20px 0; border-bottom: 1px solid var(--border); }
.campus-list > li:first-child { padding-top: 8px; }
.campus-item-main { line-height: 1.6; overflow-wrap: anywhere; }
.campus-item-main strong { font-size: 15px; font-weight: 600; }
.campus-item-main p { font-size: 13px; color: var(--text-secondary); margin: 6px 0; }
.campus-item-main small { color: var(--text-secondary); font-size: 12px; }
.campus-item-status { display: inline-block; margin-left: 10px; color: var(--text-secondary); font-size: 12px; }
.campus-item-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.campus-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.campus-editor { margin-top: 32px; padding-top: 24px; border-top: 2px solid var(--border); }
.campus-editor-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
.campus-editor-heading h3 { font-size: 18px; margin: 0; }
.campus-form { display: flex; flex-direction: column; align-items: stretch; gap: 20px; min-width: 0; max-width: 560px; }
.campus-form label { display: grid; gap: 8px; font-size: 13px; color: var(--text-primary); min-width: 0; }
.campus-form .aervox-field { width: 100%; min-width: 0; min-height: 48px; box-sizing: border-box; font: inherit; }
.campus-form :is(input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.campus-field-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.campus-note { font-size: 12px; line-height: 1.7; color: var(--text-secondary); margin: -6px 0 0; }
.campus-coordinate-details { display: grid; gap: 16px; }
.campus-coordinate-details summary { font-size: 13px; cursor: pointer; padding: 10px 0; }
.campus-coordinate-details > label { margin-top: 16px; }
@media (max-width: 580px) { .campus-field-pair { grid-template-columns: minmax(0, 1fr); } .campus-form input[type="datetime-local"] { max-width: 100%; } }
</style>
