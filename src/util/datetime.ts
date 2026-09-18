/**
 * 日期时间格式化(工程审计批4 收口)——此前 6 处手搓 padStart 拼串,其中两对逐字重复。
 * 只收"同格式的重复",口径不同的(侧栏带秒全戳/分享图 toLocaleDateString)留在原处。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 'MM-DD HH:MM'——设置页用量流水 / 节点版本历史共用 */
export function fmtDateTime(input: number | string | Date): string {
  const d = new Date(input);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 'YYYY-MM-DD'——导出文件名 / 导入导出的 commit 日期戳共用(格式是文件名契约,勿改) */
export function fmtDayStamp(input?: number | string | Date): string {
  const d = input === undefined ? new Date() : new Date(input);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
