<script setup lang="ts">
withDefaults(defineProps<{ subtitle?: string; inverted?: boolean }>(), {
  subtitle: '',
  inverted: false,
});
</script>

<template>
  <span class="flex items-center gap-2.5">
    <span
      class="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-white shadow-sm shadow-brand-600/30"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        class="size-[18px]"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
        <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
      </svg>
    </span>
    <span class="leading-tight">
      <span
        class="block text-[15px] font-semibold tracking-wide"
        :class="inverted ? 'text-white' : 'text-slate-900'"
        >构建平台</span
      >
      <span
        v-if="subtitle"
        class="block text-[11px]"
        :class="inverted ? 'text-slate-400' : 'text-slate-500'"
        >{{ subtitle }}</span
      >
    </span>
  </span>
</template>
