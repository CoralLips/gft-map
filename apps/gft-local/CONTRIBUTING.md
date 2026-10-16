# 开发与贡献

这份说明面向希望修改 GFT Map、从源码运行或提交贡献的开发者。安装和使用 Skill 请看 [README](https://github.com/CoralLips/gft-map/blob/main/README_ZH.md#开始使用)。

## 从源码运行

需要 Node.js 22+。启用页面 AI 操作时，还需安装并登录对应的 Agent CLI。以下命令在公开仓运行：

```sh
git clone https://github.com/CoralLips/gft-map.git
cd gft-map
npm ci
npm run build
node apps/gft-local/cli.mjs doctor --agent codex
npm start -- --agent codex
```

示例使用 Codex 执行器；其他执行方式见 [高级配置](ADVANCED.md)。省略 `--agent codex` 时，仅启动查看、编辑、导入和导出功能。源码运行与 Skill 安装二选一即可。

## 目录与修改位置

| 目录 | 用途 |
|---|---|
| `apps/gft-local/` | 本地服务、Agent 接入和页面宿主。 |
| `src/` | 与 GFT 共用的图文组件、状态和整理逻辑。 |
| `apps/gft-local/showcase/` | 介绍页与可编辑示例。 |
| `skills/gft-map/` | 发行流程生成的完整 Skill，供安装工具直接复制。 |

请修改 `apps/gft-local/` 或 `src/`，再构建自己的安装包；不要手改生成的 `skills/gft-map/`。公开仓可独立构建，不依赖私有仓，也不需要 GFT 云端凭证。

## 检查与打包

```sh
npm run typecheck
npm test
npm run test:memory
npm run pack:skill
npm run test:skill -- apps/gft-local/release/gft-map
```

`pack:skill` 根据当前源码生成完整技能目录、压缩包和 `SHA256SUMS`，需要系统 `tar`。只需技能目录时，运行 `npm run build:skill`，结果在 `apps/gft-local/release/gft-map/`。

`test:skill` 在临时目录验证启动、页面资源、保存和读取，不使用真实聊天或调用模型。修改后可以直接测试和打包，不要求源码保持官方导出时的状态。

## 测试判断边界

测试应保护用户动作的含义，而不是固化当前实现。已提交的本地后台任务不随切换脉络、刷新或关页取消；只有主动停止才取消。验收需覆盖切走后完成、快速切回接回同一任务、结果只写原脉络、返回后可撤回。未启用服务端任务能力的浏览器计算仍需隔离旧响应，不可把这类测试套用到后台任务。

`npm test` 为测试进程及其子进程建立临时 Agent 配置目录，移除继承的提供商凭证和自定义执行器配置；测试结束后清理。普通回归仅使用模拟执行器，不读取真实聊天，也不进行登录或退出登录。直接运行单个测试文件会绕过这个入口，因此涉及执行器的验证应通过此入口进行；真实模型验收须单独明确安排。

`npm run test:memory` 单独启用垃圾回收检测反复打开、关闭页面的监听器和堆内存；公开发行 CI 同时运行。它能发现固定数据下的持续累积，不能代替长期使用或真实睡眠／唤醒验收。

整理返回“无需修改”或只改善表述均可完成，不能以强行减少节点或追加模型调用作为成功标准。

提示词字符串断言只验证规则已传给模型；固定模型响应验证解析、主题原文保护、落盘及撤回。两者都不能证明模型实际理解主题。主题过滤质量需另用混合材料样例检查生成结果：主题内判断保留，写稿与制作流程不进入 Map/Doc，完整来源仍可回查。真实模型验收应说明样例、执行器及结果，不把回归全绿写成语义过滤已保证。

## 介绍页与示例

```sh
npm run build:site
npm run test:site
npm run preview:site
```

预览地址为 `http://127.0.0.1:4318/`。检查覆盖页面链接、资源和三份可迁移示例。公开仓通过 GitHub Pages 工作流发布这些静态页面，它们不进入 GFT 平台的构建或用户数据目录。

## 提交贡献

提交 PR 时，请说明解决的问题、改动效果和验证方式。涉及共享功能的修复会合回 GFT 维护源，再统一导出，保持两端同源。

`SOURCE-MANIFEST.json` 只记录官方导出的来源，不参与普通构建、PR 检查或打包。`check:source` 是维护者可选的原始快照核对工具；修改源码后不需要运行它或更新校验值。发行附件中的 `SHA256SUMS` 用于核对安装包是否完整。

源码按 MIT 许可开放。安装包附带实际打包依赖的许可证；第三方 Agent 和模型服务遵循各自条款。

## 许可证范围

GFT Map 自有代码采用 MIT。安装包中的第三方组件分别遵循自身许可证，完整声明见 Skill 包的 `THIRD_PARTY_NOTICES.txt`。其中 Claude Agent SDK 遵循 Anthropic 的单独条款，不属于 MIT 授权范围；修改、再发行或商用集成时应另行核对其条款。
