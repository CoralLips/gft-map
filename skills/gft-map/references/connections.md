# 本地连接器

本地服务、页面、CLI 与 MCP 使用同一份绑定和主题数据。MCP 只与已启动的本地 HTTP 服务通信；不含自己的模型密钥，也不会把页面里的主题当作原聊天已读过的内容。

先运行所选本地执行器，再启动 MCP。生成宿主配置：

```text
node scripts/cli.mjs mcp-config
```

返回 `mcpServers.gft-local`：Node 可执行路径、当前发行包 CLI 的绝对路径及本地服务地址。Claude Code 可使用这一 MCP 配置；Codex 可把相同 command/args/env 配入本地 MCP。不要覆盖既有 `gft` 远端连接。不同端口先设置 `GFT_LOCAL_URL=http://127.0.0.1:端口`。

MCP 启动入口是 `node scripts/cli.mjs mcp`，stdout 仅用于协议。无依赖目录的发行包已经包含所需 SDK。

连接工具通过 MCP form elicitation 显示主题多选和历史范围。客户端未声明支持时，不保存连接，返回页面选择入口。表单的样式由客户端决定。第一次配置后，宿主通常需要重新加载 MCP；配置文件存在不代表当前聊天已加载工具。

聊天里使用：连接 → 确认 → 返回本场主题索引 → Agent 按需读取指定主题内容；断开 → 选择主题 → 确认。页面里使用：更新 → 若未连接先选实际对话 → 确认 → 读取增量。页面连接不会唤醒原聊天；原聊天下次调用 `gft_local_read` 后才记录最近读取版本。

页面一次更新固定到操作开始时的会话末尾，内部有输入大小边界并自动继续下一批，可随时取消。已成功批次保存水位，失败批次不推进。CLI／MCP 的单批调用仍按返回的 hasMore 决定是否继续。失败、取消、历史被重写或原会话不可读时，保留现有 Doc／Map 并说明原因，不能默默全量重读。

读取必须传 `provider` 与当前真实 `sessionId`，不能沿用其他会话的编号。`gft_local_connections` 返回轻索引；`gft_local_read` 必须指定其中一个 `topicId`，默认返回 Doc 与不含重复正文的图结构。可另带 `nodeIds` 回查所选节点。`gft_local_sources` 以同样身份和主题按页回查 Log，使用返回的 `nextCursor` 继续。节点详情和来源回查均不点亮整份 Doc 的已读灯。

安装验收：重新加载宿主工具后确认能发现 `gft_local_connections`、`gft_local_read` 和 `gft_local_sources`；索引为空就报告未连接。连接并读取测试主题后，在页面修改它，再次读取应返回新版本。不要用别场会话的绑定冒充本场验收，也不要把包已生成当成宿主已发现 Skill。
