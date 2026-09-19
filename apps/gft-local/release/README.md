# 同源发行维护（供 GFT 维护者）

本文件的导出和同步命令在 GFT 维护仓运行，对应脚本不随公开仓提供。公开仓使用者直接在根目录运行 `npm ci`、`npm run build`、`npm test`、`npm run pack:skill`，即可修改和打包；不需要访问维护仓或通过来源校验。

原 GFT 仓库维护源码，独立发行仓接收白名单快照；公开名称为 GFT Map，目标仓库为 CoralLips/gft-map。公开仓保留 `apps/gft-local` 与共享 `src` 的相对路径。导出器另外构建完整的 `skills/gft-map/`，供 GitHub 安装工具直接复制。源码与技能产物共用一个维护源，不手工维护两份。不要在发行阶段删除或改写云端逻辑，应先修正纯模块与宿主的依赖边界。

## 本地验收

在原仓根目录运行，目标必须为空目录：

```text
node scripts/export-gft-local.mjs --out <临时目录>/gft-local-source
```

进入导出目录后运行：

```text
npm ci
npm run check:source
npm run typecheck
npm run build
npm run build:site
npm run test:site
npm test
npm run pack:skill
npm run test:skill -- skills/gft-map
npm run test:skill -- apps/gft-local/release/gft-map
```

导出器只复制 `source-files.json` 中列明的文件，并检查 TypeScript 类型依赖及构建资源依赖。新增依赖不在白名单时导出失败，需检查后明确加入。它拒绝环境文件、运行数据、云服务入口及可识别的私钥或令牌格式；固定白名单与人工审核共同负责发布范围，字符串检查不等于完整保密审计。

`SOURCE-MANIFEST.json` 记录源提交、是否含未提交变更、每个文件的来源与 SHA-256。v2 按实际字节校验，源码统一 LF，生成目录由 `.gitattributes` 保留原始字节；同步工具仍能读取旧 v1。该校验仅在维护源导出、同步时使用，不阻止贡献者修改或打包。常规发行从干净提交导出，CI 使用 `--require-clean` 检查；本机导出如有其他未提交工作，保留真实的 `sourceDirty`。生成的 Skill 带 MIT 许可和实际运行依赖的完整许可文本，不包含 `node_modules`、构建路径元数据、个人数据或源仓库 Git 历史。

## 双仓流程

自动云同步版本的发布顺序：先验证并部署平台 `071_map_sync.sql` 和新版 Log 读写，再发行本地安装包。数据库验证可运行 `node scripts/test-map-sync-db.mjs`：它仅使用隔离 schema，结束全部回滚。同步模块 `sync.mjs` 必须同时进入源码白名单和 Skill 的 scripts 目录；本地包不携带数据库连接串、用户数据或服务端密钥。公开 README 来自 `apps/gft-local/README.md`，关于登录自动上传、双向删除、离线重试的说明须随版本一起更新。

1. 名称已确定；发布前创建公开仓、建立 `main`。尚未正式发布时只做本地导出，不启用同步工作流。不要把原仓设为公开仓的 Git 远端。
2. 在原仓配置 `GFT_LOCAL_RELEASE_TOKEN`，仅授予目标公开仓 Contents 与 Workflows 写入权限。密钥通过仓库设置保存，不写入源码。
3. 原仓 `Export GFT Map` 工作流默认只验收并生成 Skill 附件。手动选择 `publish` 才同步公开 `main`。推送 `gft-map-v版本` 标签会在验收后同步，并给公开提交打 `v版本` 标签；版本必须与本地包配置一致。
4. 同步步骤单独检出公开仓，只复制清单文件并删除上次清单中已撤出的文件。提交基于公开仓历史，推送不使用 force；远端并发变化或标签已存在会失败，需要检查后重试。
5. 公开仓在 Linux 与 Windows 上独立安装、检查、构建和测试。`v版本` 标签通过后，由公开 CI 创建 Release 并上传 Skill 与校验值。普通源码同步不创建 Release。

介绍页与三个可编辑样例同样从维护源导出，位于 `apps/gft-local/showcase/`。公开仓的 `Publish examples` 工作流单独构建 `site-dist` 并发布到 GitHub Pages；首次需在公开仓启用 Actions 作为 Pages 来源。这里使用人工编写的示例数据和实际图文组件，不包含聊天数据、不调用本机服务或模型，也不进入 GFT 平台部署。修改演示内容后应更新实际截图；导出器按原始字节保留 PNG/GIF。

公开仓是同源发行快照；需要长期保留的修复先并回维护源，再重新导出。公开仓的手改会在来源校验中显现，不能当作原源提交已经包含的变更。

CI 尚未合入原仓或密钥尚未配置时，也可本地同步到单独检出的公开仓：

```text
node scripts/sync-gft-local.mjs --source <已验收的导出目录> --target <公开仓检出目录> --check
node scripts/sync-gft-local.mjs --source <已验收的导出目录> --target <公开仓检出目录>
```

脚本只核对并同步清单文件；之后审查公开仓 diff，按普通 Git 流程提交和推送。它不改变远端，不复制 `.git`，不创建提交或标签。
