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
/** 步骤 2 · 六能力辐射图节点（取材自产品宣讲包 P02） */
const webNodes = [
  {label: '学习', x: 310, y: 62, delay: '.55s'},
  {label: '陪伴', x: 508, y: 165, delay: '.68s'},
  {label: '记忆', x: 508, y: 395, delay: '.81s'},
  {label: '日记', x: 310, y: 498, delay: '.94s'},
  {label: '工具', x: 112, y: 395, delay: '1.07s'},
  {label: '主动智能', x: 112, y: 165, delay: '1.2s'},
]
/** 步骤 3 · 学习闭环六步（取材自产品宣讲包 P04） */
const learningPipeline = [
  {title: '确认目标', desc: '先想清楚要掌握什么'},
  {title: '分层提示', desc: '以提示搭出台阶，而不是直接给答案'},
  {title: '用户作答', desc: '思考发生在用户这边'},
  {title: '即时反馈', desc: '对在哪、错在哪，当场知道'},
  {title: '错题复习', desc: '在遗忘之前再次相遇'},
  {title: '形成记忆', desc: '知识沉淀，进步有轨迹'},
]
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
        <div class="capability-web" role="img" aria-label="思隅连接学习、陪伴、记忆、日记、工具与主动智能">
          <svg viewBox="0 0 620 560">
            <g class="web-links" stroke="#79a9ff" stroke-width="1.5" opacity=".55">
              <line x1="310" y1="280" x2="310" y2="62"/><line x1="310" y1="280" x2="508" y2="165"/>
              <line x1="310" y1="280" x2="508" y2="395"/><line x1="310" y1="280" x2="310" y2="498"/>
              <line x1="310" y1="280" x2="112" y2="395"/><line x1="310" y1="280" x2="112" y2="165"/>
            </g>
            <circle cx="310" cy="280" r="92" fill="#79a9ff" opacity=".1"/>
            <circle class="web-core" cx="310" cy="280" r="68" fill="#f5efe7"/>
            <text class="web-core-name" x="310" y="272" text-anchor="middle">思隅</text>
            <text class="web-core-en" x="310" y="303" text-anchor="middle">AERVOX</text>
            <g v-for="node in webNodes" :key="node.label" class="web-node" :style="{'--d': node.delay}">
              <circle :cx="node.x" :cy="node.y" r="48"/>
              <text :x="node.x" :y="node.y + 6" text-anchor="middle">{{ node.label }}</text>
            </g>
          </svg>
          <p class="web-caption"><span>SIX CAPABILITIES</span>六个原生能力，共享同一个持续成长的记忆体</p>
        </div>
      </section>

      <section v-else-if="step === 3" key="capability" class="stage capability-stage">
        <div class="capability-copy">
          <p class="eyebrow">LEARNING LOOP · 学习闭环</p>
          <h2>从一个问题，<br>走向一次真正的掌握。</h2>
          <p>思隅陪你走完完整的闭环，让知识持续沉淀，让进步拥有自己的轨迹。</p>
        </div>

        <div class="learning-pipeline" aria-label="学习闭环六步">
          <div v-for="(lp, i) in learningPipeline" :key="lp.title" class="lp-step" :style="{'--d': `${0.15 * i + 0.2}s`}">
            <b>{{ String(i + 1).padStart(2, '0') }}</b>
            <strong>{{ lp.title }}</strong>
            <span>{{ lp.desc }}</span>
          </div>
        </div>
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
.idea-stage { background:radial-gradient(ellipse 55% 65% at 75% 48%,rgba(88,134,205,.18),transparent 70%); }.idea-rings { position:absolute; left:38%; top:-26%; width:70vw; height:70vw; border:1px solid rgba(196,220,255,.09); border-radius:50%; transform:rotate(-12deg); }.idea-rings::before,.idea-rings i { content:""; position:absolute; inset:12%; border:1px solid rgba(196,220,255,.07); border-radius:50%; }.idea-rings i:nth-child(2) { inset:27%; border-color:rgba(225,199,157,.08); }.idea-statement { position:absolute; left:7.8vw; top:21%; z-index:2; }.idea-statement h2,.capability-copy h2 { font-size:clamp(44px,5vw,75px); line-height:1.1; }.idea-statement > p:last-child,.capability-copy > p:last-child,.model-copy > p:last-of-type { margin:30px 0 0; color:var(--muted); font-size:13px; line-height:1.85; }
.capability-stage { background:radial-gradient(ellipse 45% 70% at 69% 50%,rgba(79,126,202,.2),transparent 72%); }.capability-copy { position:absolute; z-index:3; left:6vw; top:15%; width:41vw; }.capability-copy > p:last-child { max-width:320px; }
/* —— 步骤 2 · 六能力辐射图（取材自产品宣讲包 P02） —— */
.capability-web { position:absolute; right:6vw; top:50%; width:min(44vw,620px); transform:translateY(-50%); }
.capability-web svg { display:block; width:100%; height:auto; overflow:visible; }
.web-links line { stroke-dasharray:330; stroke-dashoffset:330; animation:web-draw 1s ease forwards; }
.web-core { transform-box:fill-box; transform-origin:center; animation:web-pop .7s cubic-bezier(.2,.8,.2,1) .25s both; }
.web-core-name { font-size:28px; font-weight:300; fill:#101d30; }
.web-core-en { font-size:12px; letter-spacing:3px; fill:#101d30; opacity:.6; }
.web-node { opacity:0; transform-box:fill-box; transform-origin:center; animation:web-pop .6s cubic-bezier(.2,.8,.2,1) var(--d,0s) forwards; }
.web-node circle { fill:#0d1b33; stroke:#8fb3cc; stroke-width:1.5; }
.web-node text { fill:#dbe7fb; font-size:17px; font-weight:300; }
.web-caption { display:flex; align-items:center; gap:10px; margin:18px 0 0; color:rgba(207,219,237,.55); font-size:11px; letter-spacing:.06em; }
.web-caption span { color:rgba(225,198,153,.6); font-size:9px; letter-spacing:.2em; }
/* —— 步骤 3 · 学习闭环（取材自产品宣讲包 P04） —— */
.learning-pipeline { position:absolute; right:6vw; top:50%; width:min(42vw,560px); display:grid; grid-template-columns:repeat(2,1fr); gap:20px 26px; transform:translateY(-50%); }
.lp-step { padding-top:13px; border-top:1px solid rgba(121,169,255,.32); opacity:0; animation:lp-in .6s ease var(--d,0s) forwards; }
.lp-step b { display:block; color:rgba(225,198,153,.55); font-size:10px; font-weight:600; font-style:italic; }
.lp-step strong { display:block; margin:7px 0 5px; color:rgba(244,240,233,.92); font-size:15px; font-weight:560; letter-spacing:.01em; }
.lp-step span { display:block; color:rgba(208,220,239,.52); font-size:10px; line-height:1.65; }
@keyframes web-draw { to { stroke-dashoffset:0; } }
@keyframes web-pop { from { opacity:0; transform:scale(.72); } to { opacity:1; transform:scale(1); } }
@keyframes lp-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
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
@media (max-width:950px) { .welcome-copy{left:6vw}.character-scene{width:49%}.idea-statement{left:6vw}.capability-web{right:4vw;width:48vw}.capability-copy{left:4vw;width:44vw}.learning-pipeline{right:4vw;width:48vw}.model-copy{left:6vw}.model-console{right:6vw;width:43vw} }
@media (prefers-reduced-motion:reduce) { .film-grain,.ambient,.launch-emblem::before,.launch-emblem::after,.launch-emblem i { animation:none; }.scene-enter-active,.scene-leave-active { transition-duration:.01ms; }.web-links line,.web-core,.web-node,.lp-step { animation:none !important; opacity:1 !important; transform:none !important; stroke-dashoffset:0 !important; } }
</style>
