<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import {
  CopyDocument,
  CircleCheckFilled,
  MagicStick,
  Upload,
} from '@element-plus/icons-vue';
import type { SshKey } from '../api/types';
import { createSshKey, updateSshKey } from '../api/store';
import NoticeBar from './NoticeBar.vue';

const props = defineProps<{ sshKey: SshKey | null }>();
const open = defineModel<boolean>({ required: true });

const formRef = ref<FormInstance>();
const pending = ref(false);
const editing = computed(() => Boolean(props.sshKey));
/** 生成成功后切换为公钥结果视图 */
const created = ref<SshKey | null>(null);
/** 编辑导入的密钥时是否更换私钥 */
const replacing = ref(false);
const form = reactive({
  name: '',
  mode: 'generate' as 'generate' | 'import',
  privateKey: '',
});

const PRIVATE_KEY =
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/;
const needsPrivateKey = computed(() =>
  editing.value ? replacing.value : form.mode === 'import',
);
const rules: FormRules<typeof form> = {
  name: [{ required: true, message: '请输入密钥名称', trigger: 'blur' }],
  privateKey: [
    {
      validator: (_rule, value: string, callback) => {
        if (!needsPrivateKey.value) return callback();
        if (!value.trim()) return callback(new Error('请粘贴私钥内容'));
        if (!PRIVATE_KEY.test(value.trim()))
          return callback(
            new Error('格式不正确，应以 -----BEGIN … PRIVATE KEY----- 开头'),
          );
        callback();
      },
      trigger: 'blur',
    },
  ],
};

watch(open, (visible) => {
  if (!visible) return;
  Object.assign(form, {
    name: props.sshKey?.name ?? '',
    mode: 'generate',
    privateKey: '',
  });
  created.value = null;
  replacing.value = false;
  formRef.value?.clearValidate();
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('公钥已复制');
  } catch {
    ElMessage.error('复制失败，请手动选择公钥文本');
  }
}

const sources = [
  {
    value: 'generate' as const,
    icon: MagicStick,
    title: '服务端生成',
    hint: 'ed25519，私钥不经过浏览器',
  },
  {
    value: 'import' as const,
    icon: Upload,
    title: '导入已有私钥',
    hint: '粘贴无口令的 OpenSSH 私钥',
  },
];

async function submit() {
  if (pending.value) return;
  if (!(await formRef.value?.validate().catch(() => false))) return;
  pending.value = true;
  try {
    const privateKey = form.privateKey.replace(/\r\n/g, '\n').trim() + '\n';
    if (props.sshKey) {
      await updateSshKey(props.sshKey.id, {
        name: form.name,
        ...(needsPrivateKey.value ? { privateKey } : {}),
      });
      ElMessage.success(needsPrivateKey.value ? '密钥已更换' : '密钥已保存');
      open.value = false;
    } else if (form.mode === 'generate') {
      created.value = await createSshKey({ name: form.name, mode: 'generate' });
    } else {
      await createSshKey({ name: form.name, mode: 'import', privateKey });
      ElMessage.success(`已导入密钥 ${form.name}`);
      open.value = false;
    }
    form.privateKey = '';
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    :title="
      created ? '密钥已生成' : editing ? '编辑 SSH 密钥' : '新增 SSH 密钥'
    "
    width="min(520px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <!-- 生成结果 -->
    <div v-if="created" class="space-y-5">
      <div class="flex items-start gap-3 rounded-lg bg-emerald-50 p-3">
        <el-icon :size="20" class="mt-px shrink-0 text-emerald-500"
          ><CircleCheckFilled
        /></el-icon>
        <div class="min-w-0 text-sm">
          <p class="font-medium text-emerald-900">{{ created.name }}</p>
          <p class="mt-0.5 truncate font-mono text-xs text-emerald-800/80">
            {{ created.fingerprint }}
          </p>
        </div>
      </div>

      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <span class="text-sm text-slate-700">公钥</span>
          <el-button
            link
            type="primary"
            :icon="CopyDocument"
            @click="copy(created.publicKey)"
            >复制</el-button
          >
        </div>
        <textarea
          readonly
          rows="3"
          aria-label="公钥"
          class="block w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed break-all text-slate-800 outline-none focus:border-brand-300"
          :value="created.publicKey"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
      </div>

      <div>
        <p class="mb-2 text-sm text-slate-700">接下来</p>
        <ol class="space-y-2 text-sm text-slate-600">
          <li
            v-for="(step, index) in [
              '打开代码托管平台中该仓库的「设置 → Deploy Keys」',
              '粘贴公钥，只勾选读取权限',
              '在项目「构建配置」的代码仓库中选择此密钥',
            ]"
            :key="step"
            class="flex gap-2.5"
          >
            <span
              class="grid size-5 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-medium text-slate-500"
              >{{ index + 1 }}</span
            >
            <span>{{ step }}</span>
          </li>
        </ol>
      </div>
      <p class="text-xs text-slate-500">
        私钥已加密保存在服务端，不会再次显示；公钥可随时在列表中复制。
      </p>
    </div>

    <el-form
      v-else
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      require-asterisk-position="right"
      @submit.prevent="submit"
    >
      <!-- 编辑：当前密钥摘要 -->
      <div
        v-if="sshKey"
        class="mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-slate-50 p-3 text-xs"
      >
        <span class="text-slate-500">类型</span>
        <span class="text-slate-800"
          >{{ sshKey.type.toUpperCase() }} ·
          {{ sshKey.source === 'generated' ? '服务端生成' : '导入' }}</span
        >
        <span class="text-slate-500">指纹</span>
        <span class="truncate font-mono text-slate-800">{{
          sshKey.fingerprint
        }}</span>
        <span class="text-slate-500">使用</span>
        <span class="text-slate-800">{{
          sshKey.projectIds.length
            ? `${sshKey.projectIds.length} 个项目`
            : '未被项目使用'
        }}</span>
      </div>

      <el-form-item label="名称" prop="name">
        <el-input
          v-model="form.name"
          maxlength="40"
          placeholder="例如：gitlab-deploy-readonly"
        />
      </el-form-item>

      <!-- 新增：来源选择 -->
      <el-form-item v-if="!editing" label="来源">
        <div class="grid w-full gap-3 sm:grid-cols-2" role="radiogroup">
          <button
            v-for="item in sources"
            :key="item.value"
            type="button"
            role="radio"
            :aria-checked="form.mode === item.value"
            class="flex items-start gap-3 rounded-lg border p-3 text-left transition"
            :class="
              form.mode === item.value
                ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500'
                : 'border-slate-200 hover:border-slate-300'
            "
            @click="form.mode = item.value"
          >
            <span
              class="grid size-8 shrink-0 place-items-center rounded-md"
              :class="
                form.mode === item.value
                  ? 'bg-brand-500 text-white'
                  : 'bg-slate-100 text-slate-500'
              "
              ><el-icon :size="16"><component :is="item.icon" /></el-icon
            ></span>
            <span class="min-w-0 leading-snug">
              <span class="block text-sm font-medium text-slate-900"
                >{{ item.title
                }}<span
                  v-if="item.value === 'generate'"
                  class="ml-1.5 text-xs font-normal text-brand-600"
                  >推荐</span
                ></span
              >
              <span class="mt-0.5 block text-xs text-slate-500">{{
                item.hint
              }}</span>
            </span>
          </button>
        </div>
      </el-form-item>

      <!-- 编辑：更换私钥 -->
      <template v-else-if="sshKey">
        <NoticeBar v-if="sshKey.source === 'generated'">
          服务端生成的密钥不能更换私钥。如需轮换，请新增密钥并在项目中切换后删除旧密钥。
        </NoticeBar>
        <div
          v-else-if="!replacing"
          class="flex items-center justify-between rounded-md border border-dashed border-slate-300 px-3 py-2.5"
        >
          <span class="text-xs text-slate-600">需要轮换私钥？</span>
          <el-button size="small" @click="replacing = true">更换私钥</el-button>
        </div>
        <NoticeBar v-else tone="warning" class="mb-3">
          更换后指纹改变，{{
            sshKey.projectIds.length
              ? `正在使用的 ${sshKey.projectIds.length} 个项目`
              : '之后使用该密钥的项目'
          }}下次拉取将使用新私钥。
          <button
            type="button"
            class="ml-1 font-medium whitespace-nowrap underline"
            @click="replacing = false"
          >
            取消更换
          </button>
        </NoticeBar>
      </template>

      <el-form-item v-if="needsPrivateKey" label="私钥" prop="privateKey">
        <el-input
          v-model="form.privateKey"
          type="textarea"
          :rows="6"
          spellcheck="false"
          autocomplete="off"
          class="font-mono"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…&#10;-----END OPENSSH PRIVATE KEY-----"
        />
        <p class="mt-1.5 text-xs leading-relaxed text-slate-500">
          仅支持无口令的私钥。保存后加密存储，不会再次显示。
        </p>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button v-if="created" type="primary" @click="open = false"
        >完成</el-button
      >
      <template v-else>
        <el-button @click="open = false">取消</el-button>
        <el-button type="primary" :loading="pending" @click="submit">{{
          editing ? '保存' : form.mode === 'generate' ? '生成密钥' : '导入'
        }}</el-button>
      </template>
    </template>
  </el-dialog>
</template>
