<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  Plus,
  Search,
  VideoPlay,
  MoreFilled,
  Setting,
  List,
  Box,
  Link,
  Delete,
} from '@element-plus/icons-vue';
import type { Job, Project } from '../../api/types';
import { db, now, deleteProject } from '../../api/store';
import { isAdmin } from '../../auth';
import { relativeTime } from '../../utils/format';
import PageHeader from '../../components/PageHeader.vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import StatusTag from '../../components/StatusTag.vue';
import ProjectDrawer from '../../components/ProjectDrawer.vue';
import BuildDialog from '../../components/BuildDialog.vue';
import JobDrawer from '../../components/JobDrawer.vue';

const router = useRouter();
const search = ref('');
const drawerOpen = ref(false);
const buildOpen = ref(false);
const jobOpen = ref(false);
const activeProject = ref<Project | null>(null);
const activeJobId = ref<number | null>(null);
const deleteTarget = ref<Project | null>(null);
const deleteAnchor = ref<HTMLElement>();
const deletingId = ref<number | null>(null);
function rememberMenuAnchor(event: MouseEvent) {
  deleteAnchor.value = event.currentTarget as HTMLElement;
}
async function confirmProjectDelete() {
  const project = deleteTarget.value;
  if (!project || deletingId.value !== null) return;
  deleteTarget.value = null;
  deletingId.value = project.id;
  try {
    await deleteProject(project.id);
    ElMessage.success('项目已删除');
  } catch (error) {
    ElMessage.error(
      error instanceof Error ? error.message : '删除未完成，请重试',
    );
  } finally {
    deletingId.value = null;
  }
}

const cards = computed(() => {
  const q = search.value.trim().toLowerCase();
  return db.projects
    .filter(
      (p) =>
        !q || `${p.name} ${p.repository} ${p.slug}`.toLowerCase().includes(q),
    )
    .map((project) => {
      const jobs = db.jobs.filter((job) => job.projectId === project.id);
      const latestJob = jobs.reduce<Job | undefined>(
        (latest, job) => (!latest || job.seq > latest.seq ? job : latest),
        undefined,
      );
      const latestRelease = db.releases
        .filter((r) => r.projectId === project.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const active = jobs.filter((job) =>
        ['queued', 'running', 'canceling'].includes(job.status),
      ).length;
      return { project, latestJob, latestRelease, active };
    });
});

function openCreate() {
  activeProject.value = null;
  drawerOpen.value = true;
}
function openConfig(project: Project) {
  activeProject.value = project;
  drawerOpen.value = true;
}
function openBuild(project: Project) {
  activeProject.value = project;
  buildOpen.value = true;
}
function openJob(job: Job) {
  activeJobId.value = job.id;
  jobOpen.value = true;
}
function onCreated(job: Job) {
  ElMessage({
    type: 'success',
    message: `构建 #${job.number} 已加入队列`,
  });
  openJob(job);
}
function onCommand(command: string, project: Project) {
  if (command === 'delete' && isAdmin.value) deleteTarget.value = project;
  if (command === 'config') openConfig(project);
  if (command === 'builds')
    void router.push({ path: '/admin/builds', query: { project: project.id } });
  if (command === 'releases')
    void router.push({
      path: '/admin/releases',
      query: { project: project.id },
    });
  if (command === 'public')
    window.open(router.resolve(`/downloads/${project.slug}`).href, '_blank');
}
</script>

<template>
  <PageHeader
    title="项目"
    :description="`${db.projects.length} 个项目 · 配置仓库与构建脚本，一键发起构建`"
  >
    <el-input
      v-model="search"
      :prefix-icon="Search"
      clearable
      placeholder="搜索名称或仓库"
      class="!w-60"
      aria-label="搜索项目"
    />
    <el-button v-if="isAdmin" type="primary" :icon="Plus" @click="openCreate"
      >新建项目</el-button
    >
  </PageHeader>

  <div v-if="cards.length" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
    <article
      v-for="{ project, latestJob, latestRelease, active } in cards"
      :key="project.id"
      class="group flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs transition hover:border-slate-300 hover:shadow-md"
    >
      <div class="flex items-start gap-3 p-5 pb-4">
        <ProjectAvatar :project="project" size="lg" />
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-base font-semibold text-slate-900">
            {{ project.name }}
          </h2>
          <p class="truncate font-mono text-xs text-slate-500">
            {{ project.repository.replace(/^.*[:/]([^/]+\/[^/]+)$/, '$1') }}
          </p>
        </div>
        <el-dropdown
          trigger="click"
          placement="bottom-end"
          @command="(c: string) => onCommand(c, project)"
        >
          <el-button
            text
            circle
            :icon="MoreFilled"
            aria-label="更多操作"
            @click="rememberMenuAnchor"
          />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-if="isAdmin"
                command="config"
                :icon="Setting"
                :disabled="project.deleting"
                >构建配置</el-dropdown-item
              >
              <el-dropdown-item command="builds" :icon="List"
                >构建记录</el-dropdown-item
              >
              <el-dropdown-item command="releases" :icon="Box"
                >版本列表</el-dropdown-item
              >
              <el-dropdown-item command="public" :icon="Link" divided
                >公开下载页</el-dropdown-item
              >
              <el-dropdown-item
                v-if="isAdmin"
                command="delete"
                :icon="Delete"
                divided
                class="!text-red-600"
                :disabled="deletingId !== null"
              >
                {{ project.deleting ? '重试删除' : '删除项目' }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <p class="line-clamp-2 min-h-10 px-5 text-sm text-slate-600">
        {{
          project.deleting
            ? project.deletionError || '正在删除项目，请稍候'
            : project.description || '暂无描述'
        }}
      </p>

      <dl
        class="mx-5 mt-4 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-xs"
      >
        <div class="min-w-0">
          <dt class="text-slate-500">最近构建</dt>
          <dd class="mt-1">
            <button
              v-if="latestJob"
              type="button"
              class="flex items-center gap-1.5 rounded hover:opacity-80"
              :title="`查看构建 #${latestJob.number} 日志`"
              @click="openJob(latestJob)"
            >
              <StatusTag kind="job" :status="latestJob.status" size="small" />
              <span class="text-slate-500">#{{ latestJob.number }}</span>
            </button>
            <span v-else class="text-slate-400">尚未构建</span>
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-slate-500">最新版本</dt>
          <dd class="mt-1">
            <span v-if="latestRelease" class="flex items-center gap-1.5">
              <StatusTag
                kind="test"
                :status="latestRelease.testStatus"
                size="small"
              />
              <span class="truncate text-slate-500">{{
                relativeTime(latestRelease.createdAt, now)
              }}</span>
            </span>
            <span v-else class="text-slate-400">暂无版本</span>
          </dd>
        </div>
      </dl>

      <div class="mt-auto flex items-center justify-between gap-2 p-5 pt-4">
        <span class="min-w-0 truncate font-mono text-xs text-slate-500"
          >⑂ {{ project.defaultBranch }} · {{ project.workdir }}</span
        >
        <span class="flex shrink-0 items-center gap-3">
          <span
            v-if="active"
            class="text-xs text-brand-600"
            :title="`${active} 个任务排队或执行中`"
            >{{ active }} 进行中</span
          >
          <el-button
            type="primary"
            plain
            :icon="VideoPlay"
            :disabled="project.deleting || deletingId === project.id"
            @click="openBuild(project)"
            >发起构建</el-button
          >
        </span>
      </div>
    </article>

    <button
      v-if="isAdmin && !search"
      type="button"
      class="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-600"
      @click="openCreate"
    >
      <el-icon :size="24"><Plus /></el-icon>
      <span class="text-sm">新建项目</span>
    </button>
  </div>

  <el-empty v-else description="没有匹配的项目">
    <el-button @click="search = ''">清除搜索</el-button>
  </el-empty>

  <el-popconfirm
    :visible="deleteTarget !== null"
    virtual-triggering
    :virtual-ref="deleteAnchor"
    placement="bottom-end"
    :width="300"
    :title="`确定删除项目「${deleteTarget?.name ?? ''}」？将永久清理全部构建记录、源码副本、日志、版本和产物，公开下载立即失效。此操作无法撤销。`"
    confirm-button-text="删除项目"
    cancel-button-text="取消"
    confirm-button-type="danger"
    @confirm="confirmProjectDelete"
    @cancel="deleteTarget = null"
    @update:visible="
      (visible: boolean) => {
        if (!visible) deleteTarget = null;
      }
    "
  />
  <ProjectDrawer v-model="drawerOpen" :project="activeProject" />
  <BuildDialog
    v-model="buildOpen"
    :project="activeProject"
    @created="onCreated"
    @configure="openConfig"
  />
  <JobDrawer v-model="jobOpen" :job-id="activeJobId" />
</template>
