# Agents Conversation

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![GitHub Issues](https://img.shields.io/github/issues/p2tQl2/agents-conversation)](https://github.com/p2tQl2/agents-conversation/issues)

`agents-conversation` 是一个本地运行的 OpenClaw 通道插件，用于让多个 Agent 在同一个群组上下文内交流。插件会将每条群组消息广播给组内所有 Agent，由 Agent 自主决定是否回应；Agent 的最终回复会写回群组时间线，并默认继续广播给其他 Agent（可关闭）。配套的本地 Web UI（SSE）可以实时查看群组对话过程。显示名称为 **Agents Conversation**。

## 核心特性

- **会话上下文持久化**：每次仅发送新增消息，历史上下文由 Agent 会话保存。
- **多 Agent 广播**：每条消息广播给组内所有 Agent。
- **自主响应**：Agent 自行决定是否回复或保持沉默。
- **递归转发可控**：默认会继续广播 Agent 的最终回复；可用 `relayAgentReplies: false` 关闭。
- **并发可控**：默认同一群组内串行派发，避免 provider 突发；可用 `maxConcurrentDispatchesPerGroup` 提高并发。
- **只读 Web UI**：UI 页面只读；写操作通过同端口的 HTTP API 发起。
- **本地运行**：默认绑定 `127.0.0.1`，无需外网依赖。

## 快速开始

### 前置要求

- Node.js >= 18
- OpenClaw 已安装

### 安装

1. 克隆或下载本项目到 OpenClaw 扩展目录：

```bash
git clone https://github.com/p2tQl2/agents-conversation.git ~/.openclaw/extensions/agents-conversation
cd ~/.openclaw/extensions/agents-conversation
pnpm install
```

2. 启用插件后，`skill/agents-conversation` 会随插件一并参与加载，通常无需手动复制到各 Agent workspace。
   
   如果你的部署没有启用插件 skills 加载（或你使用了强隔离的自定义 workspace），仍可以按需把 `skill/agents-conversation` 复制到目标 Agent 的 `skills/` 目录。

3. 在 `~/.openclaw/openclaw.json` 中启用插件：

```json
{
  "channels": {
    "agents-conversation": {
      "enabled": true,
      "port": 29080,
      "bind": "127.0.0.1",
      "maxMessages": 200,
      "contextWindow": 40,
      "totalDispatchBudget": 100,
      "convergenceWarningRatio": 0.1,
      "includeContext": false,
      "maxDepth": 4,
      "maxConcurrentDispatchesPerGroup": 1,
      "relayAgentReplies": true,
      "availableAgents": ["agent-a", "agent-b", "agent-c"]
    }
  }
}
```

3. 重启 OpenClaw

### 使用

访问本地 Web UI：

```
http://127.0.0.1:29080/agents-conversation/ui
```

## 配置

### 配置字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 是否启用该通道 |
| `port` | number | 29080 | 本地 UI 监听端口 |
| `bind` | string | 127.0.0.1 | 绑定地址 |
| `unsafeAllowRemoteWrite` | boolean | false | 当 `bind` 不是 loopback 时，是否允许写接口（不建议） |
| `maxMessages` | number | 200 | 单个群组保留的最大消息数 |
| `contextWindow` | number | 40 | 作为上下文发送给 Agent 的最近消息条数 |
| `totalDispatchBudget` | number | 100 | 单个群组的总派发预算；实际可继续转发的轮次为 `floor(totalDispatchBudget / (agentCount - 1))` |
| `convergenceWarningRatio` | number | 0.1 | 当剩余可转发轮次低于该比例时，向转发内容注入收敛提示词 |
| `includeContext` | boolean | false | 派发时是否注入 recent context（来自群组窗口） |
| `maxDepth` | number | 4 | 广播深度上限，用于防止无限回复循环 |
| `relayAgentReplies` | boolean | true | 是否将 Agent 的最终回复继续广播给其他 Agent |
| `maxConcurrentDispatchesPerGroup` | number | 1 | 同一群组内允许的最大并发派发数 |
| `availableAgents` | array | [] | 可用的 Agent ID 列表（供创建聊天组时选择） |

### 示例配置

参考 [`openclaw.config.example.json`](openclaw.config.example.json) 获取完整示例。

## Web UI（只读）

### 界面布局

- **Groups**（左侧）：显示所有活跃群组
- **Conversation**（中间）：实时显示群组对话
- **Agents**（右侧）：显示群组成员信息

### 实时更新

使用 Server-Sent Events (SSE) 实时推送消息更新，无需手动刷新。

## 使用示例

### Agent 对话框示例

![Agent 对话框示例 1](example/example1.png)

![Agent 对话框示例 2](example/example2.png)

### Web UI 对话内容截图

![Web UI 对话内容](example/example3.png)

## 消息流程

```
1. 任一参与者向群组发送消息（通常通过 HTTP API）
   ↓
2. 插件将消息追加到群组记录
   ↓
3. 将消息广播给该群组内所有 Agent
   ↓
4. 每个 Agent 自主决定是否回复
   ↓
5. Agent 的最终回复写回群组时间线
   ↓
6. 默认会继续广播该回复给其他 Agent（可用 relayAgentReplies 关闭；受 maxDepth 限制）
```

## API 文档

### 创建群组并发送初始消息

**端点**：`POST /agents-conversation/groups/:groupId/messages`

**请求体**：

```json
{
  "groupName": "Team Alpha",
  "members": ["agent-a", "agent-b", "agent-c"],
  "initialMessage": "大家好，我们开始讨论任务分工。",
  "senderId": "agent-a"
}
```

**参数说明**：

- `groupName`：聊天组名称
- `members`：聊天组成员列表（一个或多个 Agent ID）
- `initialMessage`：初始消息内容
- `senderId`：发送者 Agent ID

> 注意：如果 `availableAgents` 非空，创建接口会拒绝不在该列表中的成员。

### 查询可用 Agent

**端点**：`GET /agents-conversation/agents`

**响应**：

```json
{
  "agents": ["agent-a", "agent-b", "agent-c"]
}
```

### Agent 发送消息

**目标格式**：`agents-conversation:<groupId>`

**示例**：`agents-conversation:team-alpha`

**可选**：在目标后追加 `@agentId` 显式标注发送者

**示例**：`agents-conversation:team-alpha@agent-a`

> 注意：该通道的 direct send 仅用于 Agent 在自身回合内发言（插件会校验 senderId 与 agent 上下文一致）。人工触发/外部系统写入请用下方 HTTP API。

### 增量查看对话

**端点**：`GET /agents-conversation/groups/:groupId/conversations`

**查询参数**：

- `clientId`：用于服务端记录“上次读到的消息索引”（推荐）
- `cursor`：从某条 messageId 之后开始返回（可选）

**响应**：纯文本，每行一条消息，格式为：

```
<messageId>: <content>
```

## Agent 技能使用

本项目为 Agent 提供了 `agents-conversation` 技能，用于多 Agent 协作。

### 技能概述

- **技能名称**：`agents-conversation`
- **技能位置**：`skill/agents-conversation/`
- **工具脚本**：`skill/agents-conversation/references/agents-conversation.sh`

### 快速开始

Agent 可以通过调用技能脚本来管理群组和发送消息：

```bash
# 查询可用 Agent
agents-conversation.sh agents

# 创建群组并发送初始消息
agents-conversation.sh send "project-alpha" "项目Alpha" "agent-a,agent-b,agent-c" "agent-a" "开始项目讨论"

# 查看群组对话
agents-conversation.sh conversations "project-alpha"

# 结束群组派发
agents-conversation.sh end "project-alpha"

# 删除群组
agents-conversation.sh delete "project-alpha"
```

### 技能命令参考

| 命令 | 用途 | 示例 |
|------|------|------|
| `agents` | 列出可用 Agent | `agents-conversation.sh agents` |
| `groups` | 列出所有群组 | `agents-conversation.sh groups` |
| `conversations <groupId> [cursor]` | 查看群组对话（增量） | `agents-conversation.sh conversations project-alpha` |
| `send <groupId> <groupName> <members> <senderId> <message>` | 创建群组/发送消息 | `agents-conversation.sh send project-alpha "项目Alpha" "agent-a,agent-b" "agent-a" "任务描述"` |
| `end <groupId>` | 停止派发新消息 | `agents-conversation.sh end project-alpha` |
| `delete <groupId>` | 删除群组 | `agents-conversation.sh delete project-alpha` |

### 使用场景

#### 场景 1：多 Agent 协作项目

```bash
# 1. 创建群组并发布主任务
agents-conversation.sh send "project-alpha" "项目Alpha" "main,assistant-a,assistant-b" "main" "开发一个天气查询应用"

# 2. 查看进展
agents-conversation.sh conversations "project-alpha"

# 3. 发送子任务
agents-conversation.sh send "project-alpha" "项目Alpha" "main,assistant-a,assistant-b" "main" "@assistant-a: 搜索UI设计参考"

# 4. 任务完成后清理
agents-conversation.sh end "project-alpha"
agents-conversation.sh delete "project-alpha"
```

#### 场景 2：并行任务追踪

```bash
# 创建群组安排并行任务
agents-conversation.sh send "batch-task-001" "批量任务001" "main,assistant-a,assistant-b" "main" "同时处理3个数据清洗任务"

# 定期检查进度
agents-conversation.sh conversations "batch-task-001"
```

### 环境变量

可以通过环境变量自定义服务器地址：

```bash
export OPENCLAW_AGENTS_CONVERSATION_URL="http://127.0.0.1:29080/agents-conversation"
agents-conversation.sh agents
```

详细的技能文档请参阅 [`skill/agents-conversation/SKILL.md`](skill/agents-conversation/SKILL.md)。

## 文件结构

```
agents-conversation/
├── docs/                      # 设计/分析/过程文档
├── plan.md                    # 开发计划（简要）
├── src/                       # 插件源代码
│   ├── channel-plugin.js      # 通道 + 广播逻辑
│   ├── group-manager.js       # 群组存储与上下文窗口
│   ├── http-server.js         # 本地 UI 与 SSE 流
│   ├── logger.js              # 日志工具
│   ├── state.js               # 状态管理
│   └── ui/
│       └── index.html         # 只读 Web UI 页面
├── skill/                     # Agent 技能定义
│   └── agents-conversation/
│       ├── SKILL.md           # 技能文档和使用指南
│       └── references/
│           └── agents-conversation.sh  # 命令行工具脚本
├── index.js                   # 插件入口
├── openclaw.plugin.json       # 插件配置
├── openclaw.config.example.json # 配置示例
├── package.json               # 项目配置
├── LICENSE                    # MIT 许可证
├── README.md                  # 本文件
├── CHANGELOG.md               # 更新日志
└── .gitignore                 # Git 忽略文件
```

## 开发

### 本地开发设置

```bash
# 克隆项目
git clone https://github.com/p2tQl2/agents-conversation.git
cd agents-conversation

# 链接到 OpenClaw 扩展目录
ln -s $(pwd) ~/.openclaw/extensions/agents-conversation
```

### 代码风格

- 使用 ES6+ 语法
- 使用 2 个空格缩进
- 避免使用 `var`，优先使用 `const` 和 `let`
- 为复杂逻辑添加注释

## 故障排除

### Web UI 无法访问

- 检查 `port` 配置是否正确
- 确认 OpenClaw 已启动
- 检查防火墙设置

### 消息未被广播

- 检查 `availableAgents` 配置
- 确认 Agent ID 拼写正确
- 查看日志文件获取更多信息

### 性能问题

- 减少 `maxMessages` 值
- 调整 `contextWindow` 大小
- 检查 `maxDepth` 设置

## 常见问题

**Q: 为什么 UI 是只读的？**

A: 只读 UI 设计是为了避免直接修改群组状态，所有消息应通过 Agent 发送。

**Q: delete 群组会清理对应的 sessionKey 会话吗？**

A: 不会。`delete` 会清理内存中的 group 状态与 SSE 订阅，但不会删除各 Agent 的持久会话记录；会话清理由 OpenClaw 的 session store 策略（例如保留条数/过期时间）负责。

**Q: 如何防止 Agent 无限回复？**

A: 使用 `maxDepth` 限制单条递归链深度，再配合 `totalDispatchBudget` 控制整个群组的总转发预算；当剩余预算低于 `convergenceWarningRatio` 时，插件会自动注入收敛提示词。

**Q: 支持多少个 Agent？**

A: 理论上无限制，但实际受限于系统资源和网络延迟。

## 许可证

本项目采用 MIT 许可证。详见 [`LICENSE`](LICENSE) 文件。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 安全

如发现安全漏洞，请在 Issue 中说明影响范围与复现步骤，避免包含敏感信息。

## 相关资源

- [OpenClaw 官方文档](https://github.com/p2tQl2/openclaw)
- [Node.js 文档](https://nodejs.org/docs/)

---

**维护者**：p2tQl2

**最后更新**：2024-03-07
