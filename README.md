# GFT Map

### 把聊过的事，接着做下去。

昨天和 Agent 确定了首版边界，今天换一场聊天，它又建议把暂缓的功能加回来。写文章时删掉的论点，第二天又出现在大纲里。方案讨论了几轮，接着编码时，却得重新解释为什么这么选。

**GFT Map 把这些决定、理由和未解问题，整理成一份你能看懂、能纠正、能带走的上下文。** 下一场 Agent 对话可以按需读取，继续同一件事。

[打开介绍与样例](https://corallips.github.io/gft-map/) · [直接试用](https://corallips.github.io/gft-map/demo.html?case=product) · [安装到本地](#第一次使用) · [下载安装包](https://github.com/CoralLips/gft-map/releases/latest)

[![GFT Map 实际面板操作：查看地图、编辑文稿、预览读取内容，再导出带走](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/walkthrough.gif)](https://corallips.github.io/gft-map/demo.html?case=product)

*点击动图打开可编辑示例。这里使用本地版同一套图文组件；无需安装，也不连接你的聊天或模型。*

## 先打开一件你熟悉的事

| 产品决策 | 文章写作 | 技术方案 |
|---|---|---|
| [![产品决策的思维脉络](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.png)](https://corallips.github.io/gft-map/demo.html?case=product) | [![文章写作的可编辑文稿](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/writing.png)](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [![技术方案的约束与验证计划](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/engineering.png)](https://corallips.github.io/gft-map/demo.html?case=engineering) |
| **为什么首版不做银行同步？** 保留用户、首版边界与暂缓理由，下次讨论功能时不从头再来。 | **别再把删掉的论点写回来。** 作者立场、删去的观点、待补的经历一起交给下一场写作。 | **下一场编码，还记得这些约束吗？** 留下断点续传、幂等要求和待做测试，让实现接住方案。 |
| [打开产品讨论 →](https://corallips.github.io/gft-map/demo.html?case=product) | [打开文稿，试着改 →](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [查看方案与依据 →](https://corallips.github.io/gft-map/demo.html?case=engineering) |

这些案例是人工编写的示例材料，不是真实用户聊天，也不是模型效果评测。你可以编辑、查看来源、导出再导入；在线的“读取预览”展示当前内容，不会伪装成一场真实 Agent 回答。AI 更新、整理和重画在安装后的本地版执行。

## 一份上下文，怎样帮你接着做

**先把已经聊过的事看清楚。** 连接一场明确的聊天，点更新。Doc 展开当前理解，Map 展示判断之间的关系，Log 保留已经接收的来源。主题首次自动生成，你可以看完结果再调整。

**发现理解偏了，直接改。** “这个不是结论，只是猜测。”在 Doc 里改回来，或调整一个节点。大白话和新想法也可以写进文稿，再用整理理顺、收拢。主题改变后，重画会根据保留的 Log 重新组织图文。

**下一场聊天，接着当前版本工作。** 让 Agent 连接这份主题。它先看简短索引，再按任务读取需要的正文；再次读取时拿到你修改后的版本。GFT Map 不会在右侧每次变化时自动唤醒聊天，也不把全文塞进每一轮对话。

可以在样例里试一个小动作：把“三位目标用户”改成自己的计划，打开 **交给下一场聊天 → 预览按需读取的正文**，看看这份修改是否已经在里面。

## 从这里带走，在自己的面板里继续

示例里的内容可以成为你的起点：

1. 在样例中点 **导出 → 完整脉络包 .json**，或直接[下载产品讨论的示例文件](https://corallips.github.io/gft-map/examples/product.gft.json)。
2. 打开本地 GFT Map，在脉络名称的下拉菜单里选择 **导入脉络**。
3. 它会成为一份新脉络。修改主题和内容，再连接自己的聊天。

文件携带主题、Doc、Map 和已接收的 Log；原主题不会被覆盖，账号凭证、连接关系和读取进度不会随文件迁移。也可以先在[在线样例](https://corallips.github.io/gft-map/demo.html?case=product&step=transfer)里试一次导出、重新导入。

GFT Map 在本机运行，开源且无需 GFT 账号。它复用 [Git for Thought](https://gitforthought.com) 的图文编辑与整理能力；这个仓库提供完整本地产品源码，Skill 是其中一种安装方式。

## 第一次使用

准备已经登录的 **Codex CLI**。GitHub 一键安装建议使用 **Node.js 22.20+**，满足当前 `skills` 安装工具的要求；手动安装 Release 时，GFT Map 本身支持 **Node.js 20+**。仅安装聊天客户端，不一定已具备可用的 CLI；下面的检查命令会说明缺少什么。模型操作使用执行器现有账号的额度和配置。

### 1. 安装完整 Skill

通过 [skills 安装工具](https://github.com/vercel-labs/skills) 从 GitHub 安装到 Codex：

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent codex --global
```

Claude Code 将 `--agent codex` 换成 `--agent claude-code`。安装工具会显示实际安装路径；`--global` 表示当前用户的各个项目都能使用。安装后，重新打开 Agent 或刷新技能列表。

仓库的 `skills/gft-map/` 是完整安装目录，包含说明、脚本和已经构建的界面；安装工具复制这个目录，无需编译应用或访问 GFT 私有仓。Node.js 和所用 Agent CLI 仍需事先安装。

也可以从 [Releases](https://github.com/CoralLips/gft-map/releases/latest) 下载 `gft-map-<版本号>.tar.gz`，解压后手动安装。GitHub 自动附带的 **Source code** 留给源码开发使用。保留整个 `gft-map` 文件夹，不能只复制 `SKILL.md`；包中已包含应用运行依赖，无需再执行 `npm install`。

手动安装时，将文件夹放到你使用的 Agent 技能目录：

| Agent | 用户级安装位置 |
|---|---|
| Codex | `~/.agents/skills/gft-map/` |
| Claude Code | `~/.claude/skills/gft-map/` |

`~` 表示用户主目录；Windows 通常是 `C:\Users\你的用户名`。确保该目录内直接有 `SKILL.md` 和 `scripts/`，没有再套一层同名文件夹。安装位置依据 [Codex 官方说明](https://learn.chatgpt.com/docs/build-skills) 与 [Claude Code 官方说明](https://code.claude.com/docs/en/skills)。Claude 的支持范围见下文。

### 2. 启动本地面板

在安装后的 `gft-map` 目录打开终端，运行：

```sh
node scripts/cli.mjs doctor --agent codex
node scripts/cli.mjs serve --port 4317 --agent codex
```

检查通过后，打开 **http://127.0.0.1:4317/**。保留这个终端；按 `Ctrl+C` 可停止服务，已经保存的主题仍保留。`--agent codex` 使页面的更新、整理、重画按钮能够执行模型任务。

### 3. 得到第一份主题上下文

1. 在页面新建脉络，点 **更新**。
2. 选择一场已有几轮讨论的短对话，选 **包含已有内容** 并确认。这样第一次就有材料可生成。若选 **从现在开始**，需先在那场聊天完成新一轮，再回来更新；没有新材料时不会生成内容。
3. 等任务完成，在 Doc 阅读，在 Map 查看；首次会自动生成主题范围和名称。
4. 有不准确的地方，直接修改。之后点击更新，只接收尚未收录的消息；没有新增就不调用模型。

想调整方向，可以改 Doc 顶部的主题范围，再点重画。长历史会分批提炼，最终汇总成图文；进度可见，支持取消，处理时间和额度用量取决于材料与执行器。

工具栏以圆角标签显示已连接会话，保持单行；超出显示宽度时可横向滚动查看。点标签管理连接，点对应的 × 单独断开。多场会话连接到同一主题时，点击更新会让你选择这次的来源。

### 4. 让 Agent 读回去

回到本机 Agent，选择 `gft-map` Skill，或明确说：

> 使用 gft-map，查看本场已经连接的主题索引，读取与当前任务有关的内容。先告诉我你读到了什么，再继续工作。

开启新对话时，可以说：

> 使用 gft-map，连接「产品发布计划」这份主题，然后读取当前理解。

将示例名称换成自己的主题。Skill 通过 CLI 操作同一个本地服务；**网页连接成功不等于记忆已经进入聊天**。右侧修改后，Agent 下一次读取才会得到新版，不会自动唤醒聊天或每轮塞入全文。客户端未发现新 Skill 时，刷新技能列表或重新打开会话。

可以做一次简单检查：把 Doc 中一项“已确定”的判断改为“待验证”，保存后让 Agent 重新读取这个主题并说明当前结论。它应保留你的修正。再开一场对话连接同一主题，检查能否接着工作。若结果不符，请记录复现步骤并反馈；仅显示“已连接”不代表这轮记忆复用已完成。

## 三个按钮的区别

| 操作 | 用途 |
|---|---|
| 更新 | 从已连接会话接收增量材料，保存到 Log，再按主题更新 Doc／Map。 |
| 整理 | 理顺当前主题表述、手写文稿和现有节点，收拢重复判断；保留主题边界、依据和转折。 |
| 重画 | 保留当前主题，从已保存的 Log 重新生成 Doc／Map；不重新扫描聊天、不重置增量进度。 |

主题是可修改的过滤范围。Log 记录已经接收的来源，不因主题改变而删除；旧数据若只有提取记录，无法恢复从未保存的原文。

## 支持范围

| 能力 | 当前状态 |
|---|---|
| 本地面板、Doc／Map 编辑、文件迁移 | 可用；无需 GFT 登录。 |
| Codex 页面执行 | 已做真实任务验收；使用临时 CLI 任务，不保存新的聊天历史。 |
| Codex／Claude Code 聊天来源 | 按明确会话读取，分别保存增量位置；不全量扫描所有聊天正文。 |
| Claude ACP 执行 | 实验性；协议测试通过，真实生成与跨客户端续接仍待完整验收。 |
| MCP 连接表单与读取工具 | 可选；表单是否显示取决于客户端，网页连接入口可独立使用。 |
| GFT 账号 | 可选网页授权；不自动同步或上传主题。 |

读取来源和执行模型是两件事：例如用 Codex 执行器处理一场 Claude Code 聊天。支持 ACP 协议不代表所有 Agent 的历史读取都已适配。

需要 MCP 原生工具时，保持服务运行，再执行 `node scripts/cli.mjs mcp-config`，按输出配置本地 MCP 服务。详细参数见 [连接说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/skill/references/connections.md) 和 [高级配置](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md)。默认不安装通知 Hook。

## 数据、账号与迁移

数据默认存放于 `~/.gft-local/`，可用 `GFT_LOCAL_HOME` 更改。**页面和 Skill 必须使用同一个数据目录。**升级安装包不会替换该目录；升级前可导出重要主题作为备份。

本地文件不会自动上传 GFT。使用联网执行器时，任务所需材料会发送给该执行器的模型服务，并使用它的额度；“存储在本地”不等于“模型离线运行”。默认模型与思考强度来自执行器配置，不跟随另一场聊天输入框。

“完整脉络包 .json”包含当前单个主题的名称、范围、图文与 Log，不含账号凭证、会话连接或增量水位。导入创建新主题，不覆盖原主题。使用 `gft-theme` v2，兼容旧 v1；单包上限 4 MB，超过会报错，不截断。自动云同步尚未提供。

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

## 常见问题

- **页面打不开：**确认终端中的服务仍在运行，且端口是 4317。查看启动错误，不重复启动多个服务抢同一端口。
- **按钮提示执行器不可用：**用 `doctor --agent codex` 检查 Codex CLI 和登录；启动时加 `--agent codex`。路径检测失败时见高级配置的 `GFT_CODEX_BIN`。
- **已经连接，但 Agent 不知道内容：**连接只保存关系。让 Agent 使用 `gft-map` 查看索引并读取所需主题。
- **第一次更新提示没有新增：**如果连接时选了“从现在开始”，先完成一轮新对话再更新；如果已有内容都已收录，则无需重复处理。
- **原来的主题不见了：**先核对页面、CLI 的 `GFT_LOCAL_HOME`，不要删除数据或重建来覆盖问题。
- **使用 Claude：**Skill 与聊天来源已适配；网页执行还需 Claude ACP 适配器与有效登录，详见高级配置。首版优先提供已验收的 Codex 路径。

## License

MIT。安装包附带打包依赖的许可证；第三方 Agent 和模型服务遵循各自条款。
