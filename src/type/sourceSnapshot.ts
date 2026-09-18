/** 思维判断的来源快照；仅描述数据，不读取平台存储。 */
// ===== 收拢事件（append-only 存证：一行 = 一次收拢吃了什么、产出了谁）=====

/** L0 消息段快照里的一条消息（生成那一刻的输入，chat 删除后塔基仍完整） */
export interface SnapshotMessage {
  id: string;
  role: string;
  name: string | null;
  content: string;
  ts: number;
}

export interface CondensationEvent {
  /** 'L0->L1' = 更新脉络（对话→节点）；'L1->L2' = 收拢（节点→上层判断） */
  layer: 'L0->L1' | 'L1->L2';
  /** 跨域输入（L0 消息段）存快照原文；塔内输入（L1 节点）只存 id 指针——与图同生共死永不失效 */
  inputs: SnapshotMessage[] | { nodeIds: string[] };
  /** 本次产出的节点 id */
  outputs: string[];
  /** 来源弱引用：原对话还在可跳回，删了读 inputs 快照（塔内事件无此项） */
  sourceMeta: { sessionId: string; sessionTitle: string; fromId: string; toId: string; count: number } | null;
}

/** 导出用：每个 batch 的原始出处（该批产出了哪些节点 + 当时的对话原文 + 来源标题） */
export interface SourceBatch {
  sessionId?: string;
  nodeIds: string[];
  sessionTitle: string;
  messages: SnapshotMessage[];
}
