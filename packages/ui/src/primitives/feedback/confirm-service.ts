import { ElMessageBox } from '../../utils/element';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'primary' | 'danger';
}

/**
 * 响应式/Promise 风格的确认框，完全替代阻断主线程的 window.confirm()
 * @returns 当用户点击确认时 resolve(true)，取消或关闭时 resolve(false)
 */
export async function aervoxConfirm(options: ConfirmOptions): Promise<boolean> {
  try {
    await ElMessageBox.confirm(options.message, options.title ?? '请确认', {
      confirmButtonText: options.confirmText ?? '确认',
      cancelButtonText: options.cancelText ?? '取消',
      type: options.variant === 'danger' ? 'warning' : 'info',
      customClass: 'aervox-message-box',
      showClose: false,
      closeOnClickModal: false,
    });
    return true;
  } catch {
    return false;
  }
}
