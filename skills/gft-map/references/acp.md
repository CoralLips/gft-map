# ACP 任务连接

`codex-acp` 与 `claude-acp` 使用 ACP 协议连接各自适配器。SDK 随 Skill 打包；适配器本体需已在本机安装并满足它自己的 Node.js 与认证要求。Claude ACP 0.78.0 要求 Node.js 22 或更高版本，不能因本工具支持 Node.js 20 就认定适配器也支持。

```text
node scripts/cli.mjs doctor --agent codex-acp
node scripts/cli.mjs serve --agent codex-acp --port 4317
```

另一入口将 `codex-acp` 改为 `claude-acp`。用户已经授权启用并选定 Agent 时，检查和启动属于同一次操作，不再额外确认。

默认命令为 `codex-acp` 或 `claude-agent-acp`。需要指定程序时，使用 `--acp-bin` 的绝对路径，并逐项重复 `--acp-arg`。Windows 可传 `node.exe` 加官方 npm 包 `bin` 字段指向的 JavaScript 入口；不传 `.cmd` / `.bat`，不使用 shell 命令字符串。

可用环境变量设置同一配置：`GFT_CODEX_ACP_BIN` / `GFT_CODEX_ACP_ARGS`，或 `GFT_CLAUDE_ACP_BIN` / `GFT_CLAUDE_ACP_ARGS`。参数变量是 JSON 字符串数组，例如 `["D:/adapters/package/dist/index.js"]`。这只是格式示例，应核对已安装包的真实入口，不猜路径。可选 `--model MODEL` 和 `--timeout-seconds 900` 分别请求模型和设置超时。

检查会核对协议、创建新会话、选择只读模式并检查模型配置。成功不等于模型服务接受了登录或已有额度；仍需用合成材料完成一次任务并回读结果。认证失败时指导用户在对应 Agent 登录，不重复重试、不猜模型名、不偷偷换付费服务。默认使用适配器实际返回的模型，显式 --model 仅能选适配器声明支持的项。不要承诺所有 Agent 的聊天来源都已适配；来源读取仍只支持 Codex 和 Claude Code。
