<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

# GFT Map

## 把聊过的事，接着做下去。

换一场聊天，之前讨论过的决定和理由就容易接不上。AI 到底记住了什么，你也看不清。

**GFT Map 把这些决定、理由和未解问题，整理成一份你能看懂、能纠正、能带走的上下文。** 下一场 Agent 对话可以按需读取，继续同一件事。

[体验示例](https://corallips.github.io/gft-map/) · [开始使用](#开始使用) · [日常使用](#日常使用)

[![GFT Map：查看地图、编辑文稿、预览上下文、导出带走](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/walkthrough.gif)](https://corallips.github.io/gft-map/demo.html?lang=zh&case=product)

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

Codex 页面 AI 操作已验证可用；Claude Code 的页面 AI 操作需额外配置，目前为实验性。见[安装与配置](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#installation)。

安装后重新打开 Agent 对话，发送：

> 使用 gft-map，检查运行环境，启动本地面板并启用更新、整理和重画，给我打开页面。

Skill 的安装只提供 Agent 的说明和脚本，不会单独常驻启动网页服务。上面的请求会在需要时启动本地 Node 面板；以后直接打开 `127.0.0.1:4317` 前，先确认这个服务仍在运行。若浏览器显示 `ERR_CONNECTION_REFUSED`，表示服务当前未启动，重新发送上面的请求即可，不要新建数据目录。

面板通常在 `http://127.0.0.1:4317/`，以 Agent 返回的地址为准。

启动后打开设置中的“任务”确认页面执行器。若显示未连接，直接点“连接 Codex”；它会在当前服务中检查本机登录，不会新建数据目录或改动脉络。之后重启服务时，已成功选择的执行器会自动恢复；首次启动或更换执行器时，才需要让 Agent 用同一数据目录执行 `serve --port 4317 --agent codex`。

如果已登录但连接仍提示“Codex 本地状态库不可写”，说明服务是从受限的 Agent 沙箱启动的，Codex 状态目录只能读不能写。不要删除 GFT 数据；从有权限的本机终端重新启动同一安装和同一 `GFT_LOCAL_HOME`，再回到“任务”点击“重新检查”。

<a id="更新到新版"></a>

**已经安装？** 在 Agent 中说：

> 使用 gft-map，更新到最新正式版，保留我的脉络、聊天连接和设置。重启面板，确认运行的版本和更新后的版本一致。

更新前暂停文件整理，完成或取消其他运行中的任务；已有数据和处理进度会保留。[更新与恢复说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#upgrade)

### 2. 连接讨论，生成脉络

1. 在面板新建脉络，点击 **更新**。
2. 选择要收录的 Codex 或 Claude Code 聊天，用 **包含已有内容** 导入该聊天的历史消息。
3. 在 **Doc** 阅读和修改，在 **Map** 查看判断与关系。

以后继续点击 **更新**，只收录新增消息。长聊天和超长单条消息会分批处理；可随时取消，再次更新时接着已完成的批次继续。

**已有文件？** 点击脉络右上角并排的 **导入**，放入 UTF-8 文本、Markdown 或聊天记录。原文件保存后按主题分批整理，每批结果都会出现在 Doc／Map，并自动存档。可随时 **暂停／继续**；服务重启后接着存档处理，已暂停的任务保持暂停。上传中断时重新选择原文件即可续传。[大文件说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#materials)

### 3. 让 Agent 接着用

在当前或新的 Agent 对话中，告诉它要读取哪份脉络、接下来做什么。例如：

> 使用 gft-map，连接并读取「产品发布计划」，根据当前进展帮我安排下周的工作。

把名称和任务换成自己的。Agent 先查看所连主题的简短索引，再按当前任务读取正文。面板修改不会自动唤醒聊天，需要时让 Agent 重新读取。

## 日常使用

每份脉络包含 **Doc 文稿、Map 关系图和 Log 来源材料**。主题决定 Doc／Map 的收录范围，Log 保留收到的来源。

主题、文稿和 Log 都可直接编辑，失焦或按 Ctrl+S 保存。

| 想做什么 | 操作 |
|---|---|
| 收录聊天里的新进展 | **更新**：接收新消息，更新 Doc／Map。 |
| 理顺写下的想法、收拢重复内容 | **整理**：整理当前主题、文稿和节点。 |
| 调整关注方向，重新梳理已有材料 | 修改主题后点 **重画**：按当前主题从 Log 生成 Doc／Map。 |

**带走内容**

- **复制**：复制当前 Doc，交给别人或另一个 Agent。
- **下载**：保存完整脉络文件，在另一份 GFT Map 中通过右上角「导入」继续使用。

含文件材料时，暂停后下载 `.gftpack`，一起带走原文、修改和处理进度。文件原文与进度保存在本机；云端同步包含主题、Doc／Map 和 Log。

本地使用无需 GFT 账号。也可在设置中登录 [GFT 平台](https://gitforthought.com)，自动双向同步脉络。[同步说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#account)

**数据会去哪？** 未登录 GFT 时，脉络和收到的聊天原文保存在本机。点击 AI 更新、整理或重画时，任务所需材料会交给所选 Agent 的模型服务，使用该服务的账号额度；登录 GFT 后，脉络（含 Log）会同步到 GFT 云端。不会扫描、上传所有项目文件或所有聊天。

---

[安装与详细说明](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md) · [开发与贡献](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/CONTRIBUTING.md) · [反馈问题](https://github.com/CoralLips/gft-map/issues) · [MIT License](https://github.com/CoralLips/gft-map/blob/main/LICENSE)

遇到问题时，附上操作步骤和报错即可；请去掉私人聊天和凭证。
