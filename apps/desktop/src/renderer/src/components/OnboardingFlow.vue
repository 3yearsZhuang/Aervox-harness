<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {useAervoxLLM, type LLMConfigDto, type LLMProviderType} from '@aervox/api-client'
import {AervoxBrandMark, AervoxCompanionMark} from '@aervox/ui'
import Live2DPet from '@/components/Live2DPet.vue'
import {applyOnboardingProvider, validateOnboardingModel} from '@/onboarding-model'

const emit = defineEmits<{complete: []}>()
const llm = useAervoxLLM()
const step = ref(1)
const draft = ref<LLMConfigDto>({
  enabled: true,
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  modelId: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 4096,
  settings: {},
})
const isLaunching = ref(false)
const launchPhase = ref<'saving' | 'awakening' | 'ready'>('saving')
const isSaving = ref(false)
const isTesting = ref(false)
const draftTouched = ref(false)
const connectionState = ref<'idle' | 'success' | 'error'>('idle')
const connectionMessage = ref('配置完成后可先测试连接')
const error = ref<string | null>(null)
const progress = computed(() => `${String(step.value).padStart(2, '0')} / 04`)
const currentPreset = computed(() => llm.presetProviders.find((item) => item.id === draft.value.providerType))
const timers: number[] = []

function goTo(next: number) {
  step.value = Math.min(4, Math.max(1, next))
}

function handleProviderChange(providerType: LLMProviderType) {
  draftTouched.value = true
  const preset = llm.presetProviders.find((item) => item.id === providerType)
  draft.value = applyOnboardingProvider(draft.value, providerType, preset)
  connectionState.value = 'idle'
  connectionMessage.value = '配置已变更，请重新测试连接'
}

function validateDraft(): boolean {
  error.value = validateOnboardingModel(draft.value, currentPreset.value?.requiresApiKey ?? false)
  return error.value === null
}

async function testConnection() {
  if (!validateDraft()) return
  isTesting.value = true
  connectionState.value = 'idle'
  connectionMessage.value = '正在建立安全连接…'
  try {
    const result = await llm.testConnection({
      providerType: draft.value.providerType,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
    })
    connectionState.value = result.ok ? 'success' : 'error'
    connectionMessage.value = result.ok ? `连接成功 · ${result.latencyMs}ms` : result.message
  } catch (reason) {
    connectionState.value = 'error'
    connectionMessage.value = reason instanceof Error ? reason.message : '连接测试失败'
  } finally {
    isTesting.value = false
  }
}

function animateCompletion() {
  if (isLaunching.value) return
  isLaunching.value = true
  launchPhase.value = 'saving'
  timers.push(window.setTimeout(() => { launchPhase.value = 'awakening' }, 900))
  timers.push(window.setTimeout(() => { launchPhase.value = 'ready' }, 2100))
  timers.push(window.setTimeout(() => {
    isLaunching.value = false
    emit('complete')
  }, 3400))
}

async function saveAndLaunch() {
  if (!validateDraft()) return
  isSaving.value = true
  error.value = null
  try {
    await llm.saveConfig({
      ...draft.value,
      baseUrl: draft.value.baseUrl.trim(),
      apiKey: draft.value.apiKey?.trim() || undefined,
      modelId: draft.value.modelId.trim(),
      settings: {...(draft.value.settings ?? {})},
    })
    animateCompletion()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存模型配置失败'
  } finally {
    isSaving.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target?.matches('input, textarea, [contenteditable="true"]')) return
  if (event.key === 'ArrowLeft') goTo(step.value - 1)
  if (event.key === 'ArrowRight') goTo(step.value + 1)
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    const existingConfig = await llm.getConfig()
    if (!draftTouched.value) draft.value = existingConfig
  } catch {
    // 首次启动时 API 可能还没有已有配置，保留安全的本地草稿。
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  timers.forEach((timer) => window.clearTimeout(timer))
})
</script>

<template>
  <main class="onboarding" :data-step="step">
    <div class="cinema-bars" aria-hidden="true"/>
    <div class="film-grain" aria-hidden="true"/>
    <div class="ambient ambient-a" aria-hidden="true"/>
    <div class="ambient ambient-b" aria-hidden="true"/>

    <header class="onboarding-header">
      <span class="brand-mark"><AervoxBrandMark :size="24"/> Aervox <b>/ 思隅</b></span>
      <span class="chapter">{{ progress }}</span>
    </header>

    <Transition name="scene" mode="out-in">
      <section v-if="step === 1" key="welcome" class="stage welcome-stage">
        <div class="constellation" aria-hidden="true"><i/><i/><i/></div>
        <div class="welcome-copy">
          <p class="eyebrow">PROLOGUE · 初次相遇</p>
          <h1>思隅之间，<br><em>自有辽阔。</em></h1>
          <p class="lead">它记住你的足迹，而你只需注视前方。</p>
          <button class="primary-action" type="button" @click="goTo(2)">
            <span>与我相识</span><i>→</i>
          </button>
        </div>

        <div class="character-scene">
          <div class="character-halo" aria-hidden="true"/>
          <div class="character-glass" aria-hidden="true"/>
          <Live2DPet class="welcome-character">
            <template #fallback>
              <AervoxCompanionMark class="character-fallback"/>
            </template>
          </Live2DPet>
          <p class="character-caption"><span>LIVE PRESENCE</span> 我会在这里，慢慢认识你。</p>
        </div>
      </section>

      <section v-else-if="step === 2" key="idea" class="stage idea-stage">
        <div class="idea-rings" aria-hidden="true"><i/><i/></div>
        <div class="idea-statement">
          <p class="eyebrow">BEYOND THE PROMPT</p>
          <h2>智能，不应只在<br>你开口之后发生。</h2>
          <p>它观察上下文，保留值得记住的片段，<br>在恰当的时刻主动靠近一步。</p>
        </div>
        <div class="memory-trail">
          <article><small>08:40 · 今日</small><strong>你似乎一直在回避那项难题。</strong><span>需要我帮你把第一步拆小一点吗？</span></article>
          <article><small>21:16 · 昨日</small><strong>一次被理解的停顿</strong><span>不是所有沉默都需要被填满。</span></article>
          <article><small>JOURNAL · 片段</small><strong>“成长不是被记录，<br>而是被重新看见。”</strong></article>
        </div>
      </section>

      <section v-else-if="step === 3" key="capability" class="stage capability-stage">
        <div class="capability-copy">
          <p class="eyebrow">NATIVE CAPABILITIES</p>
          <h2>陪伴生活，<br>也陪你成为自己。</h2>
          <p>原生能力与开放生态，在同一个桌面空间里自然发生。</p>
        </div>

        <div class="desktop-evidence" aria-label="Aervox 桌面工作台示意">
          <aside class="evidence-nav"><b>✦</b><span class="is-active">今日</span><span>对话</span><span>学习</span><span>记忆</span><small>···</small></aside>
          <div class="evidence-main">
            <header><span>夜色正好，Rex</span><i>陪伴模式 · 在线</i></header>
            <div class="focus-line"><small>NEXT MOMENT</small><strong>继续昨天未完成的学习计划</strong><button type="button">开始</button></div>
            <div class="evidence-dialogue"><i>✦</i><p>我整理了昨晚的薄弱知识点。今晚只练三题，也足够向前。</p></div>
            <footer>和 Aervox 说点什么… <b>↑</b></footer>
          </div>
        </div>

        <ol class="capability-list">
          <li><b>01</b><div><strong>有海马体的 Agent</strong><span>以审视式日记沉淀长期记忆，主动赋能成长。</span></div></li>
          <li><b>02</b><div><strong>生活与成长原生能力</strong><span>学习、日程、Home Assistant 与穿戴设备感知。</span></div></li>
          <li><b>03</b><div><strong>不设上限的开放生态</strong><span>兼容 DSH 与 pi 插件生态，把能力交还给用户。</span></div></li>
        </ol>
      </section>

      <section v-else key="model" class="stage model-stage">
        <div class="model-copy">
          <p class="eyebrow">ONE LAST THING</p>
          <h2>选择思考的方式。</h2>
          <p>配置你信任的模型。凭据交由当前 Aervox 服务保存，稍后也可以随时更换。</p>
          <button class="quiet-action" type="button" @click="animateCompletion">暂不配置，快速开始 →</button>
        </div>

        <form class="model-console" @input="draftTouched = true" @submit.prevent="saveAndLaunch">
          <div class="console-shine" aria-hidden="true"/>
          <header><span>MODEL CONNECTION</span><i>LOCAL · PRIVATE</i></header>
          <label>
            <span>服务提供商</span>
            <select :value="draft.providerType" @change="handleProviderChange(($event.target as HTMLSelectElement).value as LLMProviderType)">
              <option v-for="item in llm.presetProviders" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <div class="console-row">
            <label>
              <span>Base URL</span>
              <input v-model="draft.baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="url">
            </label>
            <label>
              <span>模型 ID</span>
              <input v-model="draft.modelId" type="text" placeholder="model-name" :list="'onboarding-models'">
              <datalist id="onboarding-models"><option v-for="model in currentPreset?.recommendedModels" :key="model" :value="model"/></datalist>
            </label>
          </div>
          <label>
            <span>API Key</span>
            <div class="secret-field"><input v-model="draft.apiKey" type="password" placeholder="sk-••••••••••••••••" autocomplete="off"><i>仅本机</i></div>
          </label>
          <div class="connection-state" :data-state="connectionState">
            <span><i/> {{ connectionMessage }}</span><small>配置可在设置中修改</small>
          </div>
          <p v-if="error" class="console-error">{{ error }}</p>
          <div class="console-actions">
            <button class="test-action" type="button" :disabled="isTesting || isSaving" @click="testConnection">{{ isTesting ? '测试中…' : '测试连接' }}</button>
            <button class="save-action" type="submit" :disabled="isTesting || isSaving"><span>{{ isSaving ? '保存中…' : '保存并进入思隅' }}</span><i>→</i></button>
          </div>
        </form>
      </section>
    </Transition>

    <footer class="onboarding-footer">
      <button type="button" :disabled="step === 1" @click="goTo(step - 1)">← <span>返回</span></button>
      <nav aria-label="引导进度">
        <button v-for="index in 4" :key="index" type="button" :class="{active: step === index}" :aria-label="`前往第 ${index} 步`" @click="goTo(index)"/>
      </nav>
      <button type="button" :disabled="step === 4" @click="goTo(step + 1)"><span>继续</span> →</button>
    </footer>

    <Transition name="launch">
      <div v-if="isLaunching" class="launch-screen">
        <div class="launch-emblem"><i/><AervoxBrandMark :size="42"/><span/></div>
        <p v-if="launchPhase === 'saving'">正在保存这次相遇</p>
        <p v-else-if="launchPhase === 'awakening'">正在唤醒你的思隅</p>
        <p v-else>准备好了</p>
        <small>{{ launchPhase === 'ready' ? 'WELCOME TO AERVOX' : 'AERVOX IS AWAKENING' }}</small>
      </div>
    </Transition>
  </main>
</template>

<style scoped>
.onboarding {
  --ivory: #f5efe7;
  --muted: rgba(220, 228, 242, .58);
  --line: rgba(219, 232, 255, .16);
  --blue: #79a9ff;
  --violet: #a58aff;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  color: var(--ivory);
  background: radial-gradient(ellipse 65% 90% at 82% 38%, #183c68 0%, #0b1c37 43%, transparent 72%), linear-gradient(128deg, #050a13, #0a1529 52%, #050a13);
  font-family: "Segoe UI Variable", "MiSans", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  font-feature-settings: "palt" 1, "kern" 1;
  isolation: isolate;
}
.onboarding::before { content:""; position:absolute; inset:0; z-index:-2; background:linear-gradient(180deg,rgba(255,255,255,.018),transparent 28%,rgba(0,0,0,.35)); }
.cinema-bars::before,.cinema-bars::after { content:""; position:absolute; z-index:20; left:0; width:100%; height:7px; background:#02050a; pointer-events:none; }
.cinema-bars::before { top:0; }.cinema-bars::after { bottom:0; }
.film-grain { position:absolute; z-index:18; inset:-45%; opacity:.07; pointer-events:none; mix-blend-mode:soft-light; background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.88' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); animation:grain .23s steps(2) infinite; }
.ambient { position:absolute; z-index:-1; border-radius:50%; filter:blur(20px); pointer-events:none; animation:drift 12s ease-in-out infinite alternate; }
.ambient-a { width:48vw; height:48vw; right:-17vw; top:-24vw; background:radial-gradient(circle,rgba(137,181,255,.3),transparent 68%); }
.ambient-b { width:42vw; height:42vw; left:-25vw; bottom:-30vw; background:radial-gradient(circle,rgba(194,149,255,.14),transparent 68%); animation-delay:-5s; }
.onboarding-header { position:absolute; z-index:10; top:34px; right:42px; left:42px; display:flex; justify-content:space-between; align-items:center; color:rgba(224,231,243,.62); font-size:10px; letter-spacing:.16em; }
.brand-mark { display:flex; align-items:center; gap:9px; font-weight:700; }.brand-mark i { display:grid; place-items:center; width:22px; height:22px; border:1px solid rgba(214,230,255,.25); border-radius:50%; color:#bdd3ff; background:rgba(206,225,255,.07); box-shadow:inset 1px 1px 0 rgba(255,255,255,.13); font-style:normal; }.brand-mark b { color:rgba(224,231,243,.38); font-weight:500; }.chapter { font-variant-numeric:tabular-nums; }
.stage { position:absolute; inset:0; overflow:hidden; }
.eyebrow { margin:0 0 25px; color:rgba(216,226,244,.51); font-size:9px; font-weight:680; letter-spacing:.25em; }
.welcome-copy { position:absolute; z-index:4; left:7.8vw; top:50%; width:min(43vw,650px); transform:translateY(-47%); }
.welcome-copy h1,.idea-statement h2,.capability-copy h2,.model-copy h2 { margin:0; font-family:"Segoe UI Variable Display","Source Han Serif SC","Noto Serif CJK SC","Songti SC",serif; font-weight:440; letter-spacing:-.065em; text-shadow:0 15px 48px rgba(0,0,0,.35); }
.welcome-copy h1 { font-size:clamp(54px,6.2vw,96px); line-height:1.04; }.welcome-copy h1 em { color:#e7d2b2; font-style:normal; }.lead { margin:28px 0 42px; color:var(--muted); font-size:14px; letter-spacing:.08em; }
.primary-action,.save-action { display:flex; align-items:center; justify-content:space-between; width:210px; height:52px; padding:0 18px 0 22px; border:1px solid rgba(220,235,255,.29); border-radius:3px 18px 3px 3px; color:#f7f2eb; background:linear-gradient(125deg,rgba(122,165,239,.28),rgba(152,118,222,.22)); box-shadow:inset 1px 1px 0 rgba(255,255,255,.16),0 18px 46px rgba(0,3,12,.26); backdrop-filter:blur(17px) saturate(1.3); font:inherit; font-size:13px; letter-spacing:.08em; cursor:pointer; transition:transform .35s ease,background .35s ease; }.primary-action:hover,.save-action:hover { transform:translateY(-3px); background:linear-gradient(125deg,rgba(122,165,239,.42),rgba(152,118,222,.34)); }.primary-action i,.save-action i { font-size:18px; font-style:normal; }
.character-scene { position:absolute; top:7%; right:0; bottom:0; width:52%; }.character-halo { position:absolute; top:7%; left:10%; width:75%; aspect-ratio:1; border:1px solid rgba(203,224,255,.11); border-radius:50%; box-shadow:0 0 0 55px rgba(171,205,255,.025),0 0 0 140px rgba(171,205,255,.014),inset 0 0 120px rgba(115,168,240,.08); }.character-halo::after { content:""; position:absolute; inset:14%; border:1px solid rgba(224,198,155,.1); border-radius:50%; }.character-glass { position:absolute; top:9%; right:7%; width:62%; height:82%; border:1px solid rgba(218,234,255,.21); border-radius:130px 130px 8px 8px; background:linear-gradient(135deg,rgba(182,213,255,.07),rgba(255,240,211,.035)); box-shadow:inset 1px 1px 0 rgba(255,255,255,.14),0 35px 100px rgba(0,3,12,.3); backdrop-filter:blur(5px); transform:perspective(900px) rotateY(-5deg); }.welcome-character { position:absolute; z-index:2; inset:2% 0 5% 4%; filter:drop-shadow(0 24px 40px rgba(0,0,0,.3)); }.character-fallback { position:absolute; right:22%; bottom:10%; width:190px; height:430px; border-radius:52% 48% 20% 20%; background:linear-gradient(120deg,#273a5e,#111829); box-shadow:0 -55px 0 -7px #17223a; }.character-fallback i { position:absolute; right:-34px; top:10px; width:130px; height:260px; border-radius:60% 20% 70% 30%; background:#121b30; transform:rotate(-12deg); }.character-caption { position:absolute; z-index:4; right:7%; bottom:10%; width:260px; margin:0; padding:16px 18px; border:1px solid rgba(223,235,255,.16); border-radius:2px 14px 2px 2px; color:rgba(226,233,245,.72); background:rgba(9,20,38,.32); box-shadow:inset 1px 1px 0 rgba(255,255,255,.1); backdrop-filter:blur(16px); font-size:11px; line-height:1.7; }.character-caption span { display:block; margin-bottom:4px; color:rgba(225,198,153,.62); font-size:8px; letter-spacing:.2em; }
.constellation { position:absolute; inset:0; background-image:radial-gradient(circle at 17% 19%,rgba(255,255,255,.45) 0 1px,transparent 1.5px),radial-gradient(circle at 58% 14%,rgba(158,196,255,.35) 0 1px,transparent 1.5px),radial-gradient(circle at 78% 73%,rgba(255,234,199,.24) 0 1px,transparent 1.5px); background-size:280px 250px,360px 300px,410px 350px; mask-image:linear-gradient(90deg,transparent,#000 35%,#000); opacity:.7; }
.idea-stage { background:radial-gradient(ellipse 55% 65% at 75% 48%,rgba(88,134,205,.18),transparent 70%); }.idea-rings { position:absolute; left:38%; top:-26%; width:70vw; height:70vw; border:1px solid rgba(196,220,255,.09); border-radius:50%; transform:rotate(-12deg); }.idea-rings::before,.idea-rings i { content:""; position:absolute; inset:12%; border:1px solid rgba(196,220,255,.07); border-radius:50%; }.idea-rings i:nth-child(2) { inset:27%; border-color:rgba(225,199,157,.08); }.idea-statement { position:absolute; left:7.8vw; top:21%; z-index:2; }.idea-statement h2,.capability-copy h2 { font-size:clamp(44px,5vw,75px); line-height:1.1; }.idea-statement > p:last-child,.capability-copy > p:last-child,.model-copy > p:last-of-type { margin:30px 0 0; color:var(--muted); font-size:13px; line-height:1.85; }.memory-trail { position:absolute; right:7vw; top:18%; bottom:17%; width:min(40vw,540px); display:flex; flex-direction:column; justify-content:center; gap:14px; }.memory-trail::before { content:""; position:absolute; top:0; bottom:0; left:17px; width:1px; background:linear-gradient(transparent,rgba(204,224,255,.24),transparent); }.memory-trail article { position:relative; margin-left:38px; padding:18px 21px; border:1px solid rgba(216,232,255,.15); border-radius:2px 18px 2px 2px; background:linear-gradient(125deg,rgba(199,221,255,.08),rgba(107,139,188,.025)); box-shadow:inset 1px 1px 0 rgba(255,255,255,.09),0 19px 55px rgba(0,3,12,.17); backdrop-filter:blur(18px); }.memory-trail article::before { content:""; position:absolute; left:-27px; top:28px; width:10px; height:10px; border:1px solid rgba(212,229,255,.45); border-radius:50%; background:#172b4a; box-shadow:0 0 20px rgba(116,165,239,.45); }.memory-trail small,.memory-trail span { display:block; color:rgba(207,219,237,.45); font-size:9px; letter-spacing:.09em; }.memory-trail strong { display:block; margin:8px 0 5px; color:rgba(244,240,233,.9); font-size:14px; font-weight:520; line-height:1.6; }
.capability-stage { background:radial-gradient(ellipse 45% 70% at 69% 50%,rgba(79,126,202,.2),transparent 72%); }.capability-copy { position:absolute; z-index:3; left:6vw; top:15%; width:41vw; }.capability-copy > p:last-child { max-width:320px; }.desktop-evidence { position:absolute; left:35%; top:11%; width:54%; height:51%; display:grid; grid-template-columns:78px 1fr; overflow:hidden; border:1px solid rgba(217,233,255,.2); border-radius:16px 5px 16px 5px; background:linear-gradient(145deg,rgba(24,38,62,.72),rgba(7,15,29,.78)); box-shadow:inset 1px 1px 0 rgba(255,255,255,.1),0 38px 100px rgba(0,2,9,.42),0 0 80px rgba(91,145,225,.08); backdrop-filter:blur(23px); transform:perspective(1400px) rotateY(-4deg); }.desktop-evidence::after { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(120deg,rgba(255,255,255,.08),transparent 28%); }.evidence-nav { display:flex; flex-direction:column; align-items:center; gap:12px; padding:20px 10px; border-right:1px solid rgba(218,232,255,.08); background:rgba(3,9,18,.35); color:rgba(206,218,238,.42); font-size:9px; }.evidence-nav b { margin-bottom:15px; color:#a9c6ff; font-size:16px; }.evidence-nav span { width:100%; padding:8px 0; border-radius:5px; text-align:center; }.evidence-nav .is-active { color:#f1f4fa; background:rgba(165,197,246,.11); }.evidence-nav small { margin-top:auto; }.evidence-main { position:relative; padding:22px 24px; }.evidence-main header { display:flex; justify-content:space-between; font-size:11px; }.evidence-main header i { color:rgba(201,216,239,.4); font-size:8px; font-style:normal; }.focus-line { position:relative; margin-top:34px; padding:17px; border:1px solid rgba(217,232,255,.09); border-radius:9px; background:rgba(205,225,255,.045); }.focus-line small { display:block; color:#86aefa; font-size:7px; letter-spacing:.15em; }.focus-line strong { display:block; margin-top:7px; font-size:12px; font-weight:540; }.focus-line button { position:absolute; right:14px; bottom:14px; border:0; border-radius:5px; padding:6px 12px; color:#eaf1ff; background:#376ec9; font:inherit; font-size:9px; }.evidence-dialogue { display:flex; gap:12px; margin-top:17px; color:rgba(224,232,245,.68); font-size:10px; line-height:1.7; }.evidence-dialogue i { color:#9dbbf4; font-style:normal; }.evidence-dialogue p { margin:0; }.evidence-main footer { position:absolute; right:24px; bottom:17px; left:24px; display:flex; justify-content:space-between; padding:10px 12px; border:1px solid rgba(220,233,255,.08); border-radius:7px; color:rgba(205,218,239,.34); background:rgba(214,230,255,.04); font-size:9px; }.evidence-main footer b { color:#9bbaff; }.capability-list { position:absolute; right:7vw; bottom:11%; left:38%; display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:0; padding:0; list-style:none; }.capability-list li { display:flex; gap:12px; min-height:82px; padding:15px; border-top:1px solid rgba(219,233,255,.18); background:linear-gradient(180deg,rgba(209,228,255,.055),transparent); }.capability-list li > b { color:rgba(225,198,153,.55); font-size:9px; font-weight:600; }.capability-list strong,.capability-list span { display:block; }.capability-list strong { margin-bottom:8px; font-size:11px; font-weight:560; }.capability-list span { color:rgba(208,220,239,.46); font-size:9px; line-height:1.65; }
.model-stage { background:radial-gradient(ellipse 52% 70% at 72% 47%,rgba(96,143,215,.22),transparent 70%); }.model-copy { position:absolute; left:7.8vw; top:25%; width:35vw; }.model-copy h2 { font-size:clamp(43px,4.6vw,70px); }.quiet-action { margin-top:38px; padding:0 0 9px; border:0; border-bottom:1px solid rgba(222,232,248,.25); color:rgba(222,231,245,.52); background:transparent; font:inherit; font-size:10px; letter-spacing:.08em; cursor:pointer; }.quiet-action:hover { color:#fff; }.model-console { position:absolute; right:9vw; top:15%; width:min(39vw,510px); padding:31px 34px 34px; overflow:hidden; border:1px solid rgba(220,235,255,.22); border-radius:4px 25px 4px 4px; background:linear-gradient(135deg,rgba(190,216,255,.11),rgba(13,27,49,.34)); box-shadow:inset 1px 1px 0 rgba(255,255,255,.14),0 35px 100px rgba(0,2,10,.34); backdrop-filter:blur(25px) saturate(1.25); }.console-shine { position:absolute; top:-1px; left:45px; width:140px; height:1px; background:linear-gradient(90deg,transparent,#e4c698,transparent); box-shadow:0 0 15px rgba(224,192,143,.38); }.model-console header { display:flex; justify-content:space-between; margin-bottom:29px; color:rgba(218,229,246,.55); font-size:8px; letter-spacing:.18em; }.model-console header i { color:rgba(218,229,246,.32); font-style:normal; }.model-console label { display:block; margin-top:21px; }.model-console label > span { display:block; margin-bottom:8px; color:rgba(219,228,243,.55); font-size:9px; }.model-console select,.model-console input { box-sizing:border-box; width:100%; height:44px; outline:0; border:1px solid rgba(218,233,255,.13); border-radius:7px; color:#eef3fb; background:rgba(3,10,21,.28); font:inherit; font-size:11px; }.model-console select { padding:0 13px; }.model-console option { color:#172038; }.secret-field { position:relative; }.secret-field input { padding:0 70px 0 13px; letter-spacing:.09em; }.secret-field i { position:absolute; top:16px; right:12px; color:rgba(179,204,245,.48); font-size:8px; font-style:normal; }.connection-state { display:flex; justify-content:space-between; margin:17px 0 27px; color:rgba(206,220,241,.42); font-size:8px; }.connection-state span i { display:inline-block; width:5px; height:5px; margin-right:6px; border-radius:50%; background:#70d2b2; box-shadow:0 0 11px rgba(112,210,178,.75); }.save-action { width:100%; }
.model-console { right:7vw; top:8%; width:min(42vw,550px); padding:25px 30px 28px; }
.model-console header { margin-bottom:18px; }
.model-console label { margin-top:14px; }
.model-console label > span { margin-bottom:6px; }
.model-console select,.model-console input { box-sizing:border-box; height:40px; padding:0 12px; font-size:10px; }
.console-row { display:grid; grid-template-columns:1.25fr .75fr; gap:10px; }
.secret-field i { top:14px; }
.connection-state { margin:14px 0 17px; }
.connection-state span i { background:#7694c7; box-shadow:0 0 11px rgba(118,148,199,.55); }
.connection-state[data-state="success"] span { color:#9ee1c6; }
.connection-state[data-state="success"] span i { background:#70d2b2; box-shadow:0 0 11px rgba(112,210,178,.75); }
.connection-state[data-state="error"] span,.console-error { color:#ffaaa7; }
.connection-state[data-state="error"] span i { background:#ff817c; box-shadow:0 0 11px rgba(255,129,124,.65); }
.console-error { margin:-7px 0 13px; font-size:9px; }
.console-actions { display:grid; grid-template-columns:115px 1fr; gap:10px; }
.test-action { border:1px solid rgba(220,235,255,.17); border-radius:7px; color:rgba(231,237,248,.72); background:rgba(210,229,255,.06); font:inherit; font-size:9px; cursor:pointer; }
.save-action { width:100%; height:46px; }
.test-action:disabled,.save-action:disabled { opacity:.55; cursor:wait; }
.onboarding-footer { position:absolute; z-index:10; right:42px; bottom:27px; left:42px; display:flex; justify-content:space-between; align-items:center; }.onboarding-footer > button { width:75px; border:0; color:rgba(218,228,244,.5); background:transparent; font:inherit; font-size:9px; letter-spacing:.09em; cursor:pointer; }.onboarding-footer > button:last-child { text-align:right; }.onboarding-footer > button:disabled { opacity:0; pointer-events:none; }.onboarding-footer nav { display:flex; gap:11px; }.onboarding-footer nav button { width:5px; height:5px; padding:0; border:0; border-radius:99px; background:rgba(218,230,248,.25); cursor:pointer; transition:width .35s ease,background .35s ease,box-shadow .35s ease; }.onboarding-footer nav button.active { width:26px; background:rgba(208,225,255,.85); box-shadow:0 0 16px rgba(136,180,248,.55); }
.launch-screen { position:absolute; z-index:30; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#f4f0e9; background:radial-gradient(circle at 50% 45%,#172d4d,#08111f 48%,#03070d 100%); }.launch-emblem { position:relative; display:grid; place-items:center; width:112px; height:112px; margin-bottom:30px; }.launch-emblem::before,.launch-emblem::after,.launch-emblem i { content:""; position:absolute; inset:0; border:1px solid rgba(197,220,255,.22); border-radius:50%; animation:orbit 2.1s linear infinite; }.launch-emblem::after { inset:13px; border-color:rgba(225,198,153,.22); animation-direction:reverse; animation-duration:2.8s; }.launch-emblem i { inset:29px; border-top-color:#9cbfff; border-right-color:transparent; border-bottom-color:transparent; animation-duration:1.15s; }.launch-emblem b { font-size:28px; color:#dbe7fb; text-shadow:0 0 28px rgba(140,184,251,.7); }.launch-emblem span { position:absolute; inset:45%; border-radius:50%; box-shadow:0 0 70px 25px rgba(101,155,237,.2); }.launch-screen p { margin:0 0 10px; font-family:"Segoe UI Variable Display","Source Han Serif SC",serif; font-size:18px; letter-spacing:.08em; }.launch-screen small { color:rgba(210,222,240,.38); font-size:8px; letter-spacing:.25em; }
.brand-mark :deep(.aervox-brand-mark) { color:#bdd3ff; filter:drop-shadow(0 0 10px rgba(140,184,251,.35)); }
.welcome-character :deep(.character-fallback) { right:12%; bottom:13%; width:min(72%,430px); height:auto; border:1px solid rgba(218,234,255,.18); border-radius:28%; background:none; box-shadow:0 28px 70px rgba(0,0,0,.36); }
.launch-emblem :deep(.aervox-brand-mark) { position:relative; z-index:1; color:#dbe7fb; filter:drop-shadow(0 0 14px rgba(140,184,251,.7)); }
.scene-enter-active,.scene-leave-active { transition:opacity .65s ease,transform .75s cubic-bezier(.2,.8,.2,1),filter .65s ease; }.scene-enter-from { opacity:0; transform:translateX(24px) scale(1.015); filter:blur(6px); }.scene-leave-to { opacity:0; transform:translateX(-18px) scale(.99); filter:blur(4px); }.launch-enter-active,.launch-leave-active { transition:opacity .65s ease,filter .65s ease; }.launch-enter-from,.launch-leave-to { opacity:0; filter:blur(12px); }
@keyframes grain { 0%{transform:translate(0)}25%{transform:translate(2%,-3%)}50%{transform:translate(-3%,2%)}75%{transform:translate(3%,3%)}100%{transform:translate(-2%,-2%)} }
@keyframes drift { to { transform:translate3d(3vw,-2vh,0) scale(1.08); } }
@keyframes orbit { to { transform:rotate(360deg); } }
@media (max-width:950px) { .welcome-copy{left:6vw}.character-scene{width:49%}.idea-statement{left:6vw}.memory-trail{right:4vw;width:44vw}.capability-copy{left:4vw}.desktop-evidence{left:33%;width:62%}.capability-list{left:35%;right:4vw}.model-copy{left:6vw}.model-console{right:6vw;width:43vw} }
@media (prefers-reduced-motion:reduce) { .film-grain,.ambient,.launch-emblem::before,.launch-emblem::after,.launch-emblem i { animation:none; }.scene-enter-active,.scene-leave-active { transition-duration:.01ms; } }
</style>
