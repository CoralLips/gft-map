import { appendLines, judgmentLines, proseLines, relationLine } from '../../../src/service/ledger';
import { createTopicBundle } from '../../../src/service/topicBundle';
import { englishExamples } from './examples-en';
import type { ShowcaseLanguage } from './locale';

export interface Example {
  id: 'product' | 'writing' | 'engineering';
  name: string;
  category: string;
  headline: string;
  situation?: string;
  scope: string;
  summary: string;
  sections: readonly (readonly [string, string])[];
  nodes: readonly (readonly [Parameters<typeof judgmentLines>[1], string, string, string])[];
  edges: readonly (readonly [number, number])[];
  editTip: string;
  nextPrompt: string;
}

// Authored demonstration material, never copied from a user's chats.
export const examples = [
  {
    id: 'product',
    name: '记账工具的首版取舍',
    category: '产品决策',
    headline: '记账工具首版为何暂缓银行同步？',
    scope: '为自由职业者做一款记账工具，决定首版做哪些功能，以及怎样试用。',
    summary:
      '首版暂缓银行同步。对接银行接口要花开发时间，也需要用户授权读取流水。先观察自由职业者能否独立手工记一笔，过几天是否会回来查看当月收支。',
    sections: [
      [
        '服务谁',
        '这个示例里的自由职业者收入不固定，支出分散，月底常想不起来钱去了哪里。',
      ],
      [
        '首版边界',
        '首版保留手工记账和月度收支。等有人愿意持续记账，再考虑用银行同步省去录入。',
      ],
      [
        '下一次验证',
        '请自由职业者自己记下一笔真实收支，记下他们在哪一步需要帮助。过几天再看，他们有没有回来查看这笔记录。',
      ],
    ],
    nodes: [
      [
        '◆',
        '服务谁',
        '先服务自由职业者',
        '收入不固定，账目分散。先在这个范围内寻找反复发生的困难。',
      ],
      [
        '◆',
        '首版边界',
        '先完成一笔手工记账',
        '输入金额、选择类别、保存，然后立刻看见当月收支变化。',
      ],
      [
        '◆',
        '首版边界',
        '银行自动同步暂缓',
        '同步流水要花时间对接银行接口，还要请用户授权访问账户。先让自由职业者手工记一笔，看看哪里需要帮助，过几天是否还会回来查账。',
      ],
      [
        '◇',
        '下一次验证',
        '观察第一次独立记账',
        '让自由职业者自己填写一笔真实收支，记录哪里需要帮助。',
      ],
      [
        '？',
        '下一次验证',
        '隔几天还会回来吗？',
        '这仍是待验证的问题。首日体验和后续使用要分开判断。',
      ],
      [
        '◆',
        '下一次验证',
        '按真实卡点调整下一版',
        '先修阻碍完成任务的问题，不因为功能清单不够长就加功能。',
      ],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [3, 4],
      [4, 5],
    ],
    editTip: '在 Doc 的“下一次验证”里改一下试用安排，再打开“交给下一场聊天”查看当前正文。',
    nextPrompt:
      '读取「记账工具的首版取舍」，帮我准备一场自由职业者记账试用。列出第一次记账时要观察什么，以及过几天要回看什么。',
  },
  {
    id: 'writing',
    name: '文章：为什么远程协作总在开会',
    category: '文章写作',
    headline: '换一场聊天，文章的立场和材料仍然在。',
    situation:
      '你和 Agent 讨论了开头、删掉的论点和几个故事。第二天继续写，希望它接住你的取舍，而不是再给一份通用大纲。',
    scope: '围绕远程团队的会议负担写一篇经验文章。保留作者立场、具体场景、论证边界和未补齐的材料。',
    summary:
      '文章主张是让会议承担需要共同判断的部分，把状态汇报移到会前。开头用周一连续三场同步会的经历，正文解释为什么书面记录缺失会让同一问题反复讨论。不能把所有会议都说成浪费。',
    sections: [
      [
        '文章立场',
        '会议本身不是问题。信息没有提前写清楚，才会让一群人花时间补齐背景；真正存在分歧时，共同讨论仍有价值。',
      ],
      [
        '叙事与证据',
        '从周一连开三场会、下午才开始实际工作的经历切入。后面用一次提前发出决策文档的协作经历说明改变，不把个人经验夸大成普遍结论。',
      ],
      [
        '下一步写什么',
        '补充那次决策会的前后细节：会前发了什么，会上剩下哪些分歧，最后谁做决定。结尾给一个可以尝试的小动作。',
      ],
    ],
    nodes: [
      ['◆', '文章立场', '会前先写清背景', '将状态、约束和待决问题放在一页纸里，让参会者提前了解。'],
      ['◆', '文章立场', '把会留给共同判断', '存在真实分歧时再一起讨论；别把共同阅读当成共同决策。'],
      [
        '◆',
        '叙事与证据',
        '从连续三场会写起',
        '讲清当时发生了什么、为什么下午才开始工作，避免抽象地抱怨效率。',
      ],
      [
        '✗',
        '文章立场',
        '删去“会议都是浪费”',
        '这个判断超过材料能支持的范围，也会遮住需要面对面讨论的情形。',
      ],
      [
        '？',
        '叙事与证据',
        '决策会前后细节待补',
        '需要具体说明书面材料改变了什么，而不只说大家感觉更高效。',
      ],
      ['◇', '下一步写什么', '从下一场会试一页纸', '会前写背景和待决问题，会上只处理剩下的分歧。'],
    ],
    edges: [
      [2, 0],
      [0, 1],
      [1, 5],
      [3, 1],
      [4, 5],
    ],
    editTip:
      '打开 Doc，为“决策会前后细节”补一段自己的经历。修改会留在这个浏览器标签页，也会进入导出的脉络包。',
    nextPrompt:
      '读取「文章：为什么远程协作总在开会」，接着写开头。保留“会议用于共同判断”的立场，不要恢复已经删去的绝对化论点。',
  },
  {
    id: 'engineering',
    name: '技术方案：让上传失败后能继续',
    category: '技术方案',
    headline: '留下取舍和依据，不只留下一张结构图。',
    situation:
      '方案已经讨论过几轮：哪些条件必须保留，哪些替代方案暂缓，下一步要测什么。把这些带到下一场编码对话。',
    scope: '记录大文件上传的断点续传方案、约束和验证计划；不收录无关的界面配色与日常任务。',
    summary:
      '先沿用现有存储，实现分片上传和失败重试。服务端记录上传会话与已确认分片，客户端恢复时查询状态；完成操作必须幂等。当前不迁移存储服务，先验证断网、重复提交和过期清理。',
    sections: [
      [
        '恢复过程',
        '客户端只把服务端已确认的分片当作完成。重新打开页面时，先查询上传会话，再补传缺失部分，避免把本地进度当成最终状态。',
      ],
      [
        '约束与取舍',
        '这一轮保留当前存储供应商，不把可靠上传和整套基础设施迁移绑在一起。上传会话要校验归属，完成请求可以安全重试。',
      ],
      [
        '验证计划',
        '分别中断分片传输和完成请求，检查恢复后的文件一致性。再检查重复完成、失效会话与未完成分片的清理。',
      ],
    ],
    nodes: [
      ['◆', '恢复过程', '以服务端确认进度为准', '本地缓存用于体验，不能把尚未确认的分片算作完成。'],
      [
        '◆',
        '恢复过程',
        '只补传缺失的分片',
        '通过上传会话查询已确认分片，恢复时不从头重传整个文件。',
      ],
      [
        '◆',
        '约束与取舍',
        '完成请求必须幂等',
        '重复请求不重复合并、不产生重复文件，返回同一次完成结果。',
      ],
      [
        '⏸',
        '约束与取舍',
        '本轮不迁移存储服务',
        '先在当前服务上验证完整恢复流程，避免把两项改造耦合。',
      ],
      [
        '？',
        '验证计划',
        '断网后恢复是否一致？',
        '需要检查恢复后的内容校验结果，而不只看进度条是否到达百分之百。',
      ],
      [
        '◇',
        '验证计划',
        '补齐重复提交与过期测试',
        '包含重复完成、越权访问上传会话和过期未完成分片清理。',
      ],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [4, 5],
    ],
    editTip: '点开 Map 节点查看理由，再到 Doc 修改验证计划。下一场编码对话可按需读取这份方案。',
    nextPrompt:
      '读取「技术方案：让上传失败后能继续」，按照当前约束拆分实现任务。先验证断点恢复和幂等完成，本轮不迁移存储服务。',
  },
] as const;

export function getExamples(lang: ShowcaseLanguage): readonly Example[] {
  return lang === 'en' ? englishExamples : examples;
}

export function exampleBundle(example: Example, lang: ShowcaseLanguage = 'zh') {
  const nodeId = (i: number) => `j${i + 6}`;
  // 每章正文之后引用本章判断（D61）：Doc 在这里显示节点的标题与概述，与 Map 同一份文字。
  const chapter = (domain: string, text: string) => {
    const refs = example.nodes.flatMap(([, d], i) => (d === domain ? [`> ^${nodeId(i)}`] : []));
    return refs.length ? `${text}\n\n${refs.join('\n\n')}` : text;
  };
  const ledger = appendLines('', [
    `[场次 2026-09-18T08:00:00Z · ${lang === 'en' ? 'GFT-Map authored example' : 'GFT-Map 公开示例 · 人工编写'}]`,
    ...proseLines('p1', '主题', example.scope),
    ...proseLines('p2', lang === 'en' ? 'Main thread' : '主线', example.summary),
    ...example.sections.flatMap(([domain, text], i) => proseLines(`p${i + 3}`, domain, chapter(domain, text))),
    ...example.nodes.flatMap(([mark, domain, title, body], i) =>
      judgmentLines(nodeId(i), mark, domain, title, body),
    ),
    ...example.edges.map(([from, to]) => relationLine(nodeId(to), nodeId(from))),
  ]);
  return createTopicBundle(example.name, { ledger });
}
