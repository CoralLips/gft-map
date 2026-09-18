import { createPortal } from 'react-dom';
import { create } from 'zustand';
import styles from './ConfirmDialog.module.css';

// ========== Store ==========

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  danger: boolean;
  confirmText: string;
  cancelText: string;
  resolve: ((value: boolean) => void) | null;
}

const useConfirmStore = create<ConfirmState>(() => ({
  isOpen: false,
  title: '',
  message: '',
  danger: false,
  confirmText: '确认',
  cancelText: '取消',
  resolve: null,
}));

// ========== 命令式 API ==========

interface ConfirmOptions {
  title: string;
  message: string;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState({
      isOpen: true,
      title: options.title,
      message: options.message,
      danger: options.danger ?? false,
      confirmText: options.confirmText ?? (options.danger ? '删除' : '确认'),
      cancelText: options.cancelText ?? '取消',
      resolve,
    });
  });
}

// ========== 组件 ==========

export function ConfirmDialog() {
  const { isOpen, title, message, danger, confirmText, cancelText, resolve } = useConfirmStore();

  if (!isOpen) return null;

  const close = (result: boolean) => {
    resolve?.(result);
    useConfirmStore.setState({ isOpen: false, resolve: null });
  };

  return createPortal(
    <div data-confirm-dialog="true" className={styles.overlay} onClick={() => close(false)}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          {/* cancelText 空串=单按钮提示模式(如"本地存储已满"告知类,无需取消) */}
          {cancelText && (
            <button className={styles.cancelBtn} onClick={() => close(false)}>
              {cancelText}
            </button>
          )}
          <button
            className={`${styles.confirmBtn} ${danger ? styles.danger : ''}`}
            onClick={() => close(true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
