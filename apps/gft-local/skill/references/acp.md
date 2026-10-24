# 任务执行器连接

`codex-acp`（Codex）与 `claude-acp`（Claude Code）是默认连接，页面只显示 Codex 和 Claude Code。用户在对应 Agent 完成登录，不自动修改认证。

- Codex 经本机 Codex 自带的 app-server 运行，每次任务开一个 Codex 不保留的临时线程：不出现在 Codex 的会话列表或归档里，用的是同一账号额度，文本边写边传回页面。不需要另装组件；可执行文件依次取 `GFT_CODEX_BIN`、Codex 应用自带的 `codex`、PATH 中的 `codex`。名称 `codex-acp` 沿用旧名，以保留已保存的选择。
- Claude Code 经固定版本的 ACP 适配器运行，会话不持久化。SDK 随 Skill 打包；适配器由产品首次使用时自动准备，需要 Node.js 22 或更新版本及 npm 和网络。组件完整后才启用，保存在数据目录的 `adapters` 子目录，后续复用；不要要求用户研究适配器路径。

```text
node scripts/cli.mjs doctor --agent codex-acp
node scripts/cli.mjs serve --agent codex-acp --port 4317
```

另一入口将 `codex-acp` 改为 `claude-acp`。用户已经授权启用并选定 Agent 时，检查和启动属于同一次操作，不再额外确认。

日常使用 `open`；普通启动会把旧原生连接迁移到同一家的默认连接，保留超时，清除旧模型固定值。仅在明确的兼容障碍下，使用 `restart --agent codex` 或 `restart --agent claude` 临时兼容，不因登录、额度、限流失败自动改用 CLI。诊断时可用 `--acp-bin` 绝对路径与逐项 `--acp-arg` 指定可执行文件（Codex 为 `codex` 本身，Claude 为适配器）；Windows 的 JS 适配器使用 `node.exe` 加真实 JS 入口，不传 shell 命令字符串。

可用环境变量设置同一配置：`GFT_CODEX_ACP_BIN` / `GFT_CODEX_ACP_ARGS`，或 `GFT_CLAUDE_ACP_BIN` / `GFT_CLAUDE_ACP_ARGS`。参数变量是 JSON 字符串数组，例如 `["D:/adapters/package/dist/index.js"]`。这只是格式示例，应核对已安装包的真实入口，不猜路径。用 `--timeout-seconds 900` 设置超时。默认使用厂商推荐模型，可在页面“AI 处理”中改选；`--model MODEL` 仅用于原生 CLI 诊断。

检查会核对握手和可用模型（Claude 另会创建会话并选择只读模式），不运行模型。成功不等于模型服务接受了登录或已有额度；仍需用合成材料完成一次任务并回读结果。认证失败时指导用户在对应 Agent 登录，不重复重试、不猜模型名、不偷偷换付费服务。Codex 从 app-server 的模型列表读取推荐模型及其默认强度；Claude 明确使用 default 模型与自动强度。选了别的模型时只换模型，强度仍用该模型的默认值。不沿用个人调高的配置，不修改全局设置，不把默认说成最便宜。来源读取仍只支持 Codex 和 Claude Code。

Claude 连接组件的完整依赖树随包锁定，安装使用 `npm ci --ignore-scripts`；页面先启动，准备完成后才启用 AI。失败原因与经脱敏的 npm 退出码、尾部输出写入数据目录的 `adapters/install-errors.log`，日志轮换限制增长。损坏缓存只有在新安装完整后才被替换。早期版本为 Codex 安装的适配器在启动时自动清理。
