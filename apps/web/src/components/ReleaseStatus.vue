<script setup lang="ts">
import { computed } from 'vue';
import type { TestStatus } from '../api/types';
import { testStatusMeta } from '../utils/status';

const props = defineProps<{ status: TestStatus }>();
const tone: Record<TestStatus, string> = {
  passed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  pending: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  testing: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300',
  rejected: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
};
const meta = computed(() => testStatusMeta[props.status]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium"
    :class="tone[status]"
  >
    <span class="relative flex size-1.5">
      <span
        v-if="status === 'testing'"
        class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70"
      />
      <span class="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
    {{ meta.label }}
  </span>
</template>
