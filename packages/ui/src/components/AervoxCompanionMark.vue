<script setup lang="ts">
import companionMark from '../assets/brand/siyu-companion-a2.png'
withDefaults(defineProps<{alt?: string}>(), {alt: '思隅角色标志'})
</script>

<template><img class="aervox-companion-mark" :src="companionMark" :alt="alt" width="1254" height="1254"></template>

<style scoped>.aervox-companion-mark { display:block; max-width:100%; height:auto; object-fit:cover; }</style>
