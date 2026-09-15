<script setup lang="ts">
import { computed } from 'vue';
import { BrainCircuit, LayoutGrid, Menu, Settings, X } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout } = useWorkbenchContext();
const {
  menuOpen,
  menuPillRef,
  toggleMenu,
  handlePillClick,
  runMenuAction,
  openTool,
  openSettingsCategory,
} = layout;

const menuItems = computed(() => [
  {
    id: 'tools',
    label: '工具管理',
    icon: LayoutGrid,
    isActive: Boolean(layout.toolsOpen?.value),
    action: () => openTool('todo'),
  },
  {
    id: 'proactive',
    label: '主动智能',
    icon: BrainCircuit,
    isActive: Boolean(layout.settingsOpen?.value && layout.settingsCategory?.value === 'proactive'),
    action: () => openSettingsCategory('proactive'),
  },
  {
    id: 'settings',
    label: '设置',
    icon: Settings,
    isActive: Boolean(
      layout.settingsOpen?.value &&
      layout.settingsCategory?.value !== 'proactive',
    ),
    action: () => openSettingsCategory('tools'),
  },
]);
</script>

<template>
  <nav ref="menuPillRef" class="menu-pill" :class="{ open: menuOpen }" aria-label="主导航" @click="handlePillClick">
    <button
      class="menu-toggle"
      type="button"
      :aria-expanded="menuOpen"
      :aria-label="menuOpen ? '收起菜单' : '展开菜单'"
      @click.stop="toggleMenu"
    >
      <Menu v-if="!menuOpen" :size="19" />
      <X v-else :size="19" />
    </button>
    <div class="menu-items">
      <button
        v-for="item in menuItems"
        :key="item.id"
        class="menu-item"
        :class="{ 'is-active': item.isActive }"
        type="button"
        :title="item.label"
        @click.stop="runMenuAction(item.action)"
      >
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </button>
      <ExtensionSlot name="nav:menu-items">
        <template #fallback="{ item }">
          <span
            class="extension-fallback-badge menu-item-fallback"
            :title="`插件组件 [${item.id}] 执行异常已隔离`"
          >
            ⚠️ {{ item.id }}
          </span>
        </template>
      </ExtensionSlot>
    </div>
  </nav>
</template>
