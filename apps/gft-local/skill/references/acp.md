# ACP 任务连接

`codex-acp` 与 `claude-acp` 是默认连接。SDK 随 Skill 打包；固定版本的适配器由产品首次使用时自动准备，需要 Node.js 22 或更新版本及 npm 和网络。组件完整后才启用，保存在数据目录的 `adapters` 子目录，后续复用；不要要求用户研究适配器路径。页面只显示 Codex 和 Claude Code。用户在对应 Agent 完成登录，不自动修改认证。

```text
node scripts/cli.mjs doctor --agent codex-acp
node scripts/cli.mjs serve --agent codex-acp --port 4317
```

另一入口将 `codex-acp` 改为 `claude-acp`。用户已经授权启用并选定 Agent 时，检查和启动属于同一次操作，不再额外确认。

日常使用 `open`；普通启动会把旧原生连接迁移到同一家 ACP，保留超时，清除旧模型固定值。仅在明确的适配器兼容障碍下，使用 `restart --agent codex` 或 `restart --agent claude` 临时兼容，不因登录、额度、限流失败自动改用 CLI。诊断自定义适配器时可用 `--acp-bin` 绝对路径与逐项 `--acp-arg`；Windows 使用 `node.exe` 加真实 JS 入口，不传 shell 命令字符串。

可用环境变量设置同一配置：`GFT_CODEX_ACP_BIN` / `GFT_CODEX_ACP_ARGS`，或 `GFT_CLAUDE_ACP_BIN` / `GFT_CLAUDE_ACP_ARGS`。参数变量是 JSON 字符串数组，例如 `["D:/adapters/package/dist/index.js"]`。这只是格式示例，应核对已安装包的真实入口，不猜路径。用 `--timeout-seconds 900` 设置超时。ACP 始终使用厂商默认；`--model MODEL` 仅用于原生 CLI 诊断。

检查会核对协议、创建新会话、选择只读模式并检查模型配置。成功不等于模型服务接受了登录或已有额度；仍需用合成材料完成一次任务并回读结果。认证失败时指导用户在对应 Agent 登录，不重复重试、不猜模型名、不偷偷换付费服务。Codex 从适配器读取推荐模型及其默认强度；Claude 明确使用 default 模型与自动强度。不沿用个人调高的配置，不修改全局设置，不把默认说成最便宜。来源读取仍只支持 Codex 和 Claude Code。

连接组件的完整依赖树随包锁定，安装使用 `npm ci --ignore-scripts`；页面先启动，准备完成后才启用 AI。失败原因与经脱敏的 npm 退出码、尾部输出写入数据目录的 `adapters/install-errors.log`，日志轮换限制增长。损坏缓存只有在新安装完整后才被替换。
