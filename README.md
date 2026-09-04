# Claude Code Web Bridge

通过 Web 界面使用 Claude Code CLI，支持流式输出、多会话管理和对话持久化。

## 功能

- **流式对话** — WebSocket 实时推送，Markdown 渲染 + 代码高亮
- **多会话管理** — 侧边栏对话列表，可切换、删除，最多保留 50 个对话（自动淘汰最老的）
- **对话持久化** — 聊天记录以 JSONL 文件存储，服务重启不丢失
- **执行中断** — 发送后可随时停止，等同 CLI 中的 Ctrl+C
- **思考动画** — 等待回复时跳动三点指示

## 架构

```
ai-chat-app/
├── backend/
│   ├── app/main.py          # FastAPI 服务端
│   └── requirements.txt     # Python 依赖
├── frontend/
│   └── static/index.html    # 单页前端
└── data/
    └── sessions/            # 对话持久化（运行时生成，不入 Git）
        ├── index.json       # 对话索引
        └── {session_id}.jsonl  # 每个对话的消息记录
```

后端桥接 Claude Code CLI，通过子进程调用 `claude -p --output-format stream-json`，将流式输出通过 WebSocket 推送给前端。前端是纯静态 HTML，由后端托管。

## 快速开始

### 前置条件

- Python 3.12+
- [Claude Code CLI](https://claude.ai/code) 已安装并登录
- pip 依赖：fastapi、uvicorn、websockets、pydantic

### 启动

```bash
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

浏览器打开 http://localhost:8000 即可使用。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WORKSPACE_DIR` | `~/workspace`（可通过 `.env` 配置） | Claude Code 工作目录 |
| `MAX_STORED_SESSIONS` | `50` | 最大存储对话数，超出自动淘汰最老的 |
| `SESSION_TTL` | `3600` | 无活跃连接的会话超时时间（秒） |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 前端页面 |
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/sessions` | 创建新对话 |
| `GET` | `/api/sessions` | 列出所有对话 |
| `GET` | `/api/sessions/{id}/history` | 获取对话历史 |
| `DELETE` | `/api/sessions/{id}` | 删除对话 |
| `POST` | `/api/sessions/{id}/stop` | 中断正在执行的对话 |
| `WS` | `/ws/{id}` | WebSocket 实时通信 |

## 技术栈

- **后端**：FastAPI + Uvicorn + WebSocket
- **前端**：原生 HTML/CSS/JS + [Marked.js](https://marked.js.org/) + [highlight.js](https://highlightjs.org/)
- **持久化**：JSONL 文件，追加写入，容错性好
