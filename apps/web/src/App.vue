<script setup lang="ts">
import { useRoute } from 'vue-router';
import { RouterView } from 'vue-router';
import PetBubble from '@/components/PetBubble.vue';

const route = useRoute();
</script>

<template>
  <el-container class="shell">
    <el-aside width="180px" class="sidebar">
      <div class="brand">Aervox｜思隅</div>
      <el-menu :default-active="route.path" router class="nav">
        <el-menu-item index="/chat">
          <span>💬 对话</span>
        </el-menu-item>
        <el-menu-item index="/learning">
          <span>🎯 学习</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="main">
      <RouterView />
    </el-main>
    <PetBubble />
  </el-container>
</template>

<style scoped>
.shell {
  height: 100vh;
}
.sidebar {
  border-right: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
}
.brand {
  padding: 18px 16px;
  font-weight: 600;
  font-size: 15px;
}
.nav {
  border-right: none;
}
.main {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.main > :deep(*) {
  flex: 1;
}
</style>