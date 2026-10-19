<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

# GFT-Map

## 和 AI 想清楚的事，别再找不回

**把和 AI 聊出来的判断，变成你能看、能改、能带走的工作稿。**

讨论越长，越难找回当时定了什么、为什么这样定、还有什么没想清楚。GFT-Map 将这些内容放进一份可编辑的文稿和关系图：你可以查看理由、纠正判断，再接着想。

工作稿保存在本机，可以导出交给别人，也可以让下一场 Agent 对话读取。

[体验示例](https://corallips.github.io/gft-map/) · [开始使用](#开始使用) · [日常使用](#日常使用)

[![GFT-Map：查看地图、编辑文稿、预览上下文、导出带走](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/walkthrough.gif)](https://corallips.github.io/gft-map/demo.html?lang=zh&case=product)

### 看看它怎么用

| 产品决策 | 文章写作 | 技术方案 |
|---|---|---|
| [![产品决策的思维脉络](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.png)](https://corallips.github.io/gft-map/demo.html?lang=zh&case=product) | [![文章写作的可编辑文稿](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/writing.png)](https://corallips.github.io/gft-map/demo.html?lang=zh&case=writing&view=doc) | [![技术方案的约束与验证计划](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/engineering.png)](https://corallips.github.io/gft-map/demo.html?lang=zh&case=engineering) |
| 保留产品取舍与依据。 | 整理观点，明确作者立场。 | 保留技术约束与待解决的问题。 |
| [打开案例 →](https://corallips.github.io/gft-map/demo.html?lang=zh&case=product) | [打开案例 →](https://corallips.github.io/gft-map/demo.html?lang=zh&case=writing&view=doc) | [打开案例 →](https://corallips.github.io/gft-map/demo.html?lang=zh&case=engineering) |

示例使用预置材料，可直接编辑、导出；无需安装，不调用模型。AI 更新、整理和重画需安装本地版。

<a id="第一次使用"></a>

## 开始使用

### 1. 安装 Skill，打开面板

准备 **Node.js 22.20+**，并安装、登录所用 Agent 的 CLI。选择对应的安装命令：

**Codex**

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent codex --global
```

**Claude Code**

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent claude-code --global
```

Claude Code 需先在终端运行一次 `claude auth login`。首次使用需要联网准备连接组件，页面与已有内容可先打开。

安装后重新打开 Agent 对话，发送：

> 打开 gft-map。

面板通常在 `http://127.0.0.1:4317/`，以 Agent 返回的地址为准。

在 **设置 → AI 处理** 选择 Codex 或 Claude Code。页面的 AI 操作使用所选 Agent 的账号额度，默认用厂商推荐的模型，也可以在这里换别的模型；思考强度始终用所选模型的默认值。收录的聊天来自哪家都可以，比如用 Claude Code 处理 Codex 的聊天。[Agent 与额度说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#installation)

### 2. 连接讨论，生成脉络

1. 在面板新建脉络，点击 **更新**。
2. 选择要收录的 Codex 或 Claude Code 聊天，用 **包含已有内容** 导入该聊天的历史消息。
3. 在 **Doc** 阅读和修改，在 **Map** 查看判断与关系。

以后直接点击 **更新**，会依次读取这份脉络已连接的全部会话，只收录新增消息。长聊天和超长单条消息会分批处理；可随时停止，再次更新时接着已完成的批次继续。

**已有文件？** 点击右上角 **导入**，放入 UTF-8 文本、Markdown 或聊天记录。材料会按主题分批整理，每批结果出现在 Doc／Map；可随时 **暂停／继续**。[大文件说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#materials)

### 3. 接着想，也让 Agent 用上这份工作稿

在当前或新的 Agent 对话中，告诉它要读取哪份脉络、接下来做什么。例如：

> 使用 gft-map，连接并读取「产品发布计划」，根据当前进展帮我安排下周的工作。

把名称和任务换成自己的。Agent 先查看所连主题的简短索引，再按当前任务读取正文。面板修改不会自动唤醒聊天，需要时让 Agent 重新读取。

## 日常使用

每份脉络包含 **Doc 文稿、Map 关系图和 Log 来源材料**。主题决定 Doc／Map 收录什么，Log 保留收到的原始材料。

| 想做什么 | 操作 |
|---|---|
| 收录聊天里的新进展 | **更新**：接收新消息，更新 Doc／Map。 |
| 理顺写下的想法、收拢重复内容 | **整理**：按主题整理文稿和节点，已有主题原文不变。 |
| 调整关注方向，重新梳理已有材料 | 修改主题后点 **重画**：按当前主题从 Log 生成 Doc／Map。 |

**整理的范围**：选中一个节点时，只改这个节点的标题和说明，不改 Doc；选中多个时，整理所选判断及相关正文；什么都不选，就整理整份脉络。再点一次可以停止。

**直接修改**：主题、文稿和 Log 都能直接编辑，失焦或按 Ctrl+S 保存。在 Map 中点节点可以改标题和说明，点连线可以改这条关系的说明。[编辑与选择的细节](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#editing)

**任务与撤回**：切换脉络、刷新或关闭网页，不会停掉已经开始的 AI 任务；回来后能看到进度，也能停止；处理中，按钮上会显示 AI 正在写的修改，比如合并了哪几条、正在改写哪一章。**Ctrl+Z** 按顺序撤回，**Ctrl+Y** 重做，刷新后依然有效；设置里的 **操作历史** 可以查看并撤回最近 30 次修改。撤回聊天更新时，原始材料保留，下次更新会重新读到那批消息。

**带走内容**

- **复制**：复制当前 Doc，交给别人或另一个 Agent。
- **下载**：保存完整脉络文件，在另一份 GFT-Map 中通过右上角「导入」继续使用。含文件材料时，暂停整理后下载 `.gftpack`，原文、修改和处理进度一起带走。

本地使用无需 GFT 账号，跨电脑搬运用下载／导入即可。云同步暂不作为推荐用法；已登录账号的同步行为见[详细说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#account)。

**数据会去哪？** 脉络和收到的聊天原文保存在本机。点击 AI 更新、整理或重画时，任务所需材料会交给你选的 Agent 的模型服务，使用该服务的账号额度。登录 GFT 账号后，脉络（含 Log）会同步到 GFT 云端。GFT-Map 不会扫描或上传你的全部项目文件和全部聊天。

## 打开、关闭与更新

让 Agent **打开或关闭 GFT-Map** 即可。关闭网页不会关闭后台服务；电脑重启或页面打不开时，再让 Agent 打开 GFT-Map。[运行与排障说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#打开本地页面)

<a id="更新到新版"></a>

**更新到新版**，在 Agent 中说：

> 使用 gft-map，更新到最新正式版，保留我的脉络、聊天连接和设置。重启面板，确认运行的版本和更新后的版本一致。

更新前暂停文件整理，完成或取消其他运行中的任务；已有数据和处理进度会保留。[更新与恢复说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#upgrade)

## 项目状态与反馈

当前正式版为 [v0.3.13](https://github.com/CoralLips/gft-map/releases/latest)。现有功能已收尾，后续以问题修复和维护为主。

同系列工具：[GFT-Merge](https://github.com/CoralLips/gft-merge)，把 Claude Code 和 Codex 的多个会话合在一起，开一个带着这些上下文的新会话。

欢迎带着自己的写作、决策或技术讨论试用，并在 [Issues](https://github.com/CoralLips/gft-map/issues) 分享使用场景、遇到的问题或做出的工作稿。对你有用的话，也欢迎点一个 Star。

---

[安装与详细说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md) · [开发与贡献](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/CONTRIBUTING.md) · [反馈问题](https://github.com/CoralLips/gft-map/issues) · [MIT License](https://github.com/CoralLips/gft-map/blob/main/LICENSE)

遇到问题时，附上操作步骤和报错即可；请去掉私人聊天和凭证。
