<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules, UploadFile } from 'element-plus';
import { ElMessage } from 'element-plus';
import { Upload, QuestionFilled } from '@element-plus/icons-vue';
import type { Project, ProjectInput } from '../mocks/types';
import { saveProject, scriptCommands } from '../mocks/db';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps<{ project: Project | null }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ saved: [project: Project] }>();

const formRef = ref<FormInstance>();
const pending = ref(false);
const iconError = ref('');
const emptyForm = (): ProjectInput => ({
  name: '',
  description: '',
  repository: '',
  defaultBranch: 'main',
  workdir: './',
  buildScript:
    '#!/usr/bin/env bash\n# 在「工作目录」下以 bash -e 执行，任一命令失败即终止构建\nnpm ci\nnpm run build\n',
  artifactPath: './dist',
  timeout: 30,
});
const form = reactive<ProjectInput>(emptyForm());
const editing = computed(() => Boolean(props.project));

const rules: FormRules<ProjectInput> = {
  name: [{ required: true, message: '请输入项目名称', trigger: 'blur' }],
  repository: [
    { required: true, message: '请输入 Git 仓库地址', trigger: 'blur' },
    {
      pattern: /^(git@|https:\/\/|ssh:\/\/)/,
      message: '支持 git@、ssh:// 或 https:// 开头的地址',
      trigger: 'blur',
    },
  ],
  defaultBranch: [
    { required: true, message: '请输入默认分支', trigger: 'blur' },
  ],
  workdir: [
    { required: true, message: '请输入工作目录', trigger: 'blur' },
    {
      pattern: /^\.\/(?!.*\.\.)/,
      message: '以 ./ 开头的仓库内相对路径，不能包含 ..',
      trigger: 'blur',
    },
  ],
  buildScript: [
    {
      validator: (_rule, value: string, callback) =>
        scriptCommands(value ?? '').length
          ? callback()
          : callback(new Error('构建脚本至少需要一条命令')),
      trigger: 'blur',
    },
  ],
  artifactPath: [
    { required: true, message: '请输入产物路径', trigger: 'blur' },
  ],
};

watch(open, (visible) => {
  if (!visible) return;
  const p = props.project;
  Object.assign(
    form,
    p
      ? {
          name: p.name,
          description: p.description,
          repository: p.repository,
          defaultBranch: p.defaultBranch,
          workdir: p.workdir,
          buildScript: p.buildScript,
          artifactPath: p.artifactPath,
          timeout: p.timeout,
          icon: p.icon,
        }
      : { ...emptyForm(), icon: undefined },
  );
  iconError.value = '';
  formRef.value?.clearValidate();
});

const preview = computed(() => ({
  name: form.name || '新',
  color: props.project?.color ?? '#2563eb',
  icon: form.icon,
}));

function selectIcon(file: UploadFile) {
  iconError.value = '';
  const raw = file.raw;
  if (!raw) return false;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(raw.type)) {
    iconError.value = '仅支持 PNG、JPG、WebP 格式';
    return false;
  }
  if (raw.size > 2 * 1024 * 1024) {
    iconError.value = '图片不能超过 2 MB';
    return false;
  }
  const reader = new FileReader();
  reader.onload = () => (form.icon = String(reader.result));
  reader.readAsDataURL(raw);
  return false;
}

async function submit() {
  if (pending.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  pending.value = true;
  try {
    const saved = await saveProject(
      { ...form, buildScript: form.buildScript.replace(/\r\n/g, '\n') },
      props.project?.id,
    );
    emit('saved', saved);
    open.value = false;
    ElMessage.success(
      editing.value ? '构建配置已保存，下次构建生效' : '项目已创建',
    );
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <el-drawer
    v-model="open"
    :title="editing ? '构建配置' : '新建项目'"
    size="min(640px, 100vw)"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      require-asterisk-position="right"
      class="space-y-8"
      @submit.prevent="submit"
    >
      <section>
        <h3 class="mb-4 text-sm font-semibold text-slate-900">基本信息</h3>
        <div
          class="mb-5 flex items-center gap-4 rounded-lg border border-dashed border-slate-300 p-4"
        >
          <ProjectAvatar :project="preview" size="xl" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap gap-2">
              <el-upload
                :show-file-list="false"
                :auto-upload="false"
                accept="image/png,image/jpeg,image/webp"
                :on-change="selectIcon"
              >
                <el-button :icon="Upload" size="small">上传图标</el-button>
              </el-upload>
              <el-button
                v-if="form.icon"
                size="small"
                text
                @click="form.icon = undefined"
                >使用默认图标</el-button
              >
            </div>
            <p
              class="mt-2 text-xs"
              :class="iconError ? 'text-red-600' : 'text-slate-500'"
            >
              {{
                iconError ||
                'PNG / JPG / WebP，2 MB 以内。不上传则显示名称首字。'
              }}
            </p>
          </div>
        </div>
        <el-form-item label="项目名称" prop="name">
          <el-input
            v-model="form.name"
            maxlength="40"
            placeholder="例如：星云工作台"
          />
        </el-form-item>
        <el-form-item label="项目描述" prop="description">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            maxlength="120"
            show-word-limit
            placeholder="可选，展示在项目列表和公开下载页"
          />
        </el-form-item>
      </section>

      <section>
        <h3 class="mb-4 text-sm font-semibold text-slate-900">代码仓库</h3>
        <el-form-item label="Git 仓库地址" prop="repository">
          <el-input
            v-model="form.repository"
            class="font-mono"
            placeholder="git@git.example.com:group/repo.git"
          />
        </el-form-item>
        <div class="grid gap-x-4 sm:grid-cols-2">
          <el-form-item label="默认分支" prop="defaultBranch">
            <el-input v-model="form.defaultBranch" class="font-mono" />
          </el-form-item>
          <el-form-item prop="workdir">
            <template #label>
              <span class="inline-flex items-center gap-1"
                >工作目录
                <el-tooltip placement="top" :show-after="100">
                  <template #content>
                    <div class="max-w-64 leading-relaxed">
                      构建脚本在仓库中的哪个目录下执行，相对仓库根目录。<br />
                      普通项目填 <code>./</code>；Monorepo 子项目填子目录，如
                      <code>./apps/web</code>。<br />
                      产物路径也相对这个目录。
                    </div>
                  </template>
                  <el-icon class="cursor-help text-slate-400"
                    ><QuestionFilled
                  /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input
              v-model="form.workdir"
              class="font-mono"
              placeholder="./"
            />
          </el-form-item>
        </div>
        <div
          class="rounded-md bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600"
        >
          <span class="font-medium text-slate-800">工作目录</span>
          是构建脚本在仓库里的执行位置（相对仓库根目录），产物路径也相对它计算。
          普通项目填 <code class="font-mono text-slate-800">./</code>； Monorepo
          中只构建某个子项目时填子目录，如
          <code class="font-mono text-slate-800">./apps/web</code>。
        </div>
      </section>

      <section>
        <div class="mb-3 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-slate-900">构建脚本</h3>
          <span class="text-xs text-slate-500"
            >{{ scriptCommands(form.buildScript).length }} 条命令</span
          >
        </div>
        <el-form-item prop="buildScript">
          <div
            class="w-full overflow-hidden rounded-lg border border-slate-800"
          >
            <div
              class="flex items-center justify-between bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-400"
            >
              <span>build.sh</span>
              <span
                >cd
                <span class="text-slate-200">{{ form.workdir || './' }}</span>
                &amp;&amp; bash -e build.sh</span
              >
            </div>
            <textarea
              v-model="form.buildScript"
              rows="10"
              spellcheck="false"
              aria-label="构建脚本"
              class="block min-h-48 w-full resize-y bg-slate-900 p-3 font-mono text-[13px] leading-relaxed text-slate-100 caret-brand-400 outline-none placeholder:text-slate-500"
              placeholder="npm ci&#10;npm run build"
              @keydown.tab.prevent="
                (e: KeyboardEvent) => {
                  const el = e.target as HTMLTextAreaElement;
                  el.setRangeText(
                    '  ',
                    el.selectionStart,
                    el.selectionEnd,
                    'end',
                  );
                  form.buildScript = el.value;
                }
              "
            />
          </div>
        </el-form-item>
        <p class="text-xs leading-relaxed text-slate-500">
          完整填写构建所需命令，在工作目录下按顺序执行，任一命令返回非 0
          即判定失败。可使用 <code class="text-slate-700">export</code>
          设置环境变量、调用仓库内脚本；运行在隔离容器内，无法访问宿主机。
        </p>
      </section>

      <section>
        <h3 class="mb-4 text-sm font-semibold text-slate-900">产物与限制</h3>
        <div class="grid gap-x-4 sm:grid-cols-2">
          <el-form-item label="产物路径" prop="artifactPath">
            <el-input v-model="form.artifactPath" class="font-mono" />
          </el-form-item>
          <el-form-item label="超时时间（分钟）" prop="timeout">
            <el-input-number
              v-model="form.timeout"
              :min="5"
              :max="180"
              :step="5"
              class="!w-full"
            />
          </el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="配置修改只影响之后发起的构建；已排队任务使用入队时的配置快照。"
        />
      </section>
    </el-form>

    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="open = false">取消</el-button>
        <el-button type="primary" :loading="pending" @click="submit">{{
          editing ? '保存配置' : '创建项目'
        }}</el-button>
      </div>
    </template>
  </el-drawer>
</template>
