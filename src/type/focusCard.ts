/** 思维判断的共享数据形状；不依赖数据库或会话服务。 */
// ===== FocusCard =====

/**
 * 节点笔记：thought 上累积的金句（追加式时间线）
 * 保留历史 AI 来源与用户手动添加的记录。
 * 不和 commits 绑定 — notes 是跨版本的金句池
 */
export interface FocusCardNote {
  id: string;
  text: string;
  createdAt: number;
  source: 'ai' | 'user';
}

/**
 * Commit：thought body 的不可变快照（git for thought 的核心）
 * 用户主动 commit 时入链；切换 HEAD 时显示对应版本的 body
 */
export interface Commit {
  id: string;
  message: string;            // 一句话总结这次提交改了什么
  body: string;               // 这次的 body 快照
  timestamp: number;
  parentCommitId: string | null;  // 链式：上一个 commit
  author: 'user' | 'ai';
}

export interface FocusCard {
  id: string;
  /** 所属项目 id（migration 028 后：DB focus_cards.project_id = 原 explore_id 的值） */
  projectId: string;
  title: string;
  body: string;
  isDone: boolean;
  order: number;
  relatedIds: string[];
  /** 金句池（时间顺序累积，跨版本）*/
  notes: FocusCardNote[];
  /** Commit 链（追加式，不可变）*/
  commits: Commit[];
  /** 当前 HEAD 指向的 commit id（null = 还没 commit）*/
  headCommitId: string | null;
  createdAt: number;
  updatedAt: number;
  // ===== 压缩塔（思维脉络收拢）——两个可选字段，树/仓库场景不受影响 =====
  /** 收拢产物（L2 判断）：由哪些下层节点收成——塔的层间索引，下钻靠它 */
  constituents?: string[];
  /** 被收进了哪个上层判断（非空 = 已收拢，图面隐藏；数据无损，拆开即回） */
  condensedInto?: string;
  /** 未读红点（增量更新新长出来的、还没被点开看过的节点）——单击节点即清；跟 nodes jsonb 落库，刷新不丢 */
  unread?: boolean;
  /** 节点来源：'agent' = 外部 agent（Claude Code 等）经 MCP 写入；缺省 = GFT 站内产生 */
  source?: 'agent';
  /** 子问题域短名（live 蒸馏产出，进度大纲树按它分组）——跟 nodes jsonb 落库；groupMap 是它的内存索引 */
  group?: string;
  /** 白盒文档条目锚（如 "j3"，对应文档 ^j3）——图为投影的外键；随 nodes jsonb 落库 */
  anchor?: string;
  /** 未解标（用户确认"这是个没解决的问题"）——挂?、进"未解之谜"集合；瞬态层建议确认后的永久态，落库 */
  unresolved?: boolean;
  /** 被推翻留痕（用户确认"这个判断被后面否定了"）——灰显不删；瞬态层建议确认后的永久态，落库 */
  superseded?: boolean;
  /** AI 推进提议（2026-08-05，随 nodes jsonb 落库）——语义与瞬态建议层相反：**默认保留**，
   *  手动 × 撤 / 编辑即转正（沉默认可，与收拢同一哲学）。
   *  challenge=质疑这个已有节点（虚化?，收下→unresolved）/ add=AI 补充的新节点（虚线，转正→常规） */
  proposal?: { kind: 'challenge' | 'add'; reason: string };
}
