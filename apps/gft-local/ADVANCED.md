# GFT Map 高级配置与原理

把一个主题的判断留在本机，让下一场 Agent 对话继续使用。Doc 解释当前理解，Map 展示判断与关系；两者共用一份记录，可以直接查看和修改。

需要 Node.js 20 或更高版本。数据默认保存在 `~/.gft-local/`，与安装目录分开；可通过环境变量 `GFT_LOCAL_HOME` 指定其他目录。页面、CLI 和 Skill 应使用同一数据目录。

<a id="installation"></a>

## 安装与启动

从 GitHub 安装的命令见 [README](https://github.com/CoralLips/gft-map#开始使用)。安装工具需要 Node.js 22.20+；手动安装完整 Release 包支持 Node.js 20+。只安装聊天桌面客户端，不一定具备页面 AI 操作所需的 CLI；还需安装并登录相应 CLI。

| 能力 | 支持情况 |
|---|---|
| 本地面板、Doc／Map 编辑、文件迁移 | 可用，无需 GFT 登录。 |
| Codex 页面 AI 操作 | 已完成真实任务验收，使用临时 CLI 任务。 |
| Codex／Claude Code 聊天来源 | 可选择具体会话，按各自进度收录增量。 |
| Claude Code 页面 AI 操作 | 需配置 Claude ACP，真实生成与跨客户端续接仍待完整验收。 |
| MCP 原生连接表单 | 可选，是否显示取决于客户端；也可使用网页入口。 |

读取聊天来源和执行模型分别配置。例如，可用 Codex 执行器处理选定的 Claude Code 聊天。支持 ACP 不代表已经适配所有 Agent 的聊天历史。

### 手动安装

从 [Releases](https://github.com/CoralLips/gft-map/releases/latest) 下载 `gft-map-版本.tar.gz`，解压后把完整的 `gft-map` 目录放到技能目录。目录内应直接有 `SKILL.md` 和 `scripts/`，不能只复制 `SKILL.md`，也不要多套一层目录。包内已包含运行依赖，无需 `npm install`，不会自动修改 Agent 配置。GitHub 附带的 **Source code** 用于源码开发。

| Agent | 用户级技能目录 |
|---|---|
| Codex | `~/.agents/skills/gft-map/` |
| Claude Code | `~/.claude/skills/gft-map/` |

`~` 是用户主目录；Windows 通常为 `C:\Users\你的用户名`。安装后刷新技能列表或重新打开 Agent 对话。路径说明参见 [Codex 官方文档](https://learn.chatgpt.com/docs/build-skills)与 [Claude Code 官方文档](https://code.claude.com/docs/en/skills)。

### 安装后的使用

在 Agent 中要求使用 `gft-map`，通过确认选项连接指定主题。每场对话可以连接多个主题，并按主题分别记录收录进度。页面和聊天使用同一组连接；断开不会删除主题内容。

下一场对话重新读取同一主题，即可得到当前判断、状态和关系。历史默认不进入上下文；需要追溯时再读取。页面中的修改会影响下一次读取，已经装入其他对话的上下文不会自动重写。

首次生成有效图文时，会在同一次请求中生成简短名称，仅替换默认的“新脉络”；手动名称保持不变。页面标题和发行包使用 GFT Map；内部 `apps/gft-local` 路径、`~/.gft-local` 数据目录及 `gft_local_*` 工具名保留兼容。

默认通过 Skill／MCP 查看本场连接的主题索引，再按需读取正文。不安装通知 Hook，不主动唤醒原聊天；右侧修改后，下次读取获得最新内容。

## 打开本地页面

在已解压的技能目录中运行：

```text
node scripts/cli.mjs serve --port 4317
```

打开 `http://127.0.0.1:4317`。默认模式支持查看、编辑、导入和导出；模型任务可由当前 Agent 通过 Skill 的 CLI 完成。页面中的模型操作需要启用执行器，默认页面不会唤醒当前 Agent 对话。

本机已安装并登录 Codex CLI 时，用 `node scripts/cli.mjs serve --port 4317 --agent codex` 启用页面 AI 操作。Claude 的页面执行配置见下一节。自行启动时保留终端，按 Ctrl+C 停止；服务停止后不能使用面板，但已保存内容仍会保留。

## ACP 执行器

ACP 是本工具与 Agent 交换任务、输出和取消请求的协议。可选择 Codex ACP 或 Claude ACP；相应适配器和认证需在本机准备好，GFT 不会替你安装或改变登录配置。SDK 已随 Skill 打包，适配器本体独立安装。

```text
node scripts/cli.mjs doctor --agent codex-acp
node scripts/cli.mjs serve --port 4317 --agent codex-acp
```

Claude 使用 `--agent claude-acp`。默认查找 `codex-acp` 或 `claude-agent-acp`；适配器安装方式见 [Codex ACP](https://github.com/agentclientprotocol/codex-acp) 与 [Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp) 的官方说明。产品支持 Node.js 20；Claude ACP 0.78.0 适配器自身要求 Node.js 22 或更高版本，适配器要求应单独满足。

当前真实验收覆盖 Codex ACP 1.12.0 的页面整理、保存和中止。Claude ACP 0.78.0 已完成握手与合成协议回放，真实生成被本机既有登录过期阻塞，尚未完成生成验收；握手成功不能替代认证及任务成功。

Windows 不通过 `.cmd` 或 shell 字符串启动。可以指定原生可执行文件，或用 Node 的绝对路径加适配器的 JavaScript 入口：

```text
node scripts/cli.mjs doctor --agent codex-acp --acp-bin "C:/Program Files/nodejs/node.exe" --acp-arg "D:/adapters/codex-acp/dist/index.js"
```

上面的入口是写法示例，以所装适配器 `package.json` 的 `bin` 字段为准；同一组参数也传给 `serve`。每个额外参数单独重复 `--acp-arg`，不把整段命令放进一个字符串。也可使用 `GFT_CODEX_ACP_BIN` 与 `GFT_CODEX_ACP_ARGS`，Claude 对应 `GFT_CLAUDE_ACP_BIN` / `GFT_CLAUDE_ACP_ARGS`；`_ARGS` 是 JSON 字符串数组。`--model` 请求适配器选择支持的模型。

ACP 负责执行一次更新、整理或重画任务。读取已有聊天由另外的 Codex / Claude Code 来源适配器负责；支持 ACP 不代表支持所有 Agent 的聊天历史。

## 连接聊天与增量更新

页面点“连接”，或在未绑定时点“更新”，可搜索实际会话，选择一个或多个主题，并确认“从现在开始”或“包含已有聊天”。会话标题只用于显示，绑定使用实际会话 ID。确认后页面显示“已连接”；读取接口返回主题后记录“聊天最近读取”的版本，这不证明模型已经采用其中的判断。

绑定后点“更新”，会读取该会话尚未收录的用户与助手消息，再交给本地执行器按主题筛选。多个来源时会要求选择，不会猜测当前打开的是哪场聊天。页面一次操作连续处理多批，固定到点击时已结束的会话末尾，显示批次和消息数并可取消；之后新产生的消息留给下次更新。“从现在开始”跳过已结束的历史，当前轮次留待结束后收录。每个主题保留独立进度。

材料超过一批或单批超过两万字符时，先逐批按主题提炼，提炼笔记最多一万字符；最后才汇总为一版 Doc／Map，中间碎片不铺到页面。成稿目标是少量关键判断（通常 8–16 条）和按问题解释的正文，不按发言数建节点。提炼进度每批成功后保存，取消或失败可从该处继续；正式收录水位与图文在成稿时一起提交。原消息留作来源回查。修改主题范围后不能继续沿用旧范围的提炼，可恢复原范围或断开重连后重新导入。少量日常增量仍直接更新；无新增不调用模型。CLI／MCP 的普通单批更新保持兼容，已有提炼进度可以续接。

Agent 可先通过 `gft_local_connections` 查看本场所连主题的轻量索引（ID、名称、范围、版本），再按需要用 `gft_local_read` 加载指定主题。索引不带正文或聊天历史，查看索引不标记主题已读。网页更新只存回，不自动向原聊天注入记忆。

Codex 使用本地 app-server 的只读会话接口；如找不到原生程序，可设置 `GFT_CODEX_BIN`。Claude Code 使用官方 SDK 的会话读取函数。搜索列出会话元数据，读取正文仅针对选中的会话；Claude SDK 可能在本地解析这一个会话文件，不会把所有会话发给模型。

聊天内的原生确认表单由附带的 MCP 服务提供。先保持本地页面服务运行，再生成配置：

```text
node scripts/cli.mjs mcp-config
```

把输出中的 `gft-local` 服务添加到所用 Agent 的 MCP 设置；Codex 的配置格式由其客户端转换或手工录入。不要替换已有的云端 GFT 服务。Skill 指导 Agent 调用连接、读取、断开、更新及查询结果。支持 MCP 表单的客户端会显示原生选项；不支持时使用页面确认，不会静默建立连接。具体见 [连接说明](skill/references/connections.md)。

页面不能自动唤醒原来的聊天，所以只在页面绑定时，原聊天尚未读取主题。回到 Agent 说“读取已连接的主题”才会返回记忆。已进入聊天的文字也不能通过断开撤回。连接管理窗口保留最近读取版本，标签不显示已读指示灯。

不使用 MCP 时，Skill 可以在宿主完成确认后调用 CLI 的 `connect` / `read-connected` / `update-connected`，通过同一个本地服务处理。用 `task-status --id TASK_ID --remote` 查询服务中的任务状态，避免读到另一个数据目录。

## Codex 临时执行（本机使用 Codex 时推荐）

若本机已安装并登录 Codex CLI，先检查，再启动：

```text
node scripts/cli.mjs doctor
node scripts/cli.mjs serve --port 4317 --agent codex
```

它使用现有登录和账户额度，另起一个临时 Codex CLI 进程。`--ephemeral` 不保存聊天记录；本次调用的 `model_instructions_file` 只包含 GFT 图文处理要求，替换默认编程任务说明。忽略用户配置、仓库规则和记忆，关闭工具、插件与派生任务，不经过 ACP 适配器的自动标题生成。临时说明文件在任务退出后清理，不修改用户的全局配置。默认通过 Codex 的只读模型列表获取当前默认模型和思考强度，每次新任务重新解析，不会跟随另一个聊天输入框。命令行 `--model MODEL` 保留作显式诊断覆盖，旧 `GFT_CODEX_MODEL` 环境变量不再固定页面默认值。原生程序路径使用 `GFT_CODEX_BIN`。

ACP v1 使用 `session/new` 与 `session/prompt`，没有统一的无会话单次推理接口，也没有各家通用的临时会话或关闭标题开关。因此保留 ACP 兼容入口，对已提供官方临时执行接口的 Codex 使用上述较轻路径。Skill 提供指令和工具入口，本身不是模型推理服务。

参考：[Codex 非交互与临时执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[单次调用说明文件](https://learn.chatgpt.com/docs/config-file/config-reference)、[ACP v1 会话](https://agentclientprotocol.com/protocol/v1/session-setup)。

两种执行路径都另起任务进程，不是当前聊天的后台续接，不保证一次任务只发生一次模型请求。页面会显示任务进度与失败原因。关闭页面、切换主题或取消操作会尝试中止页面任务；后台服务仍在运行时，异常断开由执行超时兜底，默认 900 秒，可用 `--timeout-seconds` 调整。正常停止服务会结束它负责的任务；若强杀后台服务，应检查遗留的适配器和 Agent 子进程，`recover` 只修复本地记录状态。失败或旧版本结果不会覆盖已经保存的内容。

共享右栏的“整理”最多运行三轮，每轮是独立处理，达到目标或不再改善就停止；一次点击的总开销可能是多轮之和。这是原有收拢逻辑，与是否经过 ACP 无关。执行记录分别保存每轮实际耗时、用量及工具调用数，不能把单轮实测当作所有点击的固定开销。

数据文件和服务留在本机；登录 GFT 后，脉络内容自动双向同步到该账号。选择联网 Agent 时，任务所需内容会交给该 Agent 的模型服务；图文处理不调用 GFT 云端生成 API。

## 编辑与迁移

- 点击“新建脉络”直接得到空脉络，可马上重命名、编辑。首次更新选择来源后直接生成主题和图文，不要求先选范围；已有主题沿用。主题仍在 Doc 顶部，与正文连续排版、一起滚动，只用浅分隔线区分。“主题 · 收录范围”和分隔线固定保留；点击规则文字原位编辑，失焦或 Ctrl+S 保存。正文编辑不会改变主题。
- Doc 编辑中的草稿不被后台刷新提交或改写；失焦、Ctrl+S、切换和离开页面时保存。共享编辑器在平台和本地采用相同保存边界。
- 原 AI 记忆位置显示圆角会话标签；标题单行省略，点击管理连接，× 断开并保留主题内容。标签没有已读指示灯；管理窗口可查看实际读取版本，但读取记录不代表 Agent 已采用内容。
- 会话候选全部保留，长标题单行省略；绑定和增量进度仍使用完整会话 ID，与显示截断无关。
- Doc 与 Map 共用判断正文、五档状态和关系。编辑先在界面反馈，再异步保存；保存失败会保留草稿。
- 更新收录新材料；整理当前主题的表述、手写文稿与现有判断；重画按当前主题重新筛选这份脉络保存的原始消息与 Log。长来源先提炼再成稿，不扫描其他会话、不重置增量水位。旧备份若没有来源快照，只能使用已有 Log，无法恢复从未保存的信息。
- Log 保存已经接收的来源。“完整脉络包 .json”导出当前单个主题的名称、范围、Doc／Map 和 Log；导入建立新主题，不覆盖现有主题，也不带入浏览器草稿、会话绑定或增量进度。
- 本地与 GFT 平台共用 `gft-theme` 格式，支持 v1/v2/v3；自由编辑过的 Log 使用 v3，旧客户端会拒绝导入。单个包上限 4 MB，超过时明确报错，不截断来源。导出菜单的“复制”提供当前 Doc，“下载”提供完整迁移文件。
- Log 可在设置中整篇编辑、复制全部；失焦或 Ctrl+S 保存。保存改变底层来源，Doc／Map 不会立即重新生成；点击重画后使用修改后的 Log。后续更新只追加未收录的新消息。

安装目录与数据目录分开，升级安装包不会替换 `~/.gft-local/` 中的数据。页面和 Skill 必须使用同一个数据目录；升级前可下载重要脉络作为备份。下载文件不包含账号凭证、聊天连接或读取进度，导入后需重新连接那台电脑上的聊天。

可以在[在线示例](https://corallips.github.io/gft-map/demo.html?case=product&step=transfer)中试一次下载、导入，或把[产品讨论示例](https://corallips.github.io/gft-map/examples/product.gft.json)导入本地面板。

使用联网执行器时，任务所需材料会发送给该执行器的模型服务，并使用它的额度；本地存储不代表模型离线运行。默认模型与思考强度来自执行器配置，不跟随另一场聊天输入框。

<a id="account"></a>

## GFT 账号（可选）

在设置中选择“GFT 账号”，打开 GFT 网页完成授权。登录后自动双向同步名称、主题、Doc／Map 和 Log，包括已有本地脉络；未登录也能使用全部本地功能。退出停止后台同步，保留本地文件。授权回调使用短时、一次性随机校验，本地保存独立登录凭证。

后台约每 10 秒检查版本，本地保存后也会触发检查；本地操作不等待云端。网络失败保留修改并自动重试。已同步脉络在登录状态下删除，会同步删除另一端；退出后删除不补发删除操作，再次登录会下载仍在云端的副本。并发修改或修改与删除相撞时，保存冲突副本，避免静默覆盖。

每条脉络记住首次同步账号。换账号不自动上传前一个账号的副本；明确跨账号搬运请下载后重新导入。聊天连接与读取水位归本机，不参与云同步。同步不会调用模型，也不会唤醒左边的聊天。

自托管 GFT 须先部署 `071_map_sync.sql` 及支持自由编辑 Log 的新版平台，再启用本地同步。接口缺失会在账号窗口显示错误，本地内容仍可用。同步使用当前账号的 RLS 权限；删除回执保存在 `map_sync_deletions`，内容继续使用现有 `projects` / `thinking_maps`。

默认授权站点为 `https://gitforthought.com`。自托管站点可以设置 `GFT_WEB_URL`，须支持 `/connect-agent` 和 `/api/agent-config`。开发时允许本机 HTTP；其他地址须使用 HTTPS。真实账号授权需在自己的浏览器确认，本项目回归测试只使用合成凭证。

强制退出后若存在遗留锁或运行状态，先关闭旧服务，再运行 `node scripts/cli.mjs recover`。恢复只回收能够确认原进程已退出的锁；失败任务不会自动调用模型重试。

## 开发与贡献

源码运行、目录结构、测试、打包和贡献流程见 [开发与贡献](CONTRIBUTING.md)。
