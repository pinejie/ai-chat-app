# ZD Code

通过 Web 界面使用 Claude Code CLI，支持流式输出、多会话管理、对话持久化、文件上传、跨天记忆和主题切换。

## 功能

- **流式对话** — WebSocket 实时推送，Markdown 渲染 + 代码高亮
- **多会话并发** — 每个对话独立 WebSocket + 独立 Claude 子进程，互不阻断
- **会话隔离** — 输入历史、输入框内容、流式状态按会话独立存储，切换对话互不干扰
- **对话持久化** — 聊天记录以 JSONL 文件存储，服务重启不丢失
- **跨天记忆** — 优先 `--resume` 恢复短期记忆，失败后自动注入摘要兜底，WebSocket 断开时后台异步生成摘要
- **标题保护** — 用户手动改名后系统不再自动覆盖，向后兼容旧数据
- **文件上传** — 支持图片、PDF、文本、代码文件上传，文件路径自动注入 Claude 上下文
- **五种权限模式** — 默认 → 自动接受编辑 → 自动接受全部 → 无限制 → 计划模式
- **执行中断** — 发送后可随时停止，等同 CLI 中的 Ctrl+C
- **思考动画** — 等待回复时跳动三点指示
- **三套主题** — 深色、浅色、暖色（阅读模式），侧边栏底部一键切换
- **工作目录可配** — 通过 `.env` 配置，前端点击即可修改并持久化
- **项目文档** — 内置文档管理，可浏览工作空间中的文件

## 架构

```
ai-chat-app/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI 路由 + 应用初始化
│   │   ├── session_store.py   # 会话存储、索引管理
│   │   └── claude_session.py  # Claude 会话管理 + 摘要生成
│   ├── .env.example           # 环境变量示例
│   ├── .env                   # 本地配置（不入 Git）
│   └── requirements.txt       # Python 依赖
├── frontend/
│   └── static/
│       ├── index.html         # HTML 结构
│       ├── style.css          # 全局样式
│       └── js/
│           ├── app.js         # 全局状态 + 工具函数
│           ├── theme.js       # 主题切换
│           ├── chat.js        # 对话 + WebSocket + 消息渲染
│           ├── upload.js      # 文件上传 + 发送消息
│           ├── mode.js        # 权限模式
│           └── project.js     # 项目文档管理
├── data/                      # 运行时生成（不入 Git）
│   ├── sessions/
│   │   ├── index.json         # 对话索引（含摘要 + session_id 持久化）
│   │   └── {session_id}.jsonl # 每个对话的消息记录
│   └── uploads/               # 上传文件存储
└── ai-chat-app.sh             # 启停脚本
```

后端桥接 Claude Code CLI，通过子进程调用 `claude -p --output-format stream-json`，将流式输出通过 WebSocket 推送给前端。前端为纯静态文件，由后端托管。

## 跨天记忆机制

```
用户发消息
  ↓
有持久化的 claude_session_id？
  ├─ 有 → --resume（短期记忆恢复）
  │
  └─ 没有 → 检查摘要
              ├─ 有摘要且 generated_at >= 最后消息 ts → 注入摘要到 prompt
              └─ 没有摘要或摘要过期 → Claude 从零开始

WebSocket 断开时 → 后台异步生成摘要 → 存入 index.json
```

- **摘要触发**：仅 WebSocket 断开时（关浏览器、断网、关机）
- **摘要验证**：对比 `summary_generated_at` 与聊天记录最后消息时间戳，过期则重新生成
- **摘要存储**：`data/sessions/index.json` 的 `summary` 和 `summary_generated_at` 字段

## 快速开始

### 前置条件

- Python 3.12+
- [Claude Code CLI](https://claude.ai/code) 已安装并登录
- pip 依赖：fastapi、uvicorn、websockets、pydantic、python-dotenv

### 启动

```bash
./ai-chat-app.sh start    # 启动
./ai-chat-app.sh stop     # 停止
./ai-chat-app.sh restart  # 重启
```

浏览器打开 http://localhost:8000 即可使用。

### 环境变量

在 `backend/.env` 中配置（参考 `backend/.env.example`）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WORKSPACE_DIR` | `~/workspace` | Claude Code 工作目录，前端可修改 |
| `MAX_STORED_SESSIONS` | `50` | 最大存储对话数，超出自动淘汰最老的 |
| `SESSION_TTL` | `3600` | 无活跃连接的会话超时时间（秒） |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 前端页面 |
| `GET` | `/api/health` | 健康检查（含当前工作目录） |
| `POST` | `/api/workspace` | 更新工作目录（写入 .env） |
| `POST` | `/api/sessions` | 创建新对话 |
| `GET` | `/api/sessions` | 列出所有对话 |
| `GET` | `/api/sessions/{id}/history` | 获取对话历史 |
| `DELETE` | `/api/sessions/{id}` | 删除对话 |
| `POST` | `/api/sessions/{id}/stop` | 中断正在执行的对话 |
| `POST` | `/api/sessions/{id}/rename` | 重命名对话 |
| `POST` | `/api/sessions/{id}/summary` | 生成/获取摘要 |
| `GET` | `/api/modes` | 获取权限模式列表 |
| `POST` | `/api/upload` | 上传文件 |
| `WS` | `/ws/{id}` | WebSocket 实时通信 |

## 权限模式

| 模式 | 说明 |
|------|------|
| 默认 | 每次工具调用需确认 |
| 自动接受编辑 | 自动接受文件编辑，其他需确认 |
| 自动接受全部 | 自动接受所有工具调用 |
| 无限制 | 跳过所有权限检查 |
| 计划模式 | 只规划不执行 |

## 主题

| 主题 | 说明 |
|------|------|
| 深色（默认） | 经典深色，适合夜间使用 |
| 浅色 | 干净清爽，适合日间使用 |
| 暖色 | 米黄/琥珀色调，阅读模式，长时间看文字更舒适 |

选择存 localStorage，刷新不丢失。

## 技术栈

- **后端**：FastAPI + Uvicorn + WebSocket
- **前端**：原生 HTML/CSS/JS + [Marked.js](https://marked.js.org/) + [highlight.js](https://highlightjs.org/)
- **持久化**：JSONL 文件，追加写入，容错性好
- **配置**：python-dotenv，`.env` 文件
