# nslogger-cli

把移动端 App 日志接入 AI 工具的命令行工具。Claude Code、Cursor 等可以直接用 Bash
调用 `nslogger-cli` 查询、分析移动端日志,实现 AI 辅助调试。

初始实现基于 [NSLogger](https://github.com/fpillet/NSLogger),架构上支持扩展到任意日志来源。

## 工作原理

```
Mobile App (NSLogger)
      │  .nslogger 文件 / TCP 实时流
      ▼
┌─────────────────────── nslogger-cli ───────────────────────┐
│  serve(前台)  Sources ──▶ SQLite ◀── 查询子命令(只读)     │
└───────────────────────────────────────────────────────────┘
      │  stdout: JSON
      ▼
AI 工具(Bash 调用) / 人(--pretty)
```

摄取与查询共享同一个 SQLite。`serve` 是长驻前台进程,负责接收日志写入 SQLite;
查询子命令只读地打开同一个库。

## 安装

需要 Node.js >= 18。在仓库根目录执行:

```bash
bash install.sh
```

脚本会依次执行 `npm install` → `tsc` 构建 → `npm link`(把 `nslogger-cli` 注册为全局命令),
并在 `~/.nslogger-cli/config.json` 写入默认配置。脚本幂等,可重复执行。

> 装完若提示找不到 `nslogger-cli`,把 npm 全局 bin 目录加入 PATH:
> `echo "$(npm prefix -g)/bin"`。
>
> 若构建失败(如 Node < 18、原生模块 `better-sqlite3` 编译报错),请先解决环境问题再重试,
> 不要绕过。

## 配置

默认配置在 `~/.nslogger-cli/config.json`:

```json
{
  "db_path": "~/.nslogger-cli/logs.db",
  "watch_dirs": [],
  "sources": {
    "nslogger_file": { "enabled": true },
    "nslogger_tcp": { "enabled": false, "port": 50000, "bonjour": true, "ssl": true }
  }
}
```

配置查找顺序:`--config` > `$NSLOGGER_CLI_CONFIG` > `~/.nslogger-cli/config.json` > `./config.json`。
查询类命令也可以直接用 `--db <path>` 指定数据库,无需完整配置。

| 字段 | 说明 |
| --- | --- |
| `db_path` | SQLite 数据库路径(自动创建) |
| `watch_dirs` | `serve` 时自动监听的目录,放入 `.nslogger` 文件即导入 |
| `nslogger_tcp.enabled` | 是否启用 TCP 实时接收(每个连接 = 一个 session) |
| `nslogger_tcp.port` | TCP 监听端口(默认 50000) |
| `nslogger_tcp.bonjour` | 是否通过 Bonjour 广播,局域网客户端零配置自动发现 |
| `nslogger_tcp.ssl` | 是否启用 SSL/TLS(默认 `true`,贴合 NSLogger 客户端默认)。`true` 时广播 `_nslogger-ssl._tcp` 并用自签证书(客户端不校验);`false` 为纯 TCP `_nslogger._tcp` |

## 用法

### 一次性读文件(推荐)

```bash
nslogger-cli load ~/Downloads/app.nslogger        # 导入,打印 session_id
nslogger-cli query --keyword InspirationFeed --pretty
```

### 实时接收(TCP)

1. 编辑 `~/.nslogger-cli/config.json`,设 `nslogger_tcp.enabled = true`。
2. 启动前台接收进程(放在一个单独终端,Ctrl-C 停止):

   ```bash
   nslogger-cli serve
   ```

3. App 端集成 NSLogger 客户端(默认 SSL 即可直连):

   ```swift
   // 默认即可:NSLogger 客户端默认带 SSL,serve 默认也开 SSL,两边在 _nslogger-ssl._tcp 上相遇
   LoggerSetupBonjour(nil, nil, "nslogger-cli" as NSString)  // 名字需与 serve 的 service_name 一致(默认 nslogger-cli)
   LoggerStart(nil)
   LogMessage("network", 2, "hello from device")
   ```

   > Bonjour 名字必须对上:客户端 `LoggerSetupBonjour` 的第三个参数要等于 serve 广播的名字(默认 `nslogger-cli`;可在配置里加 `"service_name": "<自定义名>"` 修改)。
   >
   > 若把 serve 配成 `"ssl": false`(纯 TCP),客户端需相应关闭 SSL:
   > `LoggerSetOptions(nil, UInt32(kLoggerOption_BufferLogsUntilConnection | kLoggerOption_BrowseBonjour))`,再调用 `LoggerSetupBonjour` / `LoggerStart`。
   >
   > 不想用 Bonjour 就直连:`LoggerSetViewerHost(nil, "<Mac 局域网 IP>" as NSString, 50000)`(SSL 模式同样适用)。

4. 另开终端查询:`nslogger-cli query --keyword ... --pretty`。

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `serve` | 启动接收(TCP + 文件监听),前台运行 |
| `sessions` | 列出所有 session |
| `query [--session --tag --level --keyword --limit --offset]` | 过滤查询日志 |
| `context <log_id> [--before --after]` | 某条日志前后的上下文 |
| `trace-thread <session_id> <thread_id>` | 某线程的完整日志 |
| `trace-range <session_id> --from <ms> --to <ms>` | 时间段内的日志 |
| `errors [--session --level]` | warn/error 日志(默认 level≥3) |
| `load <file.nslogger>` | 导入文件,打印 session_id |
| `clear <session_id>` | 删除一个 session |
| `help [--json]` | 帮助(`--json` 输出机器可读的命令清单) |

全局选项:`--db <path>`、`--config <path>`、`--pretty`(默认输出 JSON)。

## 启用 Claude Code skill

本仓库自带一个 Claude Code skill(`skills/nslogger-cli/`),让 Claude 能自动识别"看日志"类
意图并调用 `nslogger-cli`。它放在独立目录 `skills/nslogger-cli/` 下,**不在** `.claude/skills/`,
因此不会被 Claude Code 自动发现。要启用,把这个目录软链或复制到 skills 搜索路径:

```bash
# 全局可用(所有项目)
ln -s "$(pwd)/skills/nslogger-cli" ~/.claude/skills/nslogger-cli

# 或仅对某个项目可用
ln -s "$(pwd)/skills/nslogger-cli" <目标项目>/.claude/skills/nslogger-cli
```

> 用软链(`ln -s`)便于随仓库更新;也可以直接 `cp -r` 复制。

## 给 AI 工具用

`nslogger-cli` 默认输出 JSON,成功 `{ "success": true, "data": [...], "total": N }` 到 stdout、
退出码 0;出错输出 `{ "success": false, "message": "..." }` 到 stderr、非 0 退出码。
查空库返回空数组(非错误)。需要枚举命令时跑 `nslogger-cli help --json`。

常用:

```bash
nslogger-cli sessions
nslogger-cli query --session <id> --keyword <text>
nslogger-cli errors --session <id>
```
