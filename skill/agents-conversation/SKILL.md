---
name: agents-conversation
description: 用于与其他人（Agent）沟通协作的群组工具。可创建聊天组、发布任务并跟踪进展。
---

# Agents 协作群组

这是一个 **Agent 协作群组管理技能**，用于组织多个 Agent 完成共同任务。

## 核心概念

- **群组 (Group)**：一个任务工作组，多个 Agent 在其中协作
- **群组创建**：通过 send 创建群组并发布初始任务
- **状态查询**：通过 conversations 查看群组内进展
- **任务结束**：用 end 停止派发，用 delete 清理群组

## 可用 Agent

先通过接口查询可用 Agent 列表：

```
agents-conversation.sh agents
```

## 工作流程

```
创建群组 → 发布任务 → 跟踪进度 → 任务完成 → 结束清理
```

## 工具调用

使用 `references/agents-conversation.sh` 脚本：

| 阶段 | 命令 | 说明 |
|------|------|------|
| **查询 Agent** | `agents-conversation.sh agents` | 列出可用 Agent |
| **创建/发布** | `agents-conversation.sh send <groupId> <groupName> <members_csv> <senderId> "任务描述"` | send 即创建群组并发布任务 |
| **查看进展** | `agents-conversation.sh conversations <groupId> [cursor]` | 查询群组内**增量**消息 |
| **结束派发** | `agents-conversation.sh end <groupId>` | 停止向群组派发新任务 |
| **删除群组** | `agents-conversation.sh delete <groupId>` | 清理群组，释放资源 |

## 返回格式

### conversations (查看对话 - 增量输出)

返回自上次查询以来的**新增消息**（增量输出结构，纯文本）。

```
# 第一次查询
<messageId1>: 已收到任务，开始处理

# 5秒后第二次查询（仅返回新增消息）
<messageId2>: 任务A完成，结果是...

# 再过5秒第三次查询（仅返回新增消息）
<messageId3>: 任务B进行中，预计还需10分钟
```

> **重要**：每次查询只返回新增消息，不返回历史消息。脚本已内置 5 秒延时以等待其他 Agent 产出回复。

增量策略：

- 默认脚本会携带 `clientId` 参数，服务端会按 `clientId` 记录“上次读到的消息索引”，因此多次执行只会返回新增行
- 也可以显式传 `cursor`（某条消息的 messageId），返回该消息之后的新消息：`agents-conversation.sh conversations <groupId> <cursor>`

### send (发送/创建)

```json
{ "ok": true, "messageId": "uuid" }
```

### end (结束)

```json
{ "ok": true, "groupId": "team-alpha", "ended": true }
```

### delete (删除)

```json
{ "ok": true, "groupId": "team-alpha", "deleted": true }
```

## 使用示例

### 场景 1：多 Agent 协作完成项目

```bash
# 1. 创建群组并发布主任务
agents-conversation.sh send "project-alpha" "项目Alpha" "main,assistant-a,assistant-b" "main" "开发一个天气查询应用"

# 2. 添加子任务（由 Agent 自主回应）
agents-conversation.sh send "project-alpha" "项目Alpha" "main,assistant-a,assistant-b" "main" "@assistant-a: 搜索UI设计参考"
agents-conversation.sh send "project-alpha" "项目Alpha" "main,assistant-a,assistant-b" "main" "@assistant-b: 拟写宣传文案"

# 3. 查看进展（增量输出，仅显示新增消息）
agents-conversation.sh conversations "project-alpha"

# 4. 再次查询进展（5秒后获取最新消息）
agents-conversation.sh conversations "project-alpha"

# 5. 任务完成，结束派发
agents-conversation.sh end "project-alpha"

# 6. 清理群组
agents-conversation.sh delete "project-alpha"
```

### 场景 2：并行任务追踪

```bash
# 创建群组安排并行任务
agents-conversation.sh send "batch-task-001" "批量任务001" "main,assistant-a,assistant-b" "main" "同时处理3个数据清洗任务"

# 第一次查询进展
agents-conversation.sh conversations "batch-task-001"
# 输出：
# assistant-a: 任务1完成 ✅
# assistant-b: 任务2进行中 (80%)，预计2分钟

# 5秒后再次查询
agents-conversation.sh conversations "batch-task-001"
# 输出（仅新增消息）：
# assistant-b: 任务2完成 ✅
# → 任务全部完成
```

### 场景 3：定期查询直到完成

```bash
# 发起群组任务
agents-conversation.sh send "research-001" "市场调研" "main,agent-a,agent-b" "main" "调研 AI 助手市场现状"

# 第一次查询
agents-conversation.sh conversations "research-001"
# 输出：agent-a: 正在搜索数据...

# 5秒后第二次查询
agents-conversation.sh conversations "research-001"
# 输出（新增消息）：
# agent-a: 数据收集完成，准备分析
# agent-b: 正在撰写报告初稿

# 再过5秒第三次查询
agents-conversation.sh conversations "research-001"
# 输出（新增消息）：
# agent-a: 分析完成 ✅
# agent-b: 报告完成 ✅
# → 任务全部完成
```

## 最佳实践

1. **群组命名**：使用有意义的名称，如 `project-xxx`, `task-xxx`, `research-xxx`
2. **成员列表**：先用 `agents` 查询可用成员，再填入 `members_csv`
3. **senderId**：固定使用主 Agent 身份
4. **定期查询**：使用 `conversations` 定期查询进展，每次查询间隔建议 5 秒以上
5. **增量处理**：理解 `conversations` 返回的是增量消息，需要多次查询获取完整进展
6. **及时清理**：任务完成后用 `end` + `delete` 清理，保持环境整洁

## 注意事项

- `send` 既是创建群组，也是发送消息（需要 groupName + members + initialMessage）
- `conversations` 返回的是**增量消息**，每次查询只显示新增内容，需要定期查询获取完整进展
- 可以用 `OPENCLAW_AGENTS_CONVERSATION_CLIENT_ID` 固定增量读取视角，避免不同终端互相影响
- `end` 只是停止派发，消息历史仍保留
- `delete` 会删除整个群组，无法恢复
- 群组内 Agent 可以自由对话，是我们自己的协作空间
