---
name: nslogger-cli
description: >-
  查询移动端 App 日志（NSLogger）以辅助调试：列出会话、筛选/搜索日志、查看错误、
  取某条日志的上下文、按线程/时间范围追踪、导入 .nslogger 文件。当用户说 "看看 App 日志"、
  "有什么错误/崩溃日志"、"nslogger"、"看一下日志会话"、"trace 一下这个线程"、
  "mobile app logs"、"查日志"、"加载 .nslogger 文件" 等涉及移动端日志排查的表达时触发。
  注意：本 skill 只做查询/读取；要实时接收设备日志，请提示用户自行运行 `nslogger-cli serve`。
argument-hint: <optional: session id / keyword / .nslogger file>
user-invocable: true
allowed-tools: Bash, Read
---

# nslogger-cli — 查询移动端 App 日志

`nslogger-cli` 把移动端（NSLogger 协议，经 TCP/Bonjour/SSL 或 `.nslogger` 文件）采集的日志写入一个
共享的 SQLite 库，并提供一组一次性查询命令，便于 AI 辅助排查问题。

**输出约定**：默认输出 JSON，形如 `{"success":true,"data":[...],"total":N}` 到 stdout，退出码 0；
出错时输出 `{"success":false,"message":"..."}` 到 stderr 且退出码非零；空结果返回空数组（不算错误）。
加 `--pretty` 可得人类可读格式。解析时取 `data` 数组，用 `total` 判断是否有数据。

## Step 0 — 确保二进制可用

每次开始前先确认 `nslogger-cli` 在 PATH 上：

```bash
command -v nslogger-cli >/dev/null 2>&1 || echo "未安装"
```

若缺失，**提示用户按仓库 README 的「安装」一节执行 `bash install.sh`**，安装完成后再继续；
不要在本 skill 内自行构建或绕过。

## 命令速查

先用 `sessions` 拿到 `session_id`，再按需下钻。全部命令复用 CLI 既有参数，**不要臆造新 flag**。

| 意图 | 命令 |
| --- | --- |
| 列出所有日志会话 | `nslogger-cli sessions` |
| 筛选/搜索日志 | `nslogger-cli query [--session ID] [--tag T] [--level N] [--keyword K] [--limit N] [--offset N]` |
| 只看告警/错误 | `nslogger-cli errors [--session ID] [--level N]`（默认 level ≥ 3） |
| 某条日志的上下文 | `nslogger-cli context <log_id> [--before N] [--after N]` |
| 追踪某线程 | `nslogger-cli trace-thread <session_id> <thread_id>` |
| 追踪某时间段（毫秒） | `nslogger-cli trace-range <session_id> --from <ms> --to <ms>` |
| 导入 .nslogger 文件 | `nslogger-cli load <file.nslogger>`（打印新的 `session_id`） |
| 清空某会话（危险） | `nslogger-cli clear <session_id>` |

**全局参数**（任意命令可加）：`--db <path>` 覆盖数据库路径，`--config <path>` 覆盖配置文件，
`--pretty` 人类可读输出。

## 典型排查流程

1. `nslogger-cli sessions` → 选定目标 `session_id`。
2. `nslogger-cli errors --session <id>` 或 `nslogger-cli query --session <id> --keyword <K>` 定位可疑日志。
3. 拿到某条 `log_id` 后用 `nslogger-cli context <log_id>` 看上下文；或用 `trace-thread` /
   `trace-range` 按线程、时间窗下钻。
4. 解析返回的 `data` 数组做分析；若 `total` 为 0，进入下一节。

## 没有数据 / 实时采集（serve 的处理）

本 skill **不**在后台启动 `serve`。当 `sessions` 为空、或用户期望实时设备日志时：

- **提示用户自行运行** 接收端，例如：`nslogger-cli serve`
  （按 `~/.nslogger-cli/config.json` 启用 TCP/Bonjour/SSL，Ctrl-C 停止），启动并产生日志后再回来查询。
- 若用户手头是一份静态抓包文件，改为建议 `nslogger-cli load <file.nslogger>` 导入后查询。

## 注意事项

- `clear` 会删除该会话全部日志，**执行前先与用户确认**。
- 数据库默认在 `~/.nslogger-cli/logs.db`；`serve`（写入方）与查询命令（读取方）共享同一个库。
- 配置查找顺序：`--config` → 环境变量 `$NSLOGGER_CLI_CONFIG` → `~/.nslogger-cli/config.json` →
  当前目录 `./config.json`。
