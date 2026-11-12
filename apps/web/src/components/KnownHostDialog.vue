<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, Check } from '@element-plus/icons-vue';
import type { ScannedHostKey } from '../api/types';
import { addKnownHosts, scanKnownHost } from '../api/store';
import NoticeBar from './NoticeBar.vue';

const open = defineModel<boolean>({ required: true });

const host = ref('');
const port = ref(22);
const scanning = ref(false);
const saving = ref(false);
const scanned = ref<ScannedHostKey[] | null>(null);
/** 扫描时的主机与端口；改动输入后需重新扫描 */
const scannedFor = ref('');
const selected = ref<string[]>([]);

const HOST =
  /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$|^\[?[0-9a-fA-F:.]+\]?$/;

watch(open, (visible) => {
  if (!visible) return;
  host.value = '';
  port.value = 22;
  scanned.value = null;
  scannedFor.value = '';
  selected.value = [];
});
watch([host, port], () => {
  if (scannedFor.value && scannedFor.value !== `${host.value}:${port.value}`) {
    scanned.value = null;
    selected.value = [];
  }
});

async function scan() {
  const name = host.value.trim();
  if (!HOST.test(name)) {
    ElMessage.error('请输入有效的主机名，例如 git.example.com');
    return;
  }
  scanning.value = true;
  try {
    scanned.value = await scanKnownHost(name, port.value);
    scannedFor.value = `${host.value}:${port.value}`;
    selected.value = [];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '扫描失败');
  } finally {
    scanning.value = false;
  }
}

function toggle(fingerprint: string) {
  selected.value = selected.value.includes(fingerprint)
    ? selected.value.filter((f) => f !== fingerprint)
    : [...selected.value, fingerprint];
}

async function save() {
  const keys = (scanned.value ?? []).filter((k) =>
    selected.value.includes(k.fingerprint),
  );
  if (!keys.length) return;
  saving.value = true;
  try {
    await addKnownHosts(host.value.trim(), port.value, keys);
    ElMessage.success(
      `已信任 ${host.value.trim()} 的 ${keys.length} 个主机公钥`,
    );
    open.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="添加受信任主机"
    width="min(520px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <div class="space-y-5">
      <div>
        <div class="grid grid-cols-[1fr_88px_auto] items-end gap-2">
          <label class="min-w-0">
            <span class="mb-1.5 block text-sm text-slate-700">主机</span>
            <el-input
              v-model="host"
              class="font-mono"
              placeholder="git.example.com"
              @keyup.enter="scan"
            />
          </label>
          <label>
            <span class="mb-1.5 block text-sm text-slate-700">端口</span>
            <el-input-number
              v-model="port"
              :min="1"
              :max="65535"
              :controls="false"
              class="!w-full"
            />
          </label>
          <el-button :icon="Search" :loading="scanning" @click="scan"
            >扫描</el-button
          >
        </div>
        <p class="mt-1.5 text-xs text-slate-500">
          服务端读取主机公钥，不登录、不发送任何密钥。
        </p>
      </div>

      <div v-if="scanned">
        <div class="mb-2 flex items-baseline justify-between">
          <span class="text-sm text-slate-700">扫描结果</span>
          <span class="text-xs text-slate-500"
            >已选 {{ selected.length }} / {{ scanned.length }}</span
          >
        </div>
        <p
          v-if="!scanned.length"
          class="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500"
        >
          未扫描到主机公钥，请检查主机名与端口。
        </p>
        <ul
          v-else
          class="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200"
        >
          <li v-for="item in scanned" :key="item.fingerprint">
            <button
              type="button"
              role="checkbox"
              :aria-checked="selected.includes(item.fingerprint)"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition"
              :class="
                selected.includes(item.fingerprint)
                  ? 'bg-brand-50/60'
                  : 'hover:bg-slate-50'
              "
              @click="toggle(item.fingerprint)"
            >
              <span
                class="grid size-4 shrink-0 place-items-center rounded border transition"
                :class="
                  selected.includes(item.fingerprint)
                    ? 'border-brand-500 bg-brand-500 text-white'
                    : 'border-slate-300 bg-white'
                "
                ><el-icon v-if="selected.includes(item.fingerprint)" :size="11"
                  ><Check /></el-icon
              ></span>
              <span class="min-w-0 flex-1">
                <span class="block text-xs text-slate-500">{{
                  item.keyType
                }}</span>
                <span
                  class="mt-0.5 block font-mono text-xs break-all text-slate-800"
                  >{{ item.fingerprint }}</span
                >
              </span>
            </button>
          </li>
        </ul>
        <NoticeBar v-if="scanned.length" tone="warning" class="mt-3">
          请逐一核对代码托管平台公布的指纹，一致后再信任。指纹不符可能意味着连接被劫持。
        </NoticeBar>
      </div>
    </div>

    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!selected.length"
        :loading="saving"
        @click="save"
        >信任所选公钥</el-button
      >
    </template>
  </el-dialog>
</template>
