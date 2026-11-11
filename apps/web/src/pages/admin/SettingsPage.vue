<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { OCCUPYING, db, saveSettings } from '../../mocks/db';
import PageHeader from '../../components/PageHeader.vue';

const value = ref(db.settings.maxConcurrent);
const saving = ref(false);
const dirty = computed(() => value.value !== db.settings.maxConcurrent);
const occupied = computed(
  () => db.jobs.filter((job) => OCCUPYING.includes(job.status)).length,
);
const queued = computed(
  () => db.jobs.filter((job) => job.status === 'queued').length,
);

const effect = computed(() => {
  const next = value.value;
  if (next > db.settings.maxConcurrent)
    return `调高后立即补位：最多再启动 ${Math.min(queued.value, next - occupied.value)} 个排队任务。`;
  if (next < occupied.value)
    return `当前有 ${occupied.value} 个任务在执行，调低后它们会继续完成；占用降到 ${next} 以下才启动下一个。`;
  if (next < db.settings.maxConcurrent) return '调低后不会中断执行中的任务。';
  return '';
});

async function save() {
  saving.value = true;
  try {
    await saveSettings(value.value);
    ElMessage.success(`并行上限已设为 ${value.value}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <PageHeader
    title="设置"
    description="平台全局设置。资源额度、超时默认值与存储位置由部署配置管理。"
  />

  <section class="max-w-3xl rounded-xl border border-slate-200 bg-white">
    <div class="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-start">
      <div>
        <h2 class="text-base font-semibold text-slate-900">并行构建数</h2>
        <p class="mt-1 text-sm text-slate-500">
          同时占用执行槽位的任务上限。超出的任务按入队顺序等待；准备代码和收集产物也会占用槽位。
        </p>
      </div>
      <el-input-number
        v-model="value"
        :min="1"
        :max="16"
        size="large"
        aria-label="并行构建数"
      />
    </div>

    <div class="border-t border-slate-100 px-6 py-5">
      <div class="mb-2 flex justify-between text-xs text-slate-500">
        <span>槽位预览</span>
        <span>执行中 {{ occupied }} · 排队 {{ queued }}</span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="index in Math.max(value, occupied)"
          :key="index"
          class="h-8 w-10 rounded-md border transition"
          :class="[
            index <= occupied
              ? 'border-brand-300 bg-brand-500'
              : 'border-dashed border-slate-300 bg-slate-50',
            index > value ? 'opacity-40' : '',
          ]"
          :title="index <= occupied ? '执行中' : '空闲'"
        />
      </div>
      <p
        v-if="dirty && effect"
        class="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800"
      >
        {{ effect }}
      </p>
    </div>

    <div
      class="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-3"
    >
      <el-button :disabled="!dirty" @click="value = db.settings.maxConcurrent"
        >还原</el-button
      >
      <el-button
        type="primary"
        :disabled="!dirty"
        :loading="saving"
        @click="save"
        >保存</el-button
      >
    </div>
  </section>
</template>
