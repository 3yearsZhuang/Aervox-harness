<script setup lang="ts">
import { BrainCircuit, GraduationCap, Heart, LayoutGrid, Menu, Settings, X } from 'lucide-vue-next';
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

const menuItems = [
  { id: 'tools', label: '工具管理', icon: LayoutGrid, action: () => openTool('todo') },
  { id: 'learning', label: '学习能力', icon: GraduationCap, action: () => openTool('study') },
  { id: 'proactive', label: '主动智能', icon: BrainCircuit, action: () => openSettingsCategory('proactive') },
  { id: 'settings', label: '详细设置', icon: Settings, action: () => openSettingsCategory('tools') },
  { id: 'siyu', label: '你的思隅', icon: Heart, action: () => openSettingsCategory('conversation') },
];
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
        type="button"
        @click.stop="runMenuAction(item.action)"
      >
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </button>
      <ExtensionSlot name="nav:menu-items" />
    </div>
  </nav>
</template>
