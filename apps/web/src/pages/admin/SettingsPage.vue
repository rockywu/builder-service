<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Lock, Monitor, Refresh } from '@element-plus/icons-vue';
import type { KnownHost, SshKey } from '../../api/types';
import {
  OCCUPYING,
  db,
  deleteKnownHost,
  deleteSshKey,
  loadKnownHosts,
  loadSshKeys,
  now,
  saveSettings,
} from '../../api/store';
import { confirmDelete } from '../../utils/confirm';
import { formatDate, relativeTime } from '../../utils/format';
import PageHeader from '../../components/PageHeader.vue';
import SshKeyDialog from '../../components/SshKeyDialog.vue';
import KnownHostDialog from '../../components/KnownHostDialog.vue';

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

/* Git SSH 密钥 */
const keysLoading = ref(false);
const keysError = ref('');
async function reloadKeys() {
  keysLoading.value = true;
  keysError.value = '';
  try {
    await loadSshKeys();
  } catch (error) {
    keysError.value = error instanceof Error ? error.message : '加载失败';
  } finally {
    keysLoading.value = false;
  }
}
const keyDialog = ref(false);
const editingKey = ref<SshKey | null>(null);
function openKey(key: SshKey | null) {
  editingKey.value = key;
  keyDialog.value = true;
}
function projectNames(key: SshKey) {
  return key.projectIds
    .map((id) => db.projects.find((p) => p.id === id)?.name ?? `#${id}`)
    .join('、');
}
async function copyPublicKey(key: SshKey) {
  try {
    await navigator.clipboard.writeText(key.publicKey);
    ElMessage.success(`已复制 ${key.name} 的公钥`);
  } catch {
    ElMessage.error('复制失败，请在编辑中查看公钥');
  }
}
const deletingKey = ref<number | null>(null);
async function removeKey(key: SshKey) {
  const used = key.projectIds.length;
  const ok = await confirmDelete({
    title: '删除 SSH 密钥',
    target: `${key.name} · ${key.fingerprint}`,
    scope: ['密钥名称及加密保存的私钥'],
    note:
      (used
        ? `以下 ${used} 个项目将无法拉取 SSH 仓库：${projectNames(key)}；已排队且使用该密钥的任务会在拉取时失败。`
        : '当前没有项目使用该密钥。') +
      '代码托管平台上的 Deploy Key 需要另行移除。',
  });
  if (!ok) return;
  deletingKey.value = key.id;
  try {
    await deleteSshKey(key.id);
    ElMessage.success(`已删除密钥 ${key.name}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
  } finally {
    deletingKey.value = null;
  }
}

/* 受信任主机 */
const hostsLoading = ref(false);
const hostsError = ref('');
async function reloadHosts() {
  hostsLoading.value = true;
  hostsError.value = '';
  try {
    await loadKnownHosts();
  } catch (error) {
    hostsError.value = error instanceof Error ? error.message : '加载失败';
  } finally {
    hostsLoading.value = false;
  }
}
const hostDialog = ref(false);
const deletingHost = ref<number | null>(null);
async function removeHost(item: KnownHost) {
  const ok = await confirmDelete({
    title: '移除受信任主机',
    target: `${item.host}:${item.port} · ${item.keyType}`,
    scope: ['该主机公钥的信任记录'],
    note: `${item.fingerprint}。移除后，若该主机没有其他受信任公钥，使用它的项目将无法拉取。`,
  });
  if (!ok) return;
  deletingHost.value = item.id;
  try {
    await deleteKnownHost(item.id);
    ElMessage.success(`已移除 ${item.host} 的 ${item.keyType} 公钥`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '移除失败');
  } finally {
    deletingHost.value = null;
  }
}

onMounted(() => {
  void reloadKeys();
  void reloadHosts();
});
</script>

<template>
  <PageHeader
    title="设置"
    description="平台全局设置。资源额度、超时默认值与存储位置由部署配置管理。"
  />

  <section class="rounded-xl border border-slate-200 bg-white">
    <div
      class="grid gap-6 p-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto] lg:items-center lg:gap-10"
    >
      <div>
        <h2 class="text-base font-semibold text-slate-900">并行构建数</h2>
        <p class="mt-1 text-sm text-slate-500">
          同时占用执行槽位的任务上限。超出的任务按入队顺序等待；准备代码和收集产物也会占用槽位。
        </p>
      </div>

      <div class="min-w-0">
        <p class="mb-2 text-xs text-slate-500">
          槽位预览<span class="mx-1.5 text-slate-300">·</span>执行中
          {{ occupied }} · 排队 {{ queued }}
        </p>
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
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <el-input-number
          v-model="value"
          :min="1"
          :max="16"
          size="large"
          aria-label="并行构建数"
        />
        <el-button
          size="large"
          :disabled="!dirty"
          @click="value = db.settings.maxConcurrent"
          >还原</el-button
        >
        <el-button
          size="large"
          type="primary"
          :disabled="!dirty"
          :loading="saving"
          class="!ml-0"
          @click="save"
          >保存</el-button
        >
      </div>
    </div>
    <p
      v-if="dirty && effect"
      class="border-t border-amber-100 bg-amber-50 px-6 py-2.5 text-xs text-amber-800"
    >
      {{ effect }}
    </p>
  </section>

  <div class="mt-10 mb-4">
    <h2 class="text-base font-semibold text-slate-900">Git 访问</h2>
    <p class="mt-1 text-sm text-slate-500">
      拉取 SSH 地址（git@ / ssh://）的仓库需要密钥和受信任主机；HTTPS
      仓库匿名拉取，不使用这里的配置。
    </p>
  </div>

  <div class="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
    <section
      class="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div class="flex flex-wrap items-start justify-between gap-4 p-6">
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-semibold text-slate-900">SSH 密钥</h3>
          <p class="mt-1 text-sm text-slate-500">
            在项目「构建配置」中选择。私钥加密保存，任何接口都不会返回。
          </p>
        </div>
        <el-button :icon="Plus" @click="openKey(null)">新增密钥</el-button>
      </div>

      <div
        v-loading="keysLoading"
        class="flex-1 border-t border-slate-100"
        :class="{ 'min-h-24': keysLoading && !db.sshKeys.length }"
      >
        <div v-if="keysError" class="px-6 py-8 text-center">
          <p class="text-sm text-slate-700">密钥列表加载失败</p>
          <p class="mt-1 text-xs text-slate-500">{{ keysError }}</p>
          <el-button
            class="!mt-3"
            size="small"
            :icon="Refresh"
            @click="reloadKeys"
            >重试</el-button
          >
        </div>
        <div
          v-else-if="!db.sshKeys.length && !keysLoading"
          class="px-6 py-10 text-center"
        >
          <span
            class="mx-auto grid size-10 place-items-center rounded-full bg-slate-100 text-slate-400"
            ><el-icon :size="18"><Lock /></el-icon
          ></span>
          <p class="mt-3 text-sm font-medium text-slate-700">还没有 SSH 密钥</p>
          <p class="mt-1 text-xs text-slate-500">
            新增后将公钥添加到代码仓库，即可在项目中选择使用。
          </p>
        </div>
        <ul v-else class="divide-y divide-slate-100">
          <li
            v-for="key in db.sshKeys"
            :key="key.id"
            class="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4 sm:flex-nowrap"
          >
            <span
              class="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500"
              ><el-icon :size="16"><Lock /></el-icon
            ></span>
            <div class="min-w-0 flex-1">
              <p class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium text-slate-900">{{
                  key.name
                }}</span>
                <span
                  class="shrink-0 rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-500"
                  >{{ key.type.toUpperCase() }} ·
                  {{ key.source === 'generated' ? '服务端生成' : '导入' }}</span
                >
              </p>
              <p
                class="mt-0.5 truncate font-mono text-xs text-slate-500"
                :title="key.fingerprint"
              >
                {{ key.fingerprint }}
              </p>
              <p class="mt-1 text-xs text-slate-500">
                <el-tooltip
                  :content="projectNames(key)"
                  :disabled="!key.projectIds.length"
                  placement="top"
                >
                  <span
                    :class="
                      key.projectIds.length
                        ? 'cursor-default text-slate-700'
                        : 'text-slate-400'
                    "
                    >{{
                      key.projectIds.length
                        ? `${key.projectIds.length} 个项目使用`
                        : '未被使用'
                    }}</span
                  >
                </el-tooltip>
                <span class="mx-1.5 text-slate-300">·</span>
                {{
                  key.lastUsedAt
                    ? `${relativeTime(key.lastUsedAt, now)}拉取`
                    : '从未拉取'
                }}
              </p>
            </div>
            <div class="flex shrink-0 items-center max-sm:w-full max-sm:pl-12">
              <el-button link type="primary" @click="copyPublicKey(key)"
                >复制公钥</el-button
              >
              <el-button link @click="openKey(key)">编辑</el-button>
              <el-button
                link
                type="danger"
                :loading="deletingKey === key.id"
                @click="removeKey(key)"
                >删除</el-button
              >
            </div>
          </li>
        </ul>
      </div>

      <p
        class="border-t border-slate-100 bg-slate-50/60 px-6 py-3 text-xs text-slate-500"
      >
        建议在代码托管平台将公钥添加为
        <span class="font-medium text-slate-700">只读 Deploy Key</span
        >，不要使用个人账号的密钥。
      </p>
    </section>

    <section
      class="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <div class="flex flex-wrap items-start justify-between gap-4 p-6">
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-semibold text-slate-900">受信任主机</h3>
          <p class="mt-1 text-sm text-slate-500">
            拉取时严格校验仓库主机公钥，未列出的主机会被拒绝连接。
          </p>
        </div>
        <el-button :icon="Plus" @click="hostDialog = true">添加主机</el-button>
      </div>

      <div
        v-loading="hostsLoading"
        class="flex-1 border-t border-slate-100"
        :class="{ 'min-h-24': hostsLoading && !db.knownHosts.length }"
      >
        <div v-if="hostsError" class="px-6 py-8 text-center">
          <p class="text-sm text-slate-700">主机列表加载失败</p>
          <p class="mt-1 text-xs text-slate-500">{{ hostsError }}</p>
          <el-button
            class="!mt-3"
            size="small"
            :icon="Refresh"
            @click="reloadHosts"
            >重试</el-button
          >
        </div>
        <div
          v-else-if="!db.knownHosts.length && !hostsLoading"
          class="px-6 py-10 text-center"
        >
          <span
            class="mx-auto grid size-10 place-items-center rounded-full bg-slate-100 text-slate-400"
            ><el-icon :size="18"><Monitor /></el-icon
          ></span>
          <p class="mt-3 text-sm font-medium text-slate-700">
            还没有受信任主机
          </p>
          <p class="mt-1 text-xs text-slate-500">
            添加仓库所在的主机（如 github.com）后才能通过 SSH 拉取。
          </p>
        </div>
        <ul v-else class="divide-y divide-slate-100">
          <li
            v-for="item in db.knownHosts"
            :key="item.id"
            class="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4 sm:flex-nowrap"
          >
            <span
              class="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500"
              ><el-icon :size="16"><Monitor /></el-icon
            ></span>
            <div class="min-w-0 flex-1">
              <p class="flex min-w-0 items-center gap-2">
                <span
                  class="truncate font-mono text-sm font-medium text-slate-900"
                  >{{ item.host
                  }}<span v-if="item.port !== 22" class="text-slate-400"
                    >:{{ item.port }}</span
                  ></span
                >
                <span
                  class="shrink-0 rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-500"
                  >{{ item.keyType }}</span
                >
              </p>
              <p
                class="mt-0.5 truncate font-mono text-xs text-slate-500"
                :title="`${item.fingerprint} · 添加于 ${formatDate(item.createdAt)}`"
              >
                {{ item.fingerprint }}
              </p>
            </div>
            <div class="flex shrink-0 items-center max-sm:w-full max-sm:pl-12">
              <el-button
                link
                type="danger"
                :loading="deletingHost === item.id"
                @click="removeHost(item)"
                >移除</el-button
              >
            </div>
          </li>
        </ul>
      </div>
      <p
        class="border-t border-slate-100 bg-slate-50/60 px-6 py-3 text-xs text-slate-500"
      >
        主机公钥变化时拉取会失败。核实变更后移除旧记录，再重新扫描添加。
      </p>
    </section>
  </div>

  <SshKeyDialog v-model="keyDialog" :ssh-key="editingKey" />
  <KnownHostDialog v-model="hostDialog" />
</template>
