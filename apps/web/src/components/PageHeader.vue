<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header
    class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
  >
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight text-slate-900">
        {{ title }}
      </h1>
      <p v-if="description" class="mt-1 text-sm text-slate-500">
        {{ description }}
      </p>
    </div>
    <div
      v-if="$slots.default"
      class="flex shrink-0 flex-wrap items-center gap-2"
    >
      <slot />
    </div>
  </header>
</template>
