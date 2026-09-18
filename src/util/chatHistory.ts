/**
 * 把对话历史拼成喂 AI 的纯文本（过滤掉 AI 错误/失败占位消息）。
 * 为聊天、思维脉络提取等调用提供统一的历史文本。
 */

// ===== AI 错误占位常量(批4:此前 5 个文件各写字面量,改标记要跨文件找齐) =====
/** 流式失败占位前缀(后跟错误详情;产出于 useFocusChat,消费于重试判定/渲染/realtime 去重) */
export const AI_STREAM_ERROR_PREFIX = '[AI_STREAM_ERROR]';
/** 非流式失败的整条占位 */
export const AI_FAILED_PLACEHOLDER = '[AI 回复失败]';
/** 这条内容是不是 AI 错误占位(整条判定:前缀式流错误 或 精确失败占位) */
export const isAiErrorContent = (content: string | undefined | null): boolean =>
  !!content && (content.startsWith(AI_STREAM_ERROR_PREFIX) || content === AI_FAILED_PLACEHOLDER);

/** 这条消息有没有可喂 AI 的实质内容（非空、非错误占位） */
export function isFeedableMessage(m: { content: string }): boolean {
  const c = m.content?.trim();
  return !!c && !c.startsWith('[AI 回复') && !c.startsWith(AI_STREAM_ERROR_PREFIX);
}

export function buildChatText(
  chatHistory: { role: string; userName?: string | null; content: string }[],
): string {
  return chatHistory
    .filter(isFeedableMessage)
    .map(m => `${m.role === 'user' ? (m.userName || '用户') : 'AI'}：${m.content.trim()}`)
    .join('\n\n');
}

/**
 * 用户发言清单：把切片里用户的原话按序号全文列出（不截断），附在对话文本末尾。
 * 给生成端当抽取主线——AI 长回复占对话体量七成以上，用户的核心提问淹没其中易被漏抽；
 * 清单把他的原话直陈眼前（2026-07-12 重画遗漏率 ~40% 的修复之一）。
 * ⚠ 只做呈现，不许在 prompt 里挂"逐条落点"义务——那会教模型每句发言造一个节点（07-12 注水教训）。
 */
export function buildUserSpeechList(
  chatHistory: { role: string; content: string }[],
): string {
  const userMsgs = chatHistory.filter(m => m.role === 'user' && isFeedableMessage(m));
  if (userMsgs.length === 0) return '';
  return `# 用户发言清单\n\n${userMsgs.map((m, i) => `#${i + 1} ${m.content.trim()}`).join('\n\n')}`;
}
