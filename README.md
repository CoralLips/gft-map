# GFT Map

## 把聊过的事，接着做下去。

昨天和 Agent 确定了首版边界，今天换一场聊天，它又建议把暂缓的功能加回来。写文章时删掉的论点，第二天又出现在大纲里。方案讨论了几轮，接着编码时，却得重新解释为什么这么选。

**GFT Map 把这些决定、理由和未解问题，整理成一份你能看懂、能纠正、能带走的上下文。** 下一场 Agent 对话可以按需读取，继续同一件事。

[打开介绍与样例](https://corallips.github.io/gft-map/) · [直接试用](https://corallips.github.io/gft-map/demo.html?case=product) · [安装到本地](#第一次使用) · [下载安装包](https://github.com/CoralLips/gft-map/releases/latest)

[![GFT Map 实际面板操作：查看地图、编辑文稿、预览读取内容，再导出带走](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/walkthrough.gif)](https://corallips.github.io/gft-map/demo.html?case=product)

*点击动图打开可编辑示例。这里使用本地版同一套图文组件；无需安装，也不连接你的聊天或模型。*

### 先打开一件你熟悉的事

| 产品决策 | 文章写作 | 技术方案 |
|---|---|---|
| [![产品决策的思维脉络](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.png)](https://corallips.github.io/gft-map/demo.html?case=product) | [![文章写作的可编辑文稿](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/writing.png)](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [![技术方案的约束与验证计划](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/engineering.png)](https://corallips.github.io/gft-map/demo.html?case=engineering) |
| **为什么首版不做银行同步？** 保留用户、首版边界与暂缓理由，下次讨论功能时不从头再来。 | **别再把删掉的论点写回来。** 作者立场、删去的观点、待补的经历一起交给下一场写作。 | **下一场编码，还记得这些约束吗？** 留下断点续传、幂等要求和待做测试，让实现接住方案。 |
| [打开产品讨论 →](https://corallips.github.io/gft-map/demo.html?case=product) | [打开文稿，试着改 →](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [查看方案与依据 →](https://corallips.github.io/gft-map/demo.html?case=engineering) |

这些案例是人工编写的示例材料，不是真实用户聊天，也不是模型效果评测。你可以编辑、查看来源、导出再导入；在线的“读取预览”展示当前内容，不会伪装成一场真实 Agent 回答。AI 更新、整理和重画在安装后的本地版执行。

GFT Map 在本机运行，开源且无需 GFT 账号。它复用 [Git for Thought](https://gitforthought.com) 的图文编辑与整理能力；这个仓库提供完整本地产品源码，Skill 是其中一种安装方式。

## 第一次使用

**先用自己的一场短对话，完成“生成 → 修正 → 下一场聊天接着用”。**下面集中走已做真实任务验收的 Codex 路线。准备好 **Node.js 22.20+** 和已经登录的 **Codex CLI**；只安装聊天客户端不一定具备 CLI。模型操作使用 Codex 现有账号的额度，并将本次任务所需材料发送给其模型服务。

### 1. 安装，并让 Agent 启动面板

通过 [skills 安装工具](https://github.com/vercel-labs/skills) 从 GitHub 安装到 Codex：

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent codex --global
```

安装后刷新技能列表或重新打开 Codex 会话，把下面这段话发给它：

> 使用 gft-map，检查本地运行环境，用 Codex 执行器启动面板，启用页面的更新、整理和重画功能。我想用一场已有讨论生成主题上下文。请确认服务已启动，并给我打开地址。

Agent 会检查环境并启动本地服务。成功后打开它返回的地址，默认是 **http://127.0.0.1:4317/**。服务运行期间才能使用面板；关闭服务不会删除已保存的内容。

### 2. 用自己的讨论生成，再修正

1. 在页面新建脉络，点 **更新**。
2. 选择一场已有几轮讨论的短对话，选 **包含已有内容** 并确认。这样第一次就有材料可生成。若选 **从现在开始**，需先在那场聊天完成新一轮，再回来更新；没有新材料时不会生成内容。
3. 等任务完成，在 Doc 阅读，在 Map 查看；首次会自动生成主题范围和名称。
4. 有不准确的地方，直接修改。之后点击更新，只接收尚未收录的消息；没有新增就不调用模型。

例如把一项“已确定”的判断改成“待验证”，或补上一个遗漏的约束；编辑后按 **Ctrl+S** 保存。想调整收录方向，可以改 Doc 顶部的主题范围，再点重画。大白话和新想法也可以直接写进文稿，再用整理理顺、收拢。

### 3. 下一场聊天，接着当前版本工作

在同一台电脑开启新的 Codex 对话，把主题名称和后续任务换成自己的：

> 使用 gft-map，连接「产品发布计划」这份主题，读取当前理解。先告诉我已经确定的决定、待验证的问题和约束，再基于它们帮我安排下一步。

检查回答是否采用了刚才的修正，再继续真正要做的事。如果仍在原来的对话，可以直接说：“使用 gft-map，重新读取本场已连接的主题，按最新内容继续。”

**连接保存关系，读取才把内容交给 Agent。**它先看简短索引，再按任务读取需要的正文；右侧变化不会自动唤醒聊天，也不会把全文塞进每一轮。再次读取时拿到的是保存后的当前版本。

使用中卡住了，直接[反馈问题](https://github.com/CoralLips/gft-map/issues)：说清你做到哪一步、实际发生了什么，附上必要的报错即可；请去掉私人聊天和凭证。

<details>
<summary>手动安装、终端启动与 Claude Code</summary>

仓库的 `skills/gft-map/` 包含完整说明、脚本和已构建界面，安装工具直接复制，无需编译。Node.js 和 Agent CLI 仍需事先安装。

也可以从 [Releases](https://github.com/CoralLips/gft-map/releases/latest) 下载 `gft-map-<版本号>.tar.gz`，把解压后的完整 `gft-map` 文件夹放进技能目录；不能只复制 `SKILL.md`。包中包含运行依赖，无需 `npm install`；手动安装支持 Node.js 20+。GitHub 自动附带的 **Source code** 用于源码开发。

| Agent | 用户级安装位置 |
|---|---|
| Codex | `~/.agents/skills/gft-map/` |
| Claude Code | `~/.claude/skills/gft-map/` |

`~` 是用户主目录；Windows 通常为 `C:\Users\你的用户名`。目录内应直接有 `SKILL.md` 和 `scripts/`，不要多套一层同名文件夹。安装工具会显示实际路径。参考 [Codex 官方说明](https://learn.chatgpt.com/docs/build-skills) 与 [Claude Code 官方说明](https://code.claude.com/docs/en/skills)。

需要自己启动时，在安装后的 `gft-map` 目录打开终端：

```sh
node scripts/cli.mjs doctor --agent codex
node scripts/cli.mjs serve --port 4317 --agent codex
```

保留终端，按 `Ctrl+C` 停止。`--agent codex` 启用页面模型按钮；省略时只启动查看、编辑模式。

安装到 Claude Code 时，将安装命令的 `--agent codex` 换成 `--agent claude-code`。Skill 与聊天来源已适配；Claude ACP 页面执行及跨客户端续接仍为实验性，需要另外配置适配器。也可以用已登录的 Codex 执行器处理选定的 Claude 聊天。详见[高级配置](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md)。

</details>

## 从这里带走，在另一份面板里继续

导出只保留两个选项：**复制**当前 Doc（含主题和正文），或**下载**当前脉络的完整文件。到另一份 GFT Map，在设置中选择 **导入脉络**；导入会创建新脉络，原主题不会被覆盖。

文件携带主题、Doc、Map 和已接收的 Log；账号凭证、连接关系和读取进度不会随文件迁移。导入后可以修改内容，再连接那台电脑上的聊天。

如果希望在 GFT 网页与本地持续接着编辑，在设置中打开 **GFT 账号**，登录同一个账号即可自动双向同步，无需反复导出。未登录时仍可独立使用全部本地功能。

可以先在[在线样例](https://corallips.github.io/gft-map/demo.html?case=product&step=transfer)里试一次导出、重新导入，或[下载产品讨论示例](https://corallips.github.io/gft-map/examples/product.gft.json)放进自己的本地面板。

## 三个按钮的区别

| 操作 | 用途 |
|---|---|
| 更新 | 从已连接会话接收增量材料，保存到 Log，再按主题更新 Doc／Map。 |
| 整理 | 理顺当前主题表述、手写文稿和现有节点，收拢重复判断；保留主题边界、依据和转折。 |
| 重画 | 保留当前主题，从已保存的 Log 重新生成 Doc／Map；不重新扫描聊天、不重置增量进度。 |

主题是可修改的过滤范围。Log 记录已经接收的来源，不因主题改变而删除；旧数据若只有提取记录，无法恢复从未保存的原文。

长历史会分批提炼，最终汇总成图文；进度可见，支持取消，处理时间和额度用量取决于材料与执行器。工具栏的标签用于管理连接，× 可单独断开；多个来源连接到同一主题时，更新会让你选择本次来源。

## 支持范围

| 能力 | 当前状态 |
|---|---|
| 本地面板、Doc／Map 编辑、文件迁移 | 可用；无需 GFT 登录。 |
| Codex 页面执行 | 已做真实任务验收；使用临时 CLI 任务，不保存新的聊天历史。 |
| Codex／Claude Code 聊天来源 | 按明确会话读取，分别保存增量位置；不全量扫描所有聊天正文。 |
| Claude ACP 执行 | 实验性；协议测试通过，真实生成与跨客户端续接仍待完整验收。 |
| MCP 连接表单与读取工具 | 可选；表单是否显示取决于客户端，网页连接入口可独立使用。 |
| GFT 账号与同步 | 登录后自动双向同步脉络，包括新增、修改和删除；离线修改先保存在本地。 |

读取来源和执行模型是两件事：例如用 Codex 执行器处理一场 Claude Code 聊天。支持 ACP 协议不代表所有 Agent 的历史读取都已适配。

需要 MCP 原生工具时，保持服务运行，再执行 `node scripts/cli.mjs mcp-config`，按输出配置本地 MCP 服务。详细参数见 [连接说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/skill/references/connections.md) 和 [高级配置](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md)。默认不安装通知 Hook。

## 数据、账号与迁移

数据默认存放于 `~/.gft-local/`，可用 `GFT_LOCAL_HOME` 更改。**页面和 Skill 必须使用同一个数据目录。**升级安装包不会替换该目录；升级前可导出重要主题作为备份。

**未登录时，脉络只保存在本机；登录后，现有本地脉络会与该 GFT 账号自动双向同步。**同步包含名称、主题、Doc／Map 和 Log，不需要逐份选择上传。关闭本地服务后，需下次启动才能继续同步。账号窗口显示同步状态；网络恢复后自动重试。

登录状态下删除已同步脉络，会同步删除另一端。退出登录后删除仅影响本地，再次登录会从云端补回。两端同时修改时保留冲突副本；同名但不同 ID 的脉络不会擅自合并。换账号不会把已经属于另一账号的本地脉络自动上传；有意迁移时使用下载、导入。

使用联网执行器时，任务所需材料会发送给该执行器的模型服务，并使用它的额度；“存储在本地”不等于“模型离线运行”。默认模型与思考强度来自执行器配置，不跟随另一场聊天输入框。

下载的 `.gft.json` 文件包含当前单个主题的名称、范围、图文与 Log，不含会话连接或增量水位。导入创建新主题，不覆盖原主题。普通来源使用 `gft-theme` v2；自由编辑过的 Log 使用 v3，需要支持 v3 的客户端，两端均兼容旧 v1/v2。单包上限 4 MB，超过会报错，不截断。

Log 可在设置中整篇编辑、复制全部；失焦或 Ctrl+S 保存。保存改变底层材料，Doc／Map 不会立刻重生成；点击重画后使用修改后的 Log。

## 从源码运行

```sh
git clone https://github.com/CoralLips/gft-map.git
cd gft-map
npm ci
npm run build
node apps/gft-local/cli.mjs doctor --agent codex
npm start -- --agent codex
```

源码运行与 Skill 安装包二选一即可。省略 `--agent codex` 时，仅启动本地查看和编辑模式；不会启用页面模型执行器。

检查与打包：

```sh
npm run typecheck
npm test
npm run pack:skill
npm run test:skill -- apps/gft-local/release/gft-map
```

`pack:skill` 根据你当前修改后的源码生成安装包及 `SHA256SUMS`，需要系统 `tar`；不要求源码保持官方导出时的样子。只需要完整技能目录时，可运行 `npm run build:skill`，结果在 `apps/gft-local/release/gft-map/`。`test:skill` 在临时目录验证启动、页面资源、保存和读取，不使用真实聊天或调用模型。

公开仓可独立构建、修改，不依赖私有仓。`src/` 是共享组件与逻辑，`apps/gft-local/` 是本地应用，`skills/gft-map/` 是随正式版本生成的安装目录。开发请修改源码，重新构建自己的安装包；不要手改生成目录。贡献请提交 PR，涉及共享功能的修改会合回维护源，再统一导出。

介绍页与在线案例的源码在 `apps/gft-local/showcase/`。`npm run build:site` 构建静态页面，`npm run preview:site` 在本机 4318 端口预览；`npm run test:site` 检查资源链接与三份可迁移样例。页面由公开仓的 GitHub Pages 工作流发布，不进入 GFT 平台的构建或用户数据目录。

`SOURCE-MANIFEST.json` 仅记录官方导出的来源，不参与普通构建、PR 检查或打包；`check:source` 是维护者可选的原始快照核对工具，修改源码后不需要运行或更新它。下载附件的 `SHA256SUMS` 用来核对安装包是否完整，与限制源码修改无关。

## License

MIT。安装包附带打包依赖的许可证；第三方 Agent 和模型服务遵循各自条款。
