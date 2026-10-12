# ZD Code

通过 Web 界面使用 Claude Code CLI，支持访问口令登录、流式输出、多会话管理、对话持久化、文件上传、跨天记忆、上下文自动恢复、执行追踪、模型与权限模式切换、项目文档管理、Office 文档预览和主题切换。

## 功能

- **访问口令登录** — 通过 `APP_TOKEN` 配置口令，未登录时 `/api/*` 与 `/ws/*` 全部拒绝访问；口令存于 HttpOnly + SameSite=Strict Cookie 中，有效期 30 天
- **流式对话** — WebSocket 实时推送，Markdown 渲染 + 代码高亮（highlight.js 本地打包）
- **安全渲染** — Markdown 输出经 DOMPurify（本地打包）消毒后再写入页面
- **多会话并发** — 每个对话独立 WebSocket + 独立 Claude 子进程，互不阻断
- **会话隔离** — 输入历史、输入框内容、流式状态按会话独立存储，切换对话互不干扰
- **对话持久化** — 聊天记录以 JSONL 文件存储，服务重启不丢失
- **跨天记忆** — 优先 `--resume` 恢复短期记忆，session 丢失时自动从本地历史分批压缩恢复上下文
- **执行追踪（Trace）** — 实时展示每轮工具调用、LLM 调用、token 消耗，自动检测循环调用和连续错误，完成后可查看完整 span 时间线
- **模型选择** — 每个对话可单独选择模型（默认 / sonnet / opus / haiku / fable，也可通过 `CLAUDE_MODEL_OPTIONS` 追加完整模型名）
- **标题保护** — 用户手动改名后系统不再自动覆盖，向后兼容旧数据
- **文件上传** — 支持图片、PDF、文本、代码文件上传，文件路径自动注入 Claude 上下文
- **项目文档管理** — 浏览、查看、创建、编辑、删除 `project/` 目录下的文件，支持子目录、新建文件夹、递归删除文件夹、图片预览、附件下载；文件操作工具栏仅在「项目文档」标签页下显示
- **Office 文档预览** — 通过 LibreOffice 将 pptx/docx/xlsx 转 PDF 在线预览，带缓存
- **幻灯片浏览** — 演示文稿按页渲染为 PNG，支持翻页浏览（依赖 PyMuPDF）
- **七种权限模式** — 默认 / manual / 自动编辑 / 自动 / 不询问 / 计划模式 / 无限制，详见下文
- **执行中断** — 发送后可随时停止，等同 CLI 中的 Ctrl+C
- **连接状态与重连** — 重连按钮始终可见，刷新页面后自动恢复生成中的按钮状态
- **思考动画** — 等待回复时跳动三点指示
- **三套主题** — 深色、浅色、暖色（阅读模式），侧边栏底部一键切换
- **工作目录可配** — 通过 `.env` 配置，前端点击即可修改并持久化
- **Debug Log** — 每轮对话自动生成 `--debug-file` 日志，便于排查问题

## 架构

```
ai-chat-app/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI 路由 + 口令鉴权 + 应用初始化
│   │   ├── session_store.py   # 会话存储、索引管理、Trace 持久化
│   │   └── claude_session.py  # Claude 会话管理 + 历史恢复 + TraceBuilder
│   ├── .env.example           # 环境变量示例
│   ├── .env                   # 本地配置（不入 Git）
│   └── requirements.txt       # Python 依赖
├── frontend/
│   └── static/
│       ├── index.html              # HTML 结构 + 登录弹窗
│       ├── style.css               # 全局样式
│       ├── highlight-theme-dark.css  # 代码高亮主题（深色）
│       ├── highlight-theme-light.css # 代码高亮主题（浅色）
│       └── js/
│           ├── app.js         # 全局状态 + 工具函数 + Markdown 渲染
│           ├── theme.js       # 主题切换
│           ├── chat.js        # 对话 + WebSocket + 消息渲染
│           ├── upload.js      # 文件上传 + 发送消息
│           ├── mode.js        # 权限模式 + 模型选择
│           ├── project.js     # 项目文档管理 + Office 预览
│           ├── trace.js       # 执行追踪面板
│           ├── highlight.min.js  # highlight.js 本地打包
│           └── purify.min.js     # DOMPurify 本地打包
├── data/                      # 运行时生成（不入 Git）
│   ├── sessions/
│   │   ├── index.json         # 对话索引（含 session_id、权限模式、模型等设置）
│   │   └── {session_id}.jsonl # 每个对话的消息记录
│   ├── uploads/               # 上传文件存储
│   ├── preview_cache/         # Office → PDF 转换缓存
│   ├── slide_cache/           # 幻灯片 PNG 渲染缓存
│   ├── debug-logs/            # Claude CLI debug 日志
│   └── traces/                # 执行追踪数据（JSON）
├── ai-chat-app.sh             # 启停脚本
└── .venv/                     # 本地虚拟环境（不入 Git）
```

后端桥接 Claude Code CLI，通过子进程调用 `claude -p --output-format stream-json`，将流式输出通过 WebSocket 推送给前端。`TraceBuilder` 从 stream-json 事件中提取工具调用、LLM 调用、token 用量，构建结构化追踪数据。前端为纯静态文件，由后端托管。

项目文档功能读写的是 `WORKSPACE_DIR/project/` 目录，所有路径都会校验，禁止越出该目录。

## 访问口令与鉴权

- 启动时必须设置 `APP_TOKEN`，未设置则服务拒绝启动
- 打开页面后先输入口令，校验通过后写入 HttpOnly Cookie（`zd_auth`）
- 口令比较使用 `hmac.compare_digest`，防止时序攻击
- 仅 `/api/auth/status`、`/api/auth/login`、`/api/auth/logout` 无需登录，其余 `/api/*` 与 `/ws/*` 均需口令
- 更换口令后，旧 Cookie 自动失效，需重新登录

## 跨天记忆 + 历史恢复

```
用户发消息
  ↓
有 claude_session_id？
  ├─ 有 → --resume（短期记忆恢复）
  │       └─ --resume 失败 → 清空 session_id → 进入恢复流程
  │
  └─ 没有 → 检查 JSONL 历史
              ├─ 有历史 → 进入恢复流程（分批压缩）
              └─ 无历史 → Claude 从零开始（新对话）

恢复流程：
  从 JSONL 读历史 → 分批（每批20条）
    ├─ 第1批：调 Claude（新 session）→ 压缩 → 立即保存 session_id
    ├─ 第2批：调 Claude --resume → 合并压缩
    ├─ ... 链式累积
    └─ 最后：注入摘要 + 用户消息 → 流式输出
  某批失败 → 重试1次 → 仍失败 → 降级只压缩最后一批 → 仍失败 → 放弃
```

- **正常流程**：依赖 Claude Code 自身压缩，ai-chat-app 不干预
- **恢复流程**：session 丢失时从 JSONL 历史分批压缩恢复
- **降级策略**：重试 → 只压缩最近20条 → 放弃

## 快速开始

### 前置条件

- Python 3.12+
- [Claude Code CLI](https://claude.ai/code) 已安装并登录
- LibreOffice（可选，Office 文档预览需要）：`sudo apt install libreoffice`
- Python 依赖：`pip install -r backend/requirements.txt`，另需 `PyMuPDF`（幻灯片渲染需要）

### 配置

```bash
cp backend/.env.example backend/.env
```

编辑 `backend/.env`，**至少设置 `APP_TOKEN`**，否则服务无法启动。

### 启动

```bash
./ai-chat-app.sh start    # 启动
./ai-chat-app.sh stop     # 停止
./ai-chat-app.sh restart  # 重启
```

浏览器打开 http://localhost:8000，输入 `APP_TOKEN` 即可使用。服务默认监听 `0.0.0.0:8000`，如需对外暴露请务必使用强口令，并建议配合 HTTPS 反向代理。

### 环境变量

在 `backend/.env` 中配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APP_TOKEN` | 无（必填） | 访问口令，用于登录鉴权；未设置则服务拒绝启动 |
| `WORKSPACE_DIR` | `~/workspace` | Claude Code 工作目录，前端可修改；项目文档位于其下的 `project/` |
| `CLAUDE_MODEL_OPTIONS` | 空 | 追加到模型下拉框的完整模型名，逗号分隔，如 `claude-opus-4-5,claude-sonnet-4-5` |
| `MAX_STORED_SESSIONS` | `50` | 最大存储对话数，超出自动淘汰最老的 |
| `SESSION_TTL` | `3600` | 无活跃连接的会话超时时间（秒） |

## API

除 `/api/auth/*` 外，所有接口均需先通过口令登录。

### 鉴权

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/auth/status` | 查询当前是否已登录 |
| `POST` | `/api/auth/login` | 登录，请求体 `{"token": "..."}`，成功后写入 Cookie |
| `POST` | `/api/auth/logout` | 退出登录，清除 Cookie |

### 核心

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 前端页面 |
| `GET` | `/api/health` | 健康检查（含当前工作目录） |
| `GET` | `/api/modes` | 获取权限模式列表 |
| `GET` | `/api/models` | 获取可选模型列表 |
| `GET` | `/api/features` | 探测系统可用功能（LibreOffice 等） |

### 工作目录

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/workspace` | 更新工作目录（写入 .env） |

### 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 创建新对话 |
| `GET` | `/api/sessions` | 列出所有对话 |
| `GET` | `/api/sessions/{id}/history` | 获取对话历史 |
| `DELETE` | `/api/sessions/{id}` | 删除对话 |
| `POST` | `/api/sessions/{id}/stop` | 中断正在执行的对话 |
| `PUT` | `/api/sessions/{id}/title` | 重命名对话 |
| `POST` | `/api/sessions/{id}/mode` | 设置权限模式，请求体 `{"mode": "..."}` |
| `POST` | `/api/sessions/{id}/model` | 设置模型，请求体 `{"model": "..."}` |
| `GET` | `/api/sessions/{id}/trace` | 获取执行追踪数据（活跃会话返回实时数据） |
| `GET` | `/api/sessions/{id}/generating` | 查询是否正在生成（刷新后恢复按钮状态） |

### 文件上传

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/upload` | 上传文件 |

### 项目文档

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/projects` | 列出所有项目目录及文件 |
| `GET` | `/api/browse` | 浏览 `project/` 下指定目录（支持子目录） |
| `GET` | `/api/projects/content` | 获取文件内容（文本） |
| `PUT` | `/api/projects/content` | 更新文件内容 |
| `POST` | `/api/projects/content` | 创建新文件 |
| `POST` | `/api/projects/folder` | 创建文件夹 |
| `DELETE` | `/api/projects/content` | 删除文件或文件夹（文件夹递归删除） |
| `GET` | `/api/projects/image` | 获取图片（二进制） |
| `GET` | `/api/projects/download` | 下载文件（附件） |
| `GET` | `/api/projects/preview` | Office 文件转 PDF 预览 |
| `GET` | `/api/projects/slides` | 获取幻灯片页数（自动渲染 PNG） |
| `GET` | `/api/projects/slide_page` | 获取单页幻灯片 PNG |

### WebSocket

| 路径 | 说明 |
|------|------|
| `/ws/{id}` | 实时通信（消息、追踪事件、状态）；需已登录 |

## 权限模式

| 模式 | 说明 |
|------|------|
| 默认 | CLI 默认权限规则，工具调用按规则确认 |
| manual | CLI 的 manual 模式（取值与 CLI 一致） |
| 自动编辑 | 自动接受文件编辑，其他操作仍按规则确认 |
| 自动 | 由 CLI 自动判断是否需要确认 |
| 不询问 | 不弹出确认，未预先允许的操作直接拒绝 |
| 计划模式 | 只分析和规划，不执行修改 |
| 无限制 | 跳过所有权限检查（`bypassPermissions`），请谨慎使用 |

权限模式按对话保存，切换对话后自动恢复各自的设置。

## 主题

| 主题 | 说明 |
|------|------|
| 深色（默认） | 经典深色，适合夜间使用 |
| 浅色 | 干净清爽，适合日间使用 |
| 暖色 | 米黄/琥珀色调，阅读模式，长时间看文字更舒适 |

选择存 localStorage，刷新不丢失。

## 技术栈

- **后端**：FastAPI + Uvicorn + WebSocket
- **前端**：原生 HTML/CSS/JS + [Marked.js](https://marked.js.org/) + [highlight.js](https://highlightjs.org/) + [DOMPurify](https://github.com/cure53/DOMPurify)（均为本地打包）
- **文档预览**：LibreOffice headless（Office → PDF）+ [PyMuPDF](https://pymupdf.artifex.com/)（PDF → PNG）
- **持久化**：JSONL 文件，追加写入，容错性好
- **配置**：python-dotenv，`.env` 文件
