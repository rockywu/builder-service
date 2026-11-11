<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <section class="scaffold-page">
    <h1>{{ title }}</h1>
    <p class="page-description">{{ description }}</p>
    <div class="scaffold-notice">
      <ElTag type="info" effect="plain">脚手架</ElTag>
      <p>页面结构已就绪，业务功能尚未开发。</p>
    </div>
  </section>
</template>
