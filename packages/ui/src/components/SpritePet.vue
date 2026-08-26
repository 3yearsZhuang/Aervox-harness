/**
 * Aervox｜思隅 @aervox/ui — Codex Pets 兼容的 9 状态 spritesheet 渲染器
 *
 * 兼容对象：OpenAI Codex Pets 标准精灵图集协议（pet.json manifest + 8 列 × 9 行
 * atlas，每格 192×208）。本组件按协议播放对应状态行的逐帧动画：
 * - 行 0~8 对应 9 个标准状态（idle/running-right/running-left/waving/jumping/
 *   failed/waiting/running/review）；
 * - 每态帧数取 manifest.rowFrames，缺省用协议默认表；
 * - 工具调用状态（进行中/等待/检查）直接映射到 running/waiting/review 行，
 *   让「AI 干活 → 桌宠姿态」由同一数据源驱动。
 *
 * 协议结构自研对齐（不含任何 OpenAI 素材/代码）；类型与本仓库
 * packages/contracts 的 petSheet*Schema 同构，ui 侧内联以免新增跨包依赖。
 */
<script lang="ts">
import { computed, defineComponent, h, type CSSProperties } from 'vue';

/** Codex Pets 9 个标准动画状态（行索引 0~8） */
export type PetSheetState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review';

/** Codex Pets atlas 几何布局（协议常量） */
export interface PetSheetLayout {
  columns: 8;
  rows: 9;
  cellWidth: 192;
  cellHeight: 208;
  atlasWidth: 1536;
  atlasHeight: 1872;
  spriteVersionNumber: 1;
}

/** pet.json manifest */
export interface PetManifest {
  id: string;
  displayName: string;
  description?: string;
  spritesheetPath: string;
  layout: PetSheetLayout;
  rowFrames?: Partial<Record<PetSheetState, number>>;
}

/** 协议默认帧数表（与 Codex Pets 固定值一致） */
export const DEFAULT_ROW_FRAMES: Record<PetSheetState, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

/** 状态 → 行索引（协议固定顺序） */
export const STATE_ROW_INDEX: Record<PetSheetState, number> = {
  idle: 0,
  'running-right': 1,
  'running-left': 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
};

/** 工具调用状态 → Codex Pets 状态（AI 活动驱动桌宠姿态） */
export type PetToolActivity = 'idle' | 'running' | 'waiting' | 'checking' | 'failed';

export const TOOL_ACTIVITY_TO_STATE: Record<PetToolActivity, PetSheetState> = {
  idle: 'idle',
  running: 'running',
  waiting: 'waiting',
  checking: 'review',
  failed: 'failed',
};

export default defineComponent({
  name: 'SpritePet',
  props: {
    manifest: { type: Object as () => PetManifest, required: true },
    /** Codex Pets 9 态；缺省 idle */
    activeState: { type: String as () => PetSheetState, default: 'idle' },
    /** 工具调用活动（表示 AI 正在寻路/执行/检查），映射到对应状态行 */
    toolActivity: { type: String as () => PetToolActivity, default: 'idle' },
    /** 播放帧率（fps），缺省 6 */
    fps: { type: Number, default: 6 },
    /** 尺寸缩放（占位 192×208 网格），由使用端以 transform:scale 包裹 */
    scale: { type: Number, default: 1 },
  },
  setup(props) {
    const framesFor = (state: PetSheetState): number =>
      props.manifest.rowFrames?.[state] ?? DEFAULT_ROW_FRAMES[state];

    const rowFor = (state: PetSheetState): number => STATE_ROW_INDEX[state];

    const styles = computed<CSSProperties>(() => {
      const layout = props.manifest.layout;
      const state =
        props.toolActivity && props.toolActivity !== 'idle'
          ? TOOL_ACTIVITY_TO_STATE[props.toolActivity]
          : props.activeState;
      const row = rowFor(state);
      const frames = framesFor(state);
      return {
        width: `${layout.cellWidth}px`,
        height: `${layout.cellHeight}px`,
        backgroundImage: `url(${props.manifest.spritesheetPath})`,
        backgroundSize: `${layout.atlasWidth}px ${layout.atlasHeight}px`,
        backgroundPosition: `0px ${-row * layout.cellHeight}px`,
        animation: `sprite-pet-play ${(frames / props.fps).toFixed(3)}s steps(${frames - 1}) infinite`,
        transform: props.scale !== 1 ? `scale(${props.scale})` : undefined,
        transformOrigin: 'bottom left',
      } as CSSProperties;
    });

    return { styles, ariaLabel: computed(() => props.manifest.displayName) };
  },
  render() {
    return h('div', {
      class: 'sprite-pet',
      role: 'img',
      'aria-label': this.ariaLabel,
      style: this.styles,
    });
  },
});
</script>

<style>
.sprite-pet {
  image-rendering: pixelated;
  background-repeat: no-repeat;
}

@keyframes sprite-pet-play {
  from {
    background-position-x: 0px;
  }
  to {
    /* 末帧 = atlas 宽度 - 单格宽度；steps(N) 共 N 次跳变覆盖 N+1 张图（最后一帧为静态收尾） */
    background-position-x: calc(-100% + 192px);
  }
}
</style>