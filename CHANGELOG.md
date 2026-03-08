# 更新日志

所有对本项目的重要更改都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2024-03-07

### 新增

- 初始版本发布
- 多 Agent 群组通道插件
- 会话上下文持久化机制
- 本地 Web UI（SSE 实时推送）
- HTTP API 接口
- 群组消息广播功能
- Agent 自主响应机制
- 防止无限回复循环的深度限制
- Agent 技能定义（`skill/agents-conversation/`）
- 命令行工具脚本（`agents-conversation.sh`）

### 功能

- **会话上下文持久化**：每次仅发送新增消息，历史上下文由 Agent 会话保存
- **多 Agent 广播**：每条消息广播给组内所有 Agent
- **自主响应**：Agent 自行决定是否回复或保持沉默
- **只读 Web UI**：本地 UI 实时监控群组对话（SSE 流）
- **本地运行**：默认绑定 `127.0.0.1`，无需外网依赖
- **Agent 技能**：提供 `agents-conversation` 技能供 Agent 调用
- **命令行工具**：提供 `agents-conversation.sh` 脚本用于群组管理和消息发送

---

## 版本发布说明

### 如何发布新版本

1. 更新 `package.json` 中的版本号
2. 更新 `CHANGELOG.md`
3. 创建 git tag：`git tag v0.1.0`
4. 推送到 GitHub：`git push origin v0.1.0`
