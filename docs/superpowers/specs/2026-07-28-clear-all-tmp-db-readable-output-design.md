# Design: clear --all / /tmp DB / 可读输出 + watch TUI

Date: 2026-07-28
Status: Approved

## Background

`nslogger-cli` 现状：

- `clear` 只能按 session 删（`src/commands/query.ts:75`）。
- 默认 DB 在 `~/.nslogger-cli/logs.db`（`src/config.ts:45`、`config.json`），永久占用 home 目录，需要手动清理。
- `--pretty` 把每条日志整行打全（`src/cli/output.ts:42`），`query` 默认 limit 100，一次输出 100 条完整长文本，终端里无法阅读。
- 所有查询命令都是一次性返回后退出，没有持续跟随新日志的能力。

本设计解决这四点。默认 JSON 输出（AI 通过 Bash 调用的那条路）保持不变。

## 1. `clear --all`

`nslogger-cli clear --all` 删除全部 sessions 与 logs，返回：

```json
{ "success": true, "data": { "cleared_sessions": 12, "cleared_logs": 84213 } }
```

- `clear <session_id>` 行为不变，返回 `{ "cleared": "<session_id>" }`。
- `--all` 与位置参数互斥：同时给出报错；两者都不给报错（保持现有 `clear requires a <session_id>` 的语义，补充提示 `--all`）。
- 不做二次确认。日志是可再生的缓存数据，交互式确认会让非 TTY 的 AI 调用挂死。
- store 层新增 `clearAll(): { sessions: number; logs: number }`，单事务内先 `DELETE FROM logs` 再 `DELETE FROM sessions`，返回两次 `run()` 的 `changes`。

## 2. 默认 DB 路径改为 `/tmp`

新默认：`/tmp/nslogger-cli/logs.db`。

需要同步修改的位置：

| 位置 | 改动 |
| --- | --- |
| `nslogger-cli/config.json` | 模板 `db_path` |
| `src/config.ts` `resolveDbPath` 兜底 | `join(homedir(), '.nslogger-cli', 'logs.db')` → `/tmp/nslogger-cli/logs.db` |
| `install.sh` 结尾说明 | DB 路径行 + 旧配置提示 |
| `README.md` / `README.zh.md` | 配置表与示例 |
| `skills/nslogger-cli/SKILL.md` | 如提及路径则同步 |

约束与副作用：

- **不自动迁移**已存在的 `~/.nslogger-cli/logs.db`，**不改写**用户已有的 `~/.nslogger-cli/config.json`（`install.sh` 本来就只在文件不存在时才 copy）。install.sh 输出追加一行提示：已有配置仍指向 home，需手动改 `db_path` 才切换。
- macOS 的 `/tmp` 实体为 `/private/tmp`，系统定期清理 3 天未访问的文件；WAL/SHM 文件与 DB 同目录，会被一并清除，不留残渣。这正是本改动的目的。
- DB 被系统清除后，所有查询命令会命中 `mustExist` 检查报 `database not found at <path>`。该报错文案改为带下一步动作：
  `database not found at <path> — run 'nslogger-cli load <file.nslogger>' or start 'nslogger-cli serve' first`。

## 3. `query --pretty` 精简单行输出

`formatLogLine` 改为定宽单行，按 `process.stdout.columns`（无值时按 120）截断：

```
#1042  12:03:11.482  E  [Feed]  request failed: timeout after 30s…⏎+3
#1043  12:03:11.501  W  [Feed]  retry 1/3 scheduled
... 100 shown, 214 total (use --offset / --limit for the rest)
```

规则：

- 字段顺序固定：`#id`、`HH:mm:ss.SSS`（本地时区）、级别首字母（N/D/I/W/E）、`[tag]`（无 tag 时省略该列的括号但保留列宽）、message。
- message 只取第一行；若原文有多行，行尾追加 `⏎+N` 标注剩余行数。
- 超出终端宽度的部分截断并以 `…` 结尾。
- 结果集尾部输出汇总行 `... N shown, M total (use --offset / --limit for the rest)`，`N` 为本次返回条数、`M` 为 `CommandResult.total`；两者相等时仅输出 `M total`。
- 打出 `id` 是为了衔接 `context <id>` 与 TUI 内定位。
- 非 log 类型的 `--pretty` 输出（sessions 等）行为不变。
- **默认 JSON 输出路径完全不变。**

## 4. `watch` — 交互式 TUI，内置 follow

新命令：

```
nslogger-cli watch [--session <id>] [--tag <t>] [--level <n>] [--keyword <k>] [--db <path>] [--config <path>]
```

进入后先渲染已匹配的存量日志，再持续把新日志追加到列表底部。

### 实现方式

零依赖手写 ANSI：`process.stdin` raw mode + 转义序列，约 300 行。不引入 ink（会拖进整个 React 运行时）与 blessed（已停止维护）。

### 数据来源

轮询 SQLite，与 `serve` 完全解耦：

- 新增 `LogStore.queryLogsAfter(afterId, filters, limit)`，SQL 为
  `SELECT * FROM logs WHERE id > @after_id AND <filters> ORDER BY id ASC LIMIT @limit`，`limit` 默认 500。
- 轮询间隔 500ms，游标为已见的最大 `id`。
- 由此，TCP 实时流、`load` 导入、以及其他进程跑的 `serve` 三种写入都能被看到，**不需要改 `serve` 一行代码**。

### 交互

| 按键 | 行为 |
| --- | --- |
| `↑` / `↓` | 移动选中行 |
| `⏎` | 展开/收起当前行（展开显示 `filename:line_number`、`function_name`、`thread_id`、完整多行 message） |
| `/` | 进入过滤输入行，回车后对存量与增量同时生效（重置游标并重查） |
| `f` | 暂停/恢复跟随（暂停时新日志仍入缓冲，只是不自动滚到底） |
| `g` / `G` | 跳到顶部 / 底部 |
| `q` / `Ctrl-C` | 退出，恢复终端（关闭 raw mode、显示光标、退出 alternate screen） |

### 约束

- 内存上限 5000 条环形缓冲，超出丢弃最老的条目。
- 非 TTY（`!process.stdout.isTTY`）时直接报错退出：`watch requires an interactive terminal — use 'nslogger-cli query' instead`。防止被管道或 AI 调用时挂死。
- 退出路径（正常退出、`Ctrl-C`、未捕获异常）都必须恢复终端状态。

## 模块划分

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `src/tui/render.ts` | 纯函数：`(state, width, height) => string[]`，不做任何 IO | 无 |
| `src/tui/app.ts` | 状态机：缓冲区、选中项、展开集合、过滤条件、按键归约 | `render.ts` |
| `src/commands/watch.ts` | 装配：轮询 store、驱动 app、写终端、清理 | `app.ts`、`LogStore` |
| `src/store/sqlite.ts` | 新增 `clearAll()`、`queryLogsAfter()` | — |
| `src/cli/output.ts` | 单行格式化与截断改造 | — |

`render.ts` 是纯函数是刻意设计：TUI 的可测试部分全部集中在这里。

## 测试

`node --test test/*.test.mjs`（沿用现有方式）：

- `clearAll()`：插入两个 session 后清空，断言返回计数与表为空。
- `queryLogsAfter()`：游标推进、过滤条件组合、limit 生效。
- 单行格式化：截断、多行 `⏎+N` 标注、无 tag、汇总行文案。
- `render.ts`：给定 state 断言输出行（选中态、展开态、过滤提示行）。

不测：键盘输入、轮询定时器、终端转义序列的实际渲染效果。

## 非目标

- 不自动迁移旧 DB。
- 不做非交互的流式 `tail` 命令（已确认由 TUI 内置 follow 覆盖）。
- 不改动 `serve`、TCP/文件解析、SQLite schema。
