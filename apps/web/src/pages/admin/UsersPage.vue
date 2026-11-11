<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import { Plus, Key, MagicStick, Delete } from '@element-plus/icons-vue';
import type { Role, User } from '../../api/types';
import { createUser, db, deleteUser, now, updateUser } from '../../api/store';
import { confirmDelete } from '../../utils/confirm';
import { currentUser } from '../../auth';
import { formatDate, relativeTime } from '../../utils/format';
import PageHeader from '../../components/PageHeader.vue';

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(
    crypto.getRandomValues(new Uint32Array(12)),
    (n) => chars[n % chars.length],
  ).join('');
}

/* 新建用户 */
const createOpen = ref(false);
const createRef = ref<FormInstance>();
const creating = ref(false);
const form = reactive({
  username: '',
  displayName: '',
  role: 'user' as Role,
  password: '',
});
const rules: FormRules<typeof form> = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    {
      pattern: /^[a-z][a-z0-9._-]{2,31}$/,
      message: '3–32 位小写字母、数字、点、下划线或短横线，字母开头',
      trigger: 'blur',
    },
  ],
  password: [
    { required: true, message: '请设置初始密码', trigger: 'blur' },
    { min: 8, message: '至少 8 位', trigger: 'blur' },
  ],
};
function openCreate() {
  Object.assign(form, {
    username: '',
    displayName: '',
    role: 'user',
    password: generatePassword(),
  });
  createOpen.value = true;
}
async function submitCreate() {
  if (!(await createRef.value?.validate().catch(() => false))) return;
  creating.value = true;
  try {
    await createUser({
      ...form,
      displayName: form.displayName || form.username,
    });
    createOpen.value = false;
    ElMessage.success(`已创建账号 ${form.username}，请将初始密码告知对方`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建失败');
  } finally {
    creating.value = false;
  }
}

/* 启用 / 禁用、角色 */
async function patch(
  user: User,
  data: Partial<User> & { password?: string },
  success: string,
) {
  try {
    await updateUser(user.id, data);
    ElMessage.success(success);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
    return false;
  }
}
const toggling = ref<number | null>(null);
async function beforeToggle(user: User) {
  toggling.value = user.id;
  const ok = await patch(
    user,
    { enabled: !user.enabled },
    user.enabled
      ? `已禁用 ${user.username}，其会话已失效`
      : `已启用 ${user.username}`,
  );
  toggling.value = null;
  return ok && false; // 状态由 API 数据驱动，阻止开关自行翻转
}

/* 删除账号 */
const deleting = ref<number | null>(null);
function deleteBlockedReason(user: User) {
  if (user.id === currentUser.value?.id) return '不能删除当前登录的账号';
  const otherAdmins = db.users.filter(
    (item) => item.id !== user.id && item.role === 'admin' && item.enabled,
  ).length;
  if (user.role === 'admin' && user.enabled && otherAdmins === 0)
    return '至少需要保留一个启用的管理员';
  return '';
}
async function removeUser(user: User) {
  const jobCount = db.jobs.filter(
    (job) => job.triggeredBy === user.username,
  ).length;
  const ok = await confirmDelete({
    title: '删除用户',
    target: `${user.username}（${user.displayName}）· ${user.role === 'admin' ? '管理员' : '普通用户'}`,
    scope: ['账号、密码及角色信息', '该账号的全部登录会话（立即下线）'],
    note: `其发起的 ${jobCount} 个构建任务及测试状态记录会保留，发起人仍显示为「${user.username}」。删除后可用同名重新创建账号，但不会恢复原账号。`,
  });
  if (!ok || !currentUser.value) return;
  deleting.value = user.id;
  try {
    await deleteUser(user.id, currentUser.value.id);
    ElMessage.success(`已删除用户 ${user.username}`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败');
  } finally {
    deleting.value = null;
  }
}

/* 重置密码 */
const resetOpen = ref(false);
const resetUser = ref<User | null>(null);
const newPassword = ref('');
const resetting = ref(false);
function openReset(user: User) {
  resetUser.value = user;
  newPassword.value = generatePassword();
  resetOpen.value = true;
}
async function submitReset() {
  if (!resetUser.value || newPassword.value.length < 8) {
    ElMessage.warning('新密码至少 8 位');
    return;
  }
  resetting.value = true;
  if (
    await patch(
      resetUser.value,
      { password: newPassword.value },
      `${resetUser.value.username} 的密码已重置`,
    )
  )
    resetOpen.value = false;
  resetting.value = false;
}
</script>

<template>
  <PageHeader
    title="用户"
    description="不开放注册，由管理员创建账号。禁用会立即撤销登录会话，可随时恢复；删除为永久移除。"
  >
    <el-button type="primary" :icon="Plus" @click="openCreate"
      >新建用户</el-button
    >
  </PageHeader>

  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <el-table :data="db.users" row-key="id">
      <el-table-column label="用户" min-width="220">
        <template #default="{ row }">
          <div
            class="flex items-center gap-3"
            :class="{ 'opacity-50': !row.enabled }"
          >
            <span
              class="grid size-9 place-items-center rounded-full text-sm font-medium uppercase"
              :class="
                row.role === 'admin'
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600'
              "
              >{{ row.username.slice(0, 1) }}</span
            >
            <div class="leading-tight">
              <p class="font-medium text-slate-900">
                {{ row.username }}
                <span
                  v-if="row.id === currentUser?.id"
                  class="ml-1 text-xs font-normal text-slate-400"
                  >（你）</span
                >
              </p>
              <p class="text-xs text-slate-500">{{ row.displayName }}</p>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="角色" width="150">
        <template #default="{ row }">
          <el-select
            :model-value="row.role"
            size="small"
            class="!w-28"
            :disabled="row.id === currentUser?.id"
            @change="
              (role: Role) =>
                patch(
                  row,
                  { role },
                  `${row.username} 已设为${role === 'admin' ? '管理员' : '普通用户'}`,
                )
            "
          >
            <el-option label="管理员" value="admin" />
            <el-option label="普通用户" value="user" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-switch
            :model-value="row.enabled"
            :loading="toggling === row.id"
            :disabled="row.id === currentUser?.id"
            :before-change="() => beforeToggle(row)"
            inline-prompt
            active-text="启用"
            inactive-text="禁用"
          />
        </template>
      </el-table-column>
      <el-table-column label="最近登录" width="140">
        <template #default="{ row }">
          <span class="text-xs text-slate-600">{{
            row.lastLoginAt ? relativeTime(row.lastLoginAt, now) : '从未登录'
          }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建于" width="120">
        <template #default="{ row }">
          <span class="text-xs text-slate-600">{{
            formatDate(row.createdAt)
          }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" align="right">
        <template #default="{ row }">
          <el-button link type="primary" :icon="Key" @click="openReset(row)"
            >重置密码</el-button
          >
          <el-tooltip
            :content="deleteBlockedReason(row)"
            :disabled="!deleteBlockedReason(row)"
            placement="top"
          >
            <span class="ml-3 inline-flex align-middle">
              <el-button
                link
                type="danger"
                :icon="Delete"
                :loading="deleting === row.id"
                :disabled="Boolean(deleteBlockedReason(row))"
                @click="removeUser(row)"
                >删除</el-button
              >
            </span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </section>
  <p class="mt-3 text-xs text-slate-500">
    普通用户可发起构建、查看日志、修改测试状态，并停止/删除自己发起的任务；管理员额外管理项目配置、用户与并行设置。
  </p>

  <el-dialog
    v-model="createOpen"
    title="新建用户"
    width="min(460px, calc(100vw - 32px))"
  >
    <el-form
      ref="createRef"
      :model="form"
      :rules="rules"
      label-position="top"
      @submit.prevent="submitCreate"
    >
      <el-form-item label="账号" prop="username">
        <el-input
          v-model="form.username"
          placeholder="例如 li.ming"
          autocomplete="off"
        />
      </el-form-item>
      <el-form-item label="显示名称">
        <el-input
          v-model="form.displayName"
          placeholder="可选，例如：测试 · 李明"
        />
      </el-form-item>
      <el-form-item label="角色">
        <el-radio-group v-model="form.role">
          <el-radio-button value="user">普通用户</el-radio-button>
          <el-radio-button value="admin">管理员</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="初始密码" prop="password">
        <el-input v-model="form.password" class="font-mono">
          <template #append>
            <el-button
              :icon="MagicStick"
              @click="form.password = generatePassword()"
              >生成</el-button
            >
          </template>
        </el-input>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createOpen = false">取消</el-button>
      <el-button type="primary" :loading="creating" @click="submitCreate"
        >创建</el-button
      >
    </template>
  </el-dialog>

  <el-dialog
    v-model="resetOpen"
    title="重置密码"
    width="min(420px, calc(100vw - 32px))"
  >
    <p class="mb-3 text-sm text-slate-600">
      为
      <span class="font-medium text-slate-900">{{ resetUser?.username }}</span>
      设置新密码，对方现有会话将失效。
    </p>
    <el-input v-model="newPassword" class="font-mono" aria-label="新密码">
      <template #append>
        <el-button :icon="MagicStick" @click="newPassword = generatePassword()"
          >生成</el-button
        >
      </template>
    </el-input>
    <template #footer>
      <el-button @click="resetOpen = false">取消</el-button>
      <el-button type="primary" :loading="resetting" @click="submitReset"
        >重置</el-button
      >
    </template>
  </el-dialog>
</template>
