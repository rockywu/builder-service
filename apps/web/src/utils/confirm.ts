import { h, render } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

interface ConfirmOptions {
  title: string;
  target: string;
  description?: string;
  scope?: string[];
  note?: string;
  confirmText: string;
  tone: 'warning' | 'danger';
}

/** 打开确认弹窗：图标与标题位于左上角，返回是否确认。 */
export function openConfirm(options: ConfirmOptions) {
  return new Promise<boolean>((resolve) => {
    const container = document.createElement('div');
    const onResult = (ok: boolean) => {
      render(null, container);
      resolve(ok);
    };
    render(h(ConfirmDialog, { ...options, onResult }), container);
  });
}

/** 物理删除前展示对象与清理范围，要求一次明确确认。 */
export function confirmDelete(options: {
  title: string;
  target: string;
  scope: string[];
  note?: string;
}) {
  return openConfirm({ ...options, confirmText: '确认删除', tone: 'danger' });
}
