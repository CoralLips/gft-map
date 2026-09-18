/**
 * 剪贴板复制(带降级)——全项目唯一实现(工程审计批4 收口)。
 * 此前三份:projectExport 正版 / ChatView 手抄一遍 / InviteModal 只有 API 无兜底(非安全上下文直接失败)。
 * 语义对齐 ChatView 手抄版(最完整):clipboard API 存在但【拒绝】(权限/非 https)时也落 execCommand 兜底。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 权限拒/非安全上下文 → 降级 execCommand */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error('复制失败:', err);
    return false;
  }
}
