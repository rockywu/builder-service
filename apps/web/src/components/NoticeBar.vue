<script setup lang="ts">
import { computed } from 'vue';
import {
  CircleCheckFilled,
  CircleCloseFilled,
  InfoFilled,
  WarningFilled,
} from '@element-plus/icons-vue';

/**
 * 弹窗 / 抽屉内统一的提示条：浅色底 + 同色描边 + 顶部对齐图标 + 12px 正文。
 * 内容通过默认插槽传入，可包含 <code>、链接、按钮。
 */
const props = withDefaults(
  defineProps<{ tone?: 'info' | 'warning' | 'success' | 'danger' }>(),
  { tone: 'info' },
);

const TONES = {
  info: {
    icon: InfoFilled,
    box: 'border-slate-200 bg-slate-50 text-slate-600',
    mark: 'text-slate-400',
  },
  warning: {
    icon: WarningFilled,
    box: 'border-amber-200 bg-amber-50 text-amber-800',
    mark: 'text-amber-500',
  },
  success: {
    icon: CircleCheckFilled,
    box: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    mark: 'text-emerald-500',
  },
  danger: {
    icon: CircleCloseFilled,
    box: 'border-red-200 bg-red-50 text-red-700',
    mark: 'text-red-500',
  },
} as const;

const style = computed(() => TONES[props.tone]);
</script>

<template>
  <div
    class="flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5"
    :class="style.box"
    :role="tone === 'warning' || tone === 'danger' ? 'alert' : 'note'"
  >
    <el-icon :size="14" class="mt-[3px] shrink-0" :class="style.mark"
      ><component :is="style.icon"
    /></el-icon>
    <div class="min-w-0 flex-1 break-words"><slot /></div>
  </div>
</template>
