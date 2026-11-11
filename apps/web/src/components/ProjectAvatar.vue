<script setup lang="ts">
import type { Project } from '../api/types';

withDefaults(
  defineProps<{
    project: Pick<Project, 'name' | 'color' | 'icon'>;
    size?: 'sm' | 'md' | 'lg' | 'xl';
  }>(),
  { size: 'md' },
);

const sizes = {
  sm: 'size-7 rounded-md text-xs',
  md: 'size-10 rounded-lg text-base',
  lg: 'size-12 rounded-xl text-lg',
  xl: 'size-16 rounded-2xl text-2xl',
};
</script>

<template>
  <span
    class="grid shrink-0 place-items-center overflow-hidden font-semibold text-white"
    :class="sizes[size]"
    :style="{ backgroundColor: project.color }"
  >
    <img
      v-if="project.icon"
      :src="project.icon"
      alt=""
      class="size-full object-cover"
    />
    <span v-else aria-hidden="true">{{ project.name.slice(0, 1) }}</span>
  </span>
</template>
