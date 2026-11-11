<script setup lang="ts">
import { computed } from 'vue';
import type { JobStatus, TestStatus } from '../api/types';
import { jobStatusMeta, testStatusMeta } from '../utils/status';

const props = defineProps<
  | { kind: 'job'; status: JobStatus; size?: 'small' | 'default' }
  | { kind: 'test'; status: TestStatus; size?: 'small' | 'default' }
>();

const meta = computed(() =>
  props.kind === 'job'
    ? jobStatusMeta[props.status as JobStatus]
    : testStatusMeta[props.status as TestStatus],
);
const live = computed(
  () =>
    props.kind === 'job' &&
    (props.status === 'running' || props.status === 'canceling'),
);
</script>

<template>
  <el-tag :type="meta.type" :size="size ?? 'default'" disable-transitions>
    <span class="inline-flex items-center gap-1.5">
      <span class="relative flex size-1.5">
        <span
          v-if="live"
          class="absolute inline-flex size-full animate-ping rounded-full opacity-75"
          :class="meta.dot"
        />
        <span
          class="relative inline-flex size-1.5 rounded-full"
          :class="meta.dot"
        />
      </span>
      {{ meta.label }}
    </span>
  </el-tag>
</template>
