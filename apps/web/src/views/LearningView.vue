<script setup lang="ts">
import { ref } from 'vue';
import { useAervoxApi } from '@aervox/api-client';

const { goals, dueReviews, todayDiary, loading, error, createGoal } = useAervoxApi();
const topic = ref('');
const creating = ref(false);

const submitGoal = async (): Promise<void> => {
  const t = topic.value.trim();
  if (!t || creating.value) return;
  creating.value = true;
  try {
    await createGoal(t);
    topic.value = '';
  } finally {
    creating.value = false;
  }
};
</script>

<template>
  <div class="learning">
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />

    <el-card shadow="never" class="block">
      <template #header>学习目标</template>
      <div class="create-row">
        <el-input v-model="topic" placeholder="新目标，例如：掌握二叉树" clearable @keyup.enter="submitGoal" />
        <el-button type="primary" :loading="creating" @click="submitGoal">添加</el-button>
      </div>
      <el-empty v-if="!loading && goals.length === 0" description="还没有目标" :image-size="60" />
      <ul class="goal-list" v-else>
        <li v-for="g in goals" :key="g.id">
          <span>{{ g.topic }}</span>
          <el-tag size="small" effect="plain">{{ g.level }}</el-tag>
        </li>
      </ul>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>到期复习（{{ dueReviews.length }}）</template>
      <el-empty v-if="dueReviews.length === 0" description="暂无到期的复习项" :image-size="60" />
      <ul class="goal-list" v-else>
        <li v-for="r in dueReviews" :key="r.id">
          <span>知识点 {{ r.knowledgeId }}</span>
          <el-tag size="small" type="warning">今天需要复习</el-tag>
        </li>
      </ul>
    </el-card>

    <el-card v-if="todayDiary" shadow="never" class="block">
      <template #header>今日日记</template>
      <h4>{{ todayDiary.title }}</h4>
      <p class="diary-content">{{ todayDiary.content }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.learning {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.create-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.goal-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.goal-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.diary-content {
  color: var(--el-text-color-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>