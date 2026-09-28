/** 生成、更新、重画与整理共用的内容分工；具体编号协议由各动作说明。 */
export const MAP_DOC_RULES = `

# Map 与 Doc 的内容分工
- Doc 按读者要弄懂的具体问题分章，用共同正文讲清几个判断如何关联、什么依据造成取舍或转折、现在如何理解。共同原因只讲一次；用自然短段落，确有并列问题才列点。正文不是节点逐条扩写，也不能只是章节导语或摘要。
- 节点标题用一句简短判断；节点说明通常 2–4 句，中文约 80–180 字作为参考：讲清它独有的依据、适用边界、确定程度，以及为何形成或改变这条判断。保持中等篇幅，必要信息优先，不机械凑字数或截断；不把整章背景和其他节点的解释塞入节点，也不把它压成一句含糊注释。
- 节点说明供单独查看和回查；章节共同正文供连续阅读，必须讲全相关判断的重要信息、依据与边界，不能要求读者再拼接节点说明才能理解。不要在共同正文里再列“### 节点名＋各自解释”。
- 主线先说明现在；长期愿景、定位、关键历史背景仍须有章节归属。过去诊断标明阶段，阶段收缩不等于长期放弃，推断和待验证不写成事实。保留必要条件、例外、否定原因和未决问题。
- 首次生成与重画为每章写共同正文，引用覆盖图上的全部判断。更新与整理同步重写受影响章节，解释这些章节全部存活判断，包含已有和新增判断；未受影响章节无需输出。不要为改正文重复创建旧节点。
- 正文与节点说明都必须有材料依据，不能凭引用声称解释了实际未处理的判断。来源不足时保留问题，不输出字面占位章节名。`;

/** 模型标签属性允许 XML 的两种引号；解码一次，避免双重解码原文。 */
export function readTagAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attributes[match[1]] = match[3].replace(/&(quot|apos|lt|gt|amp);/g, (_, entity: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[entity]!);
  }
  return attributes;
}

/** 仅检查新 AI 完整响应；历史解析与流式半成品不使用此校验。 */
export function validateMapDocOutput(raw: string): void {
  const text = raw.replace(/```(?:xml)?/gi, '');
  const docTags = [...text.matchAll(/<\/?doc(?=[\s>/]|$)[^>]*(?:>|$)/g)];
  if (docTags.length && (docTags.length !== 2 || !/^<doc\s*>$/.test(docTags[0][0]) || !/^<\/doc\s*>$/.test(docTags[1][0]))) {
    throw new Error('模型返回不完整或重复的文档标签，已保留原图文。');
  }
  const pattern = /<prose\b([^>]*)>([\s\S]*?)<\/prose\s*>/g;
  const remainder = text.replace(pattern, (_, rawAttributes: string, body: string) => {
    const attributes = readTagAttributes(rawAttributes);
    const malformed = rawAttributes.replace(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g, '').trim();
    if (malformed || !attributes.domain?.trim() || /[\[\]\r\n]/.test(attributes.domain)
      || !body.trim() || /<\/?prose\b/.test(body)) {
      throw new Error('模型返回的章节正文格式不完整或无效，已保留原图文。');
    }
    if (!['主题', '主线', 'Main thread'].includes(attributes.domain.trim()) && attributes.refs === undefined) {
      throw new Error('模型返回的章节正文缺少判断引用 refs，已保留原图文。');
    }
    return '';
  });
  if (/<\/?prose\b/.test(remainder)) throw new Error('模型返回不完整的章节正文标签，已保留原图文。');
}
