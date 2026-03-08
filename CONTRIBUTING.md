# 贡献指南

感谢你对 Agents Conversation 项目的兴趣！我们欢迎各种形式的贡献。

## 如何贡献

### 报告问题

如果你发现了 bug 或有功能建议，请在 GitHub Issues 中创建一个新的 issue。请提供：

- 清晰的问题描述
- 复现步骤（如果是 bug）
- 预期行为和实际行为
- 你的环境信息（Node.js 版本、操作系统等）

### 提交代码

1. **Fork 项目**
   ```bash
   git clone https://github.com/your-username/agents-conversation.git
   cd agents-conversation
   ```

2. **创建特性分支**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **进行更改**
   - 遵循现有代码风格
   - 添加必要的注释和文档
   - 确保代码可读性

4. **测试你的更改**
   ```bash
   npm test
   ```

5. **提交 commit**
   ```bash
   git commit -m "feat: add your feature description"
   ```
   
   使用以下 commit 类型前缀：
   - `feat:` 新功能
   - `fix:` 修复 bug
   - `docs:` 文档更新
   - `style:` 代码风格调整
   - `refactor:` 代码重构
   - `test:` 测试相关
   - `chore:` 构建、依赖等维护工作

6. **推送到你的 fork**
   ```bash
   git push origin feature/your-feature-name
   ```

7. **创建 Pull Request**
   - 提供清晰的 PR 描述
   - 关联相关的 issue（如果有）
   - 等待代码审查

### 代码风格

- 使用 ES6+ 语法
- 使用 2 个空格缩进
- 避免使用 `var`，优先使用 `const` 和 `let`
- 添加有意义的变量和函数名称
- 为复杂逻辑添加注释

### 文档

- 更新 README.md 中的相关部分
- 为新功能添加使用示例
- 更新 CHANGELOG.md
- 如果涉及 Agent 技能，更新 `skill/agents-conversation/SKILL.md`

## 开发指南

### 项目结构

```
agents-conversation/
├── src/                       # 插件源代码
│   ├── channel-plugin.js      # 通道插件核心逻辑
│   ├── group-manager.js       # 群组管理
│   ├── http-server.js         # HTTP 服务器
│   ├── logger.js              # 日志工具
│   ├── state.js               # 状态管理
│   └── ui/
│       └── index.html         # Web UI
├── skill/                     # Agent 技能定义
│   └── agents-conversation/
│       ├── SKILL.md           # 技能文档
│       └── references/
│           └── agents-conversation.sh  # 命令行工具
├── index.js                   # 插件入口
├── openclaw.plugin.json       # 插件配置
└── package.json               # 项目配置
```

### 本地开发

1. 安装依赖
   ```bash
   npm install
   ```

2. 将项目链接到 OpenClaw
   ```bash
   ln -s $(pwd) ~/.openclaw/extensions/agents-conversation
   ```

3. 复制 Agent 技能到测试 Agent 的 workspace
   ```bash
   # 为测试 Agent 复制技能
   cp -r skill/agents-conversation ~/.openclaw/agents/<test-agent-id>/workspace/skills/
   ```

4. 启动 OpenClaw 并测试插件

### 插件开发

- **通道插件**：修改 `src/channel-plugin.js` 中的消息广播逻辑
- **HTTP 服务器**：修改 `src/http-server.js` 中的 API 端点
- **Web UI**：修改 `src/ui/index.html` 中的前端界面
- **群组管理**：修改 `src/group-manager.js` 中的群组存储和上下文管理

### Agent 技能开发

- **技能文档**：编辑 `skill/agents-conversation/SKILL.md`
- **命令行工具**：编辑 `skill/agents-conversation/references/agents-conversation.sh`

如果添加新的命令或参数，请：
1. 在 shell 脚本中实现功能
2. 更新 `SKILL.md` 中的命令参考表
3. 添加使用示例

## 许可证

通过提交代码，你同意你的贡献将在 MIT 许可证下发布。

## 行为准则

请参阅 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 了解我们的社区标准。

---

感谢你的贡献！
