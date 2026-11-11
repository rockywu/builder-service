<script setup lang="ts">
import { ref } from 'vue';
import { ElButton, ElDialog, ElIcon } from 'element-plus';
import { WarningFilled } from '@element-plus/icons-vue';

const props = defineProps<{
  title: string;
  target: string;
  description?: string;
  scope?: string[];
  note?: string;
  confirmText: string;
  tone: 'warning' | 'danger';
  onResult: (ok: boolean) => void;
}>();

const open = ref(true);
let ok = false;
function confirm() {
  ok = true;
  open.value = false;
}
</script>

<template>
  <ElDialog
    v-model="open"
    width="min(440px, calc(100vw - 32px))"
    :show-close="true"
    align-center
    append-to-body
    @closed="props.onResult(ok)"
  >
    <template #header>
      <div class="flex items-center gap-2.5">
        <span
          class="grid size-8 shrink-0 place-items-center rounded-full"
          :class="
            tone === 'danger'
              ? 'bg-red-50 text-red-500'
              : 'bg-amber-50 text-amber-500'
          "
        >
          <ElIcon :size="18"><WarningFilled /></ElIcon>
        </span>
        <h2 class="text-base font-semibold text-slate-900">{{ title }}</h2>
      </div>
    </template>

    <div class="space-y-3 pl-[42px] text-sm">
      <p class="font-medium text-slate-800">{{ target }}</p>
      <p v-if="description" class="text-slate-600">{{ description }}</p>
      <div
        v-if="scope?.length"
        class="rounded-md bg-slate-50 p-3 text-slate-600"
      >
        <p class="mb-1.5 text-xs text-slate-500">将永久清理：</p>
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="item in scope" :key="item">{{ item }}</li>
        </ul>
      </div>
      <p v-if="note" class="text-xs leading-relaxed text-slate-500">
        {{ note }}
      </p>
      <p v-if="tone === 'danger'" class="text-xs text-red-600">
        物理删除，不可恢复。
      </p>
    </div>

    <template #footer>
      <ElButton @click="open = false">取消</ElButton>
      <ElButton type="danger" @click="confirm">{{ confirmText }}</ElButton>
    </template>
  </ElDialog>
</template>
