import { appendLines, judgmentLines, proseLines, relationLine } from '../../../src/service/ledger';
import { appendSourceLog } from '../../../src/service/sourceLog';
import { createTopicBundle } from '../../../src/service/topicBundle';
import { englishExamples } from './examples-en';
import type { ShowcaseLanguage } from './locale';

export interface Example {
  id: 'product' | 'writing' | 'engineering';
  name: string; category: string; headline: string; situation: string; scope: string; summary: string;
  sections: readonly (readonly [string, string])[];
  nodes: readonly (readonly [Parameters<typeof judgmentLines>[1], string, string, string])[];
  edges: readonly (readonly [number, number])[];
  messages: readonly (readonly ['user' | 'assistant', string])[];
  editTip: string; nextPrompt: string;
}

// Authored demonstration material, never copied from a user's chats.
export const examples = [
  {
    id: 'product', name: '产品发布：先让一个人用起来', category: '产品决策',
    headline: '下次讨论，不再重开已经做过的决定。',
    situation: '昨天聊定位，今天聊功能，下周准备发布。你需要带走的，是决定、理由和仍未解决的问题。',
    scope: '记录个人记账工具的首版用户、核心流程与发布取舍；暂不讨论品牌配色和长期融资。',
    summary: '首版面向记账总是中断的自由职业者。先打通手工记一笔、按月看收支的完整过程；银行自动同步暂缓。下一步是找三位目标用户完成一次记账，观察卡在哪里。',
    sections: [
      ['服务谁', '访谈里反复出现的是“月底想不起来钱去了哪里”。首版先围绕自由职业者的收入不固定、支出分散这两个条件做。'],
      ['首版边界', '先验证有人愿意持续记账，再增加自动化。功能取舍围绕第一次记下并看懂一笔钱，而不是把所有账本能力做齐。'],
      ['下一次验证', '一次顺利的演示不等于持续使用。让用户独立完成一笔真实记录，并在几天后回来查看；记录他们是否还需要帮助。'],
    ],
    nodes: [
      ['◆', '服务谁', '先服务自由职业者', '收入不固定，账目分散。先在这个范围内寻找反复发生的困难。'],
      ['◆', '首版边界', '先完成一笔手工记账', '输入金额、选择类别、保存，然后立刻看见当月收支变化。'],
      ['⏸', '首版边界', '银行自动同步暂缓', '接入成本与权限问题会扩大首版范围，当前先观察手工流程是否有持续价值。'],
      ['◇', '下一次验证', '找三位用户独立试用', '不要替用户操作。记录第一次填写和回看时遇到的困难。'],
      ['？', '下一次验证', '隔几天还会回来吗？', '这仍是待验证的问题。首日体验和后续使用要分开判断。'],
      ['◆', '下一次验证', '按真实卡点调整下一版', '先修阻碍完成任务的问题，不因为功能清单不够长就加功能。'],
    ],
    edges: [[0,1],[1,2],[1,3],[3,4],[4,5]],
    messages: [
      ['user', '想给自由职业者做一个记账工具。大家收入不固定，有的人月底都不知道钱去了哪。自动导入银行账单是不是必须有？'],
      ['assistant', '可以先把手工记录到月度回顾做通。自动导入需要接入和权限，可能拉长首版；应先验证目标用户是否愿意持续记录。'],
      ['user', '那就先服务自由职业者，只做记一笔和看本月。银行同步放后面。找三个人独立用，别我替他点。还要看过几天会不会回来。'],
      ['user', '配色以后再选，融资也不是现在要讨论的。下一版按他们真正卡住的地方改。'],
    ],
    editTip: '在 Doc 里，把“三位目标用户”改成你自己的计划。再打开“交给下一场聊天”，看读取预览是否已经改变。',
    nextPrompt: '读取「产品发布：先让一个人用起来」，根据当前首版边界，帮我准备一次用户试用。不要把暂缓的银行同步重新列入首版。',
  },
  {
    id: 'writing', name: '文章：为什么远程协作总在开会', category: '文章写作',
    headline: '换一场聊天，文章的立场和材料仍然在。',
    situation: '你和 Agent 讨论了开头、删掉的论点和几个故事。第二天继续写，希望它接住你的取舍，而不是再给一份通用大纲。',
    scope: '围绕远程团队的会议负担写一篇经验文章。保留作者立场、具体场景、论证边界和未补齐的材料。',
    summary: '文章主张是让会议承担需要共同判断的部分，把状态汇报移到会前。开头用周一连续三场同步会的经历，正文解释为什么书面记录缺失会让同一问题反复讨论。不能把所有会议都说成浪费。',
    sections: [
      ['文章立场', '会议本身不是问题。信息没有提前写清楚，才会让一群人花时间补齐背景；真正存在分歧时，共同讨论仍有价值。'],
      ['叙事与证据', '从周一连开三场会、下午才开始实际工作的经历切入。后面用一次提前发出决策文档的协作经历说明改变，不把个人经验夸大成普遍结论。'],
      ['下一步写什么', '补充那次决策会的前后细节：会前发了什么，会上剩下哪些分歧，最后谁做决定。结尾给一个可以尝试的小动作。'],
    ],
    nodes: [
      ['◆','文章立场','会前先写清背景','将状态、约束和待决问题放在一页纸里，让参会者提前了解。'],
      ['◆','文章立场','把会留给共同判断','存在真实分歧时再一起讨论；别把共同阅读当成共同决策。'],
      ['◆','叙事与证据','从连续三场会写起','讲清当时发生了什么、为什么下午才开始工作，避免抽象地抱怨效率。'],
      ['✗','文章立场','删去“会议都是浪费”','这个判断超过材料能支持的范围，也会遮住需要面对面讨论的情形。'],
      ['？','叙事与证据','决策会前后细节待补','需要具体说明书面材料改变了什么，而不只说大家感觉更高效。'],
      ['◇','下一步写什么','从下一场会试一页纸','会前写背景和待决问题，会上只处理剩下的分歧。'],
    ],
    edges: [[2,0],[0,1],[1,5],[3,1],[4,5]],
    messages: [
      ['user','我想写远程协作，周一上午连续三场会，真正开始工作都下午了。最想说的是大家一直在补背景。'],
      ['assistant','可以用这个场景开头，再讨论会议是不是都应该取消。'],
      ['user','不对，我不是说会议都是浪费。有分歧还是得聊。我的观点是会前先把背景写清楚，把会议留给需要共同判断的部分。'],
      ['user','有一次我们先发决策文档，会上确实更聚焦，但细节我还要补。最后给读者一个小尝试：下次开会前写一页背景和问题。'],
    ],
    editTip: '打开 Doc，为“决策会前后细节”补一段自己的经历。修改会留在这个浏览器标签页，也会进入导出的脉络包。',
    nextPrompt: '读取「文章：为什么远程协作总在开会」，接着写开头。保留“会议用于共同判断”的立场，不要恢复已经删去的绝对化论点。',
  },
  {
    id: 'engineering', name: '技术方案：让上传失败后能继续', category: '技术方案',
    headline: '留下取舍和依据，不只留下一张结构图。',
    situation: '方案已经讨论过几轮：哪些条件必须保留，哪些替代方案暂缓，下一步要测什么。把这些带到下一场编码对话。',
    scope: '记录大文件上传的断点续传方案、约束和验证计划；不收录无关的界面配色与日常任务。',
    summary: '先沿用现有存储，实现分片上传和失败重试。服务端记录上传会话与已确认分片，客户端恢复时查询状态；完成操作必须幂等。当前不迁移存储服务，先验证断网、重复提交和过期清理。',
    sections: [
      ['恢复过程', '客户端只把服务端已确认的分片当作完成。重新打开页面时，先查询上传会话，再补传缺失部分，避免把本地进度当成最终状态。'],
      ['约束与取舍', '这一轮保留当前存储供应商，不把可靠上传和整套基础设施迁移绑在一起。上传会话要校验归属，完成请求可以安全重试。'],
      ['验证计划', '分别中断分片传输和完成请求，检查恢复后的文件一致性。再检查重复完成、失效会话与未完成分片的清理。'],
    ],
    nodes: [
      ['◆','恢复过程','以服务端确认进度为准','本地缓存用于体验，不能把尚未确认的分片算作完成。'],
      ['◆','恢复过程','只补传缺失的分片','通过上传会话查询已确认分片，恢复时不从头重传整个文件。'],
      ['◆','约束与取舍','完成请求必须幂等','重复请求不重复合并、不产生重复文件，返回同一次完成结果。'],
      ['⏸','约束与取舍','本轮不迁移存储服务','先在当前服务上验证完整恢复流程，避免把两项改造耦合。'],
      ['？','验证计划','断网后恢复是否一致？','需要检查恢复后的内容校验结果，而不只看进度条是否到达百分之百。'],
      ['◇','验证计划','补齐重复提交与过期测试','包含重复完成、越权访问上传会话和过期未完成分片清理。'],
    ],
    edges: [[0,1],[1,2],[1,3],[2,4],[4,5]],
    messages: [
      ['user','大文件上传中断之后现在只能重来。想做分片和续传，但这一轮别顺便换存储供应商。'],
      ['assistant','可以给每次上传分配会话，服务端记录确认的分片。客户端恢复时先查会话状态，再补传缺失分片。'],
      ['user','对，进度以服务端为准。另外完成请求可能重复，必须幂等。恢复后要检查文件一致性，不能只看进度条。'],
      ['user','再把断网、重复完成、会话归属和过期清理加到验证计划。页面配色暂时不讨论。'],
    ],
    editTip: '点开 Map 节点查看理由，再到 Doc 修改验证计划。下一场编码对话可按需读取这份方案。',
    nextPrompt: '读取「技术方案：让上传失败后能继续」，按照当前约束拆分实现任务。先验证断点恢复和幂等完成，本轮不迁移存储服务。',
  },
] as const;

export function getExamples(lang: ShowcaseLanguage): readonly Example[] { return lang === 'en' ? englishExamples : examples; }

export function exampleBundle(example: Example, lang: ShowcaseLanguage = 'zh') {
  const ledger = appendLines('', [
    `[场次 2026-09-18T08:00:00Z · ${lang === 'en' ? 'GFT Map authored example' : 'GFT Map 公开示例 · 人工编写'}]`,
    ...proseLines('p1', '主题', example.scope),
    ...proseLines('p2', lang === 'en' ? 'Main thread' : '主线', example.summary),
    ...example.sections.flatMap(([domain, text], i) => proseLines(`p${i + 3}`, domain, text)),
    ...example.nodes.flatMap(([mark, domain, title, body], i) => judgmentLines(`j${i + 6}`, mark, domain, title, body)),
    ...example.edges.map(([from, to]) => relationLine(`j${to + 6}`, `j${from + 6}`)),
  ]);
  const raw = appendSourceLog('', example.messages.map(([role, content], i) => ({
    v: 1 as const, provider: 'example', sessionId: `example-${example.id}`, id: `m${i + 1}`, role, content,
    title: `${example.category} · ${lang === 'en' ? 'Authored example discussion' : '人工编写的示例讨论'}`, ts: Date.UTC(2026, 8, 18, 8, i),
  })));
  return createTopicBundle(example.name, { ledger, raw });
}
