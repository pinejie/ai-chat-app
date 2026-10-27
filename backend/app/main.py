"""Claude Code Web Bridge - FastAPI Application."""
import asyncio
import hmac
import logging
import mimetypes
import os
import shutil
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import workspace_registry as wsreg
from app import asr_service
from app.claude_session import ClaudeSession
from app.session_store import SessionStore

# ─── Config ───────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).resolve().parent.parent / '.env')

WORKSPACE_DIR = os.getenv("WORKSPACE_DIR", os.path.expanduser("~/workspace"))
APP_TOKEN = os.getenv("APP_TOKEN", "")  # 访问口令，必填
AUTH_COOKIE = "zd_auth"
# 未登录也能访问的 API（其余 /api/* 与 /ws/* 都需要口令）
PUBLIC_API_PATHS = {"/api/auth/status", "/api/auth/login", "/api/auth/logout"}
ENV_PATH = Path(__file__).resolve().parent.parent / '.env'
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = PROJECT_DIR / "frontend" / "static"
MOBILE_DIR = PROJECT_DIR / "frontend" / "mobile"
DATA_DIR = PROJECT_DIR / "data" / "sessions"
PREVIEW_CACHE_DIR = PROJECT_DIR / "data" / "preview_cache"
SLIDE_CACHE_DIR = PROJECT_DIR / "data" / "slide_cache"
MAX_STORED_SESSIONS = int(os.getenv("MAX_STORED_SESSIONS", "50"))
SESSION_TTL = int(os.getenv("SESSION_TTL", "3600"))

sessions: dict[str, ClaudeSession] = {}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


async def _cleanup_expired_sessions():
    """Periodically remove sessions past TTL with no active WebSocket."""
    while True:
        await asyncio.sleep(60)
        import time
        now = time.monotonic()
        expired = [
            sid for sid, s in sessions.items()
            if not s.clients and (now - s.last_active) > SESSION_TTL
        ]
        for sid in expired:
            await sessions[sid].stop()
            del sessions[sid]


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not APP_TOKEN:
        raise RuntimeError("APP_TOKEN 未设置：请在 backend/.env 中配置访问口令后再启动")
    _ensure_data_dir()
    SessionStore._set_data_dir(DATA_DIR)
    # 工作目录注册表：首次启动把旧全局 WORKSPACE_DIR 收编为默认条目（无缝迁移）
    wsreg.ensure_registry(WORKSPACE_DIR)
    task = asyncio.create_task(_cleanup_expired_sessions())
    yield
    task.cancel()
    for session in sessions.values():
        await session.stop()


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Claude Code Web Bridge", version="0.3.0", lifespan=lifespan)

# 前后端同源，不需要 CORS。之前的 allow_origins=["*"] + credentials 已移除。

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
# 移动端 H5（独立前端代码，见 project/ai-chat-app/01-移动端适配需求.md §3.2 D2）
# html=True：访问 /m 自动重定向到 /m/ 并返回 index.html，静态资源走相对路径 /m/*
app.mount("/m", StaticFiles(directory=str(MOBILE_DIR), html=True), name="mobile")


def _is_authed(token_value) -> bool:
    if not APP_TOKEN or not token_value:
        return False
    return hmac.compare_digest(str(token_value).encode("utf-8"), APP_TOKEN.encode("utf-8"))


@app.middleware("http")
async def require_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in PUBLIC_API_PATHS:
        if not _is_authed(request.cookies.get(AUTH_COOKIE)):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# ─── Routes: Auth ─────────────────────────────────────────────────────────────

@app.get("/api/auth/status")
def auth_status(request: Request):
    return {"authenticated": _is_authed(request.cookies.get(AUTH_COOKIE))}


@app.post("/api/auth/login")
def auth_login(body: dict, response: Response):
    token = str(body.get("token", "")).strip()
    if not _is_authed(token):
        raise HTTPException(401, "口令错误")
    # HttpOnly：页面脚本读不到 cookie，即使有 XSS 也偷不走口令
    # SameSite=Strict：跨站页面无法带上 cookie，防 CSRF
    # Secure 固定为 True：对外入口只有 nginx 终结 TLS 的 HTTPS 一条路，声明事实而非探测协议
    # 注意：本机 http://localhost:8000 直连调试时浏览器不会带此 cookie，需走 https 入口测登录
    response.set_cookie(AUTH_COOKIE, token, httponly=True, samesite="strict",
                        max_age=30 * 24 * 3600, path="/", secure=True)
    return {"ok": True}


@app.post("/api/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie(AUTH_COOKIE, path="/")
    return {"ok": True}


# ─── Routes: Core ─────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"status": "ok", "active_sessions": len(sessions), "workspace": WORKSPACE_DIR}


@app.get("/api/modes")
def get_modes():
    return ClaudeSession.AVAILABLE_MODES


# ─── Routes: Workspace ────────────────────────────────────────────────────────

def _write_env_workspace_dir(new_dir: str):
    lines = []
    if ENV_PATH.exists():
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
    found = False
    for i, line in enumerate(lines):
        if line.strip().startswith("WORKSPACE_DIR="):
            lines[i] = "WORKSPACE_DIR=" + new_dir + "\n"
            found = True
            break
    if not found:
        lines.append("WORKSPACE_DIR=" + new_dir + "\n")
    with open(ENV_PATH, "w", encoding="utf-8") as f:
        f.writelines(lines)


@app.post("/api/workspace")
def update_workspace(body: dict):
    """【语义变更】设置默认工作目录。
    旧版 PC 页面仍在调这个接口；现在只影响"以后新建的对话"用哪个目录，
    不改变任何已有对话（每条对话保存了自己创建时的路径快照）。
    .env 继续写入：保证服务重启后默认值不丢。"""
    global WORKSPACE_DIR
    new_dir = body.get("workspace", "").strip()
    if not new_dir:
        raise HTTPException(400, "workspace is required")
    new_dir = os.path.abspath(os.path.expanduser(new_dir))
    if not os.path.isdir(new_dir):
        raise HTTPException(400, f"目录不存在：{new_dir}")
    WORKSPACE_DIR = new_dir
    _write_env_workspace_dir(new_dir)
    try:
        wsreg.update(wsreg.default_item()["id"], path=new_dir)
    except (KeyError, ValueError):
        pass
    return {"workspace": WORKSPACE_DIR}


# ─── Routes: Workspace Registry ───────────────────────────────────────────────

def _workspace_usage() -> dict:
    counts = {}
    for entry in SessionStore.load_index():
        wid = entry.get("workspace_id")
        if wid:
            counts[wid] = counts.get(wid, 0) + 1
    return counts


@app.get("/api/workspaces")
def list_workspaces():
    items = wsreg.load()
    counts = _workspace_usage()
    return {
        "items": [{**item, "usage": counts.get(item["id"], 0)} for item in items],
        "default_id": (wsreg.default_item()["id"] if items else None),
    }


@app.post("/api/workspaces")
def create_workspace(body: dict):
    try:
        return wsreg.add(body.get("name", ""), body.get("path", ""), bool(body.get("is_default")))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/workspaces/{wid}")
def modify_workspace(wid: str, body: dict):
    try:
        return wsreg.update(wid, name=body.get("name"), path=body.get("path"),
                            is_default=body.get("is_default"))
    except KeyError:
        raise HTTPException(404, "工作目录不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/workspaces/{wid}")
def remove_workspace(wid: str):
    try:
        ok = wsreg.delete(wid, _workspace_usage().get(wid, 0))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "工作目录不存在")
    return {"ok": True}


def _session_workspace_path(session_id: str) -> str:
    """对话创建时保存的路径快照；老对话/查不到 → 回退全局默认（升级兼容）。"""
    if not session_id:
        return WORKSPACE_DIR
    for entry in SessionStore.load_index():
        if entry["id"] == session_id:
            return entry.get("workspace_path") or WORKSPACE_DIR
    return WORKSPACE_DIR



# ─── Routes: Upload ────────────────────────────────────────────────────────────

UPLOAD_DIR = PROJECT_DIR / "data" / "uploads"

@app.post("/api/upload")
async def upload_files(files: list[UploadFile] = File(...)):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    result = []
    for file in files:
        ext = Path(file.filename).suffix
        saved_name = f"{uuid.uuid4()}{ext}"
        file_path = UPLOAD_DIR / saved_name
        file_bytes = await file.read()
        file_path.write_bytes(file_bytes)
        result.append({"name": file.filename, "path": str(file_path)})
    return {"files": result}


# ─── Routes: ASR（移动端语音输入）─────────────────────────────────────────────

@app.post("/api/asr")
async def asr_transcribe(file: UploadFile = File(...)):
    """接收录音（webm/m4a/wav 均可），返回识别文本。鉴权已由 /api/* 中间件统一覆盖。"""
    data = await file.read()
    if not data:
        raise HTTPException(400, "空文件")
    suffix = Path(file.filename or "audio").suffix.lower() or ".bin"
    try:
        return await asr_service.transcribe(data, suffix)
    except asr_service.AsrError as e:
        # 业务失败（未配置/解码失败/连不上/超时）：422 让前端把原因原样透传给用户
        raise HTTPException(422, str(e))

# ─── Routes: Sessions ─────────────────────────────────────────────────────────

async def _make_new_session(ws: dict, title: str | None = None) -> dict:
    """创建会话（内存 + 索引），并绑定工作目录快照。
    缺省标题"新对话"由首条消息自动改名接管；显式标题（fork 副本）标记
    manually_set，防止后续自动标题覆盖。"""
    index = SessionStore.load_index()
    while len(index) >= MAX_STORED_SESSIONS:
        oldest = index[-1]
        old_id = oldest["id"]
        if old_id in sessions:
            await sessions[old_id].stop()
            del sessions[old_id]
        SessionStore.delete_session_files(old_id)
        index = SessionStore.load_index()

    session_id = str(uuid.uuid4())
    sessions[session_id] = ClaudeSession(session_id, ws["path"])
    title = title or "新对话"
    SessionStore.add_to_index(session_id, title, ws["id"], ws["path"])
    if title != "新对话":
        SessionStore.update_title(session_id, title, manually_set=True)
    return {"session_id": session_id, "title": title,
            "workspace_id": ws["id"], "workspace_path": ws["path"]}


def _resolve_workspace(body: dict | None) -> dict:
    """请求指定了 workspace_id 就按它来；没指定/找不到都落默认目录（不静默报错，
    新建流程不能因为注册表被并行改过而卡死）。"""
    if body:
        item = wsreg.get(str(body.get("workspace_id", "")))
        if item:
            return item
    return wsreg.default_item()


@app.post("/api/sessions")
async def create_session(body: dict = Body(default=None)):
    return await _make_new_session(_resolve_workspace(body))


@app.post("/api/sessions/{session_id}/fork")
async def fork_session(session_id: str, body: dict = Body(default=None)):
    """换目录 = 在新目录建一个新对话（副本标题，不带聊天历史，AI 上下文全新开始）。
    这不是偷懒，是 claude CLI 的物理事实：CLI 会话记录按项目目录存储，
    换目录后 --resume 必然找不到旧会话。
    目录没变则不复制：原样返回原会话并标记 forked=False（返回结构兼容老客户端）。"""
    src = next((e for e in SessionStore.load_index() if e["id"] == session_id), None)
    if src is None:
        raise HTTPException(404, "原对话不存在")
    ws = _resolve_workspace(body)
    if src.get("workspace_id"):
        unchanged = src["workspace_id"] == ws["id"]
    else:
        # 旧会话没记注册表 id，退而比较创建时的路径快照
        unchanged = src.get("workspace_path") == ws["path"]
    if unchanged:
        return {**src, "session_id": src["id"], "forked": False}
    src_title = src.get("title") or "新对话"
    new_sess = await _make_new_session(ws, title=f"{src_title}（副本）")
    return {**new_sess, "forked": True}


def _ordered_index() -> list[dict]:
    """列表顺序的单一排序键：sort_order 升序。
    首次（或有旧条目缺字段）按「created 降序 + 文件序」补号迁移——迁移结果与升级前
    的屏幕顺序完全一致，用户无感。之后顺序只由 reorder 决定。"""
    index = SessionStore.load_index()
    if any("sort_order" not in e for e in index):
        ordered = sorted(index, key=lambda e: e.get("created", 0), reverse=True)
        for rank, entry in enumerate(ordered):
            entry["sort_order"] = rank
        SessionStore.save_index(ordered)
        index = ordered
    return sorted(index, key=lambda e: e["sort_order"])


@app.get("/api/sessions")
def list_sessions():
    # 顺序契约：sort_order 升序；查看/切换/重连/发消息都不改顺序，只有 reorder 会。
    return _ordered_index()


@app.post("/api/sessions/reorder")
async def reorder_sessions(body: dict = Body(...)):
    """PC 拖拽排序提交：ids 为期望顺序的全量会话 id。
    与现有集合不一致直接拒绝——宁可让前端重拉列表，也不让陈旧页面的拖拽
    悄悄把新建/删除的对话挤掉（整表重编号，漏一个就丢一个）。"""
    ids = body.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise HTTPException(400, "ids 必须是会话 id 数组")
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "ids 含重复项")
    ordered = _ordered_index()
    current = {e["id"] for e in ordered}
    if set(ids) != current:
        raise HTTPException(400, "会话列表已变化，请刷新后重试")
    by_id = {e["id"]: e for e in ordered}
    reordered = [by_id[i] for i in ids]
    for rank, entry in enumerate(reordered):
        entry["sort_order"] = rank
    SessionStore.save_index(reordered)
    return {"ok": True, "count": len(reordered)}


@app.get("/api/sessions/{session_id}/history")
def session_history(session_id: str):
    return SessionStore.read_history(session_id)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    if session_id in sessions:
        try:
            await sessions[session_id].stop()
        except Exception as e:
            logging.getLogger("claude-bridge").warning("stop() failed during delete for %s: %s", session_id, e)
        finally:
            # 无论 stop 是否成功，都要删记录，否则对话永远删不掉
            del sessions[session_id]
    SessionStore.delete_session_files(session_id)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404, "Session not found")
    session = sessions[session_id]
    await session.stop()
    await session.broadcast({"type": "stopped"})   # 所有观看该会话的页面都要看到「已中断」
    return {"ok": True}


@app.get("/api/sessions/{session_id}/trace")
def get_session_trace(session_id: str):
    """Get trace data for a session (persisted from last run, or live if active)."""
    # If session is active, return live trace
    if session_id in sessions:
        live = sessions[session_id].trace.get_current_trace()
        return {"live": True, **live}
    # Otherwise load from disk
    trace = SessionStore.load_trace(session_id)
    if trace:
        return {"live": False, **trace}
    return {"live": False, "spans": [], "issues": []}


@app.get("/api/models")
def get_models():
    return {"default": "default", "options": ClaudeSession.model_options()}


def _apply_session_setting(session_id: str, **values):
    """持久化到对话索引（不要求会话已加载进内存），并同步到内存中的活跃会话。"""
    if not SessionStore.update_settings(session_id, **values):
        raise HTTPException(404, "Session not found")
    live = sessions.get(session_id)
    if live:
        for k, v in values.items():
            setattr(live, k, v)


@app.post("/api/sessions/{session_id}/mode")
def set_session_mode(session_id: str, body: dict):
    mode = str(body.get("mode", "")).strip()
    if not ClaudeSession.valid_mode(mode):
        raise HTTPException(400, "Invalid permission mode")
    _apply_session_setting(session_id, permission_mode=mode)
    return {"mode": mode}


@app.post("/api/sessions/{session_id}/model")
def set_session_model(session_id: str, body: dict):
    model = str(body.get("model", "")).strip() or "default"
    if not ClaudeSession.valid_model(model):
        raise HTTPException(400, "Invalid model name")
    _apply_session_setting(session_id, model=model)
    return {"model": model}


@app.put("/api/sessions/{session_id}/title")
def rename_session(session_id: str, body: dict):
    new_title = body.get("title", "").strip()
    if not new_title:
        raise HTTPException(400, "title is required")
    index = SessionStore.load_index()
    found = any(entry["id"] == session_id for entry in index)
    if not found:
        raise HTTPException(404, "Session not found")
    SessionStore.update_title(session_id, new_title, manually_set=True)
    if session_id in sessions:
        sessions[session_id]._first_message = False
    return {"ok": True, "title": new_title}


# ─── Routes: WebSocket ────────────────────────────────────────────────────────

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    if not _is_authed(websocket.cookies.get(AUTH_COOKIE)):
        await websocket.close(code=1008)  # policy violation
        return
    await websocket.accept()
    if session_id not in sessions:
        # 服务重启后重连：按会话索引里的目录快照恢复，老数据无快照则回退默认目录
        sessions[session_id] = ClaudeSession(session_id, _session_workspace_path(session_id))
    session = sessions[session_id]
    session.clients.add(websocket)
    session.touch()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "message":
                files = data.get("files", [])
                asyncio.create_task(session.send_and_stream(data["content"], files))
    except WebSocketDisconnect:
        session.clients.discard(websocket)
    except Exception as e:
        import logging
        logging.getLogger("claude-bridge").error("WebSocket error: %s", e)
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
        except Exception:
            pass
        session.clients.discard(websocket)


# ─── Routes: Projects ─────────────────────────────────────────────────────────

ROOT_GROUP = "根目录"  # project/ 根层散落文件的虚拟分组名


def _validate_project_path(project_name: str, filename: str) -> Path:
    """Validate and resolve a project file path. Supports subfolder paths (project_name may contain '/')."""
    if '..' in project_name or '..' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid path")
    project_root = Path(WORKSPACE_DIR) / "project"
    if project_name == ROOT_GROUP:
        file_path = project_root / filename
    else:
        file_path = project_root / project_name / filename
    try:
        file_path.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    return file_path





def _project_root(session: str = "") -> Path:
    """文档/项目 API 的根：跟随指定对话的工作目录快照；不带 session 用全局默认。"""
    return Path(_session_workspace_path(session)) / "project"


def _resolve_path(path: str, session: str = "") -> Path:
    """Resolve a path relative to project/ root. Validates no path traversal."""
    if '..' in path or '\\' in path:
        raise HTTPException(400, "Invalid path")
    project_root = _project_root(session)
    file_path = project_root / path
    try:
        file_path.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    return file_path

def _resolve_dir(dir: str, session: str = "") -> Path:
    """Resolve a parent directory (relative to project/) and ensure it stays inside project/.
    注意：Path 的 `/` 遇到绝对路径会直接替换前缀，必须 resolve 后再校验。"""
    if '..' in dir or '\\' in dir:
        raise HTTPException(400, "Invalid directory path")
    project_root = _project_root(session)
    target_dir = (project_root / dir) if dir else project_root
    try:
        target_dir.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid directory path")
    return target_dir


@app.get("/api/browse")
def browse_directory(rel_path: str = "", session: str = ""):
    """Browse a directory under project/. Returns files + subdirectories.
    rel_path is relative to project/ root. Empty string = root."""
    project_root = _project_root(session)
    if not project_root.exists():
        return {"files": [], "dirs": []}

    target = project_root / rel_path if rel_path else project_root
    try:
        target.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Directory not found")

    files = []
    dirs = []
    for item in sorted(target.iterdir()):
        if item.name.startswith('.'):
            continue
        if item.is_file():
            files.append(item.name)
        elif item.is_dir():
            dirs.append(item.name)
    return {"files": files, "dirs": dirs}


@app.get("/api/projects")
def list_projects(session: str = ""):
    project_root = _project_root(session)
    if not project_root.exists():
        return {}
    result = {}
    for proj_dir in sorted(project_root.iterdir()):
        if proj_dir.is_dir() and not proj_dir.name.startswith('.'):
            files = [f.name for f in sorted(proj_dir.iterdir()) if f.is_file() and not f.name.startswith('.')]
            result[proj_dir.name] = files
    # project/ 根层散落文件（不在任何子目录里）
    root_files = [f.name for f in sorted(project_root.iterdir()) if f.is_file() and not f.name.startswith('.')]
    if root_files:
        result[ROOT_GROUP] = root_files
    return result


@app.get("/api/projects/download")
def download_project_file(path: str, session: str = ""):
    """Download any project file as an attachment."""
    file_path = _resolve_path(path, session)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type, filename=file_path.name)


@app.get("/api/projects/content")
def get_project_file_content(path: str, session: str = ""):
    file_path = _resolve_path(path, session)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return {"filename": file_path.name, "content": file_path.read_text(encoding="utf-8", errors="replace")}


@app.get("/api/projects/image")
def get_project_image(path: str, session: str = ""):
    """Serve an image file from a project directory (binary-safe)."""
    file_path = _resolve_path(path, session)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)


@app.put("/api/projects/content")
def update_project_file(path: str, body: dict, session: str = ""):
    file_path = _resolve_path(path, session)
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_path.write_text(body.get("content", ""), encoding="utf-8")
    return {"ok": True, "filename": file_path.name}


@app.delete("/api/projects/content")
def delete_project_file(path: str, session: str = ""):
    file_path = _resolve_path(path, session)
    # 防止 path="" 或 "." 时 rmtree 整个 project/ 根目录
    if file_path.resolve() == _project_root(session).resolve():
        raise HTTPException(400, "Cannot delete project root")
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    if file_path.is_dir():
        shutil.rmtree(file_path)
        return {"ok": True}
    file_path.unlink()
    return {"ok": True}


@app.post("/api/projects/folder")
def create_project_folder(dir: str = "", body: dict = None, session: str = ""):
    """Create a new folder. dir = parent directory relative to project/ root."""
    if '..' in dir or '\\' in dir:
        raise HTTPException(400, "Invalid directory path")
    name = (body or {}).get("name", "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if '..' in name or '/' in name or '\\' in name:
        raise HTTPException(400, "Invalid folder name")
    target_dir = _resolve_dir(dir, session)
    folder_path = target_dir / name
    if folder_path.exists():
        raise HTTPException(409, "Folder already exists")
    folder_path.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "name": name}


@app.post("/api/projects/content")
def create_project_file(dir: str = "", body: dict = None, session: str = ""):
    """Create a new file. dir = relative directory path from project/ root."""
    filename = (body or {}).get("filename", "").strip()
    content_text = (body or {}).get("content", "")
    if not filename:
        raise HTTPException(400, "filename is required")
    if '..' in filename or '/' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid filename")
    if not filename.endswith('.md'):
        filename += '.md'
    target_dir = _resolve_dir(dir, session)
    target_dir.mkdir(parents=True, exist_ok=True)
    file_path = target_dir / filename
    if file_path.exists():
        raise HTTPException(409, "File already exists")
    file_path.write_text(content_text, encoding="utf-8")
    return {"ok": True, "filename": filename}



# ─── Routes: Features & Preview ───────────────────────────────────────────────

@app.get("/api/features")
def get_features():
    """Probe available system features (LibreOffice, etc.)."""
    lo_path = shutil.which("libreoffice") or shutil.which("soffice")
    return {
        "libreoffice": lo_path is not None,
        "libreoffice_path": lo_path,
    }


@app.get("/api/projects/preview")
def preview_office_file(path: str, session: str = ""):
    """Convert an Office file (pptx/docx/xlsx) to PDF via LibreOffice and serve it."""
    file_path = _resolve_path(path, session)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")

    # Check LibreOffice availability
    lo_bin = shutil.which("libreoffice") or shutil.which("soffice")
    if not lo_bin:
        raise HTTPException(503, "LibreOffice is not installed on the server")

    # Check cache: serve existing PDF if source hasn't changed
    cache_subdir = PREVIEW_CACHE_DIR / Path(path).parent
    cache_subdir.mkdir(parents=True, exist_ok=True)
    pdf_name = file_path.stem + ".pdf"
    cached_pdf = cache_subdir / pdf_name

    source_mtime = file_path.stat().st_mtime
    if cached_pdf.exists():
        cached_mtime = cached_pdf.stat().st_mtime
        if cached_mtime >= source_mtime:
            return FileResponse(cached_pdf, media_type="application/pdf")

    # Convert via LibreOffice headless
    try:
        subprocess.run(
            [lo_bin, "--headless", "--convert-to", "pdf", "--outdir", str(cache_subdir), str(file_path)],
            check=True,
            timeout=60,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, "LibreOffice conversion failed: " + e.stderr.decode(errors="replace")[:500])
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "LibreOffice conversion timed out")
    except Exception as e:
        raise HTTPException(500, "Conversion error: " + str(e))

    if not cached_pdf.exists():
        raise HTTPException(500, "Conversion produced no output file")

    return FileResponse(cached_pdf, media_type="application/pdf")




@app.get("/api/projects/slides")
def list_slides(path: str, session: str = ""):
    """Return total slide count for a presentation, generating PNGs from PDF."""
    file_path = _resolve_path(path, session)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")

    suffix = file_path.suffix.lower()
    source_mtime = file_path.stat().st_mtime

    # PDF files use the source directly
    if suffix == ".pdf":
        pdf_path = file_path
    else:
        # Office files: convert to PDF first (reuse preview cache)
        lo_bin = shutil.which("libreoffice") or shutil.which("soffice")
        if not lo_bin:
            raise HTTPException(503, "LibreOffice is not installed")
        pdf_cache_dir = PREVIEW_CACHE_DIR / Path(path).parent
        pdf_cache_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = pdf_cache_dir / (file_path.stem + ".pdf")
        if not pdf_path.exists() or pdf_path.stat().st_mtime < source_mtime:
            try:
                subprocess.run(
                    [lo_bin, "--headless", "--convert-to", "pdf", "--outdir", str(pdf_cache_dir), str(file_path)],
                    check=True, timeout=60, capture_output=True,
                )
            except subprocess.CalledProcessError as e:
                raise HTTPException(500, "PDF conversion failed: " + e.stderr.decode(errors="replace")[:500])
            except subprocess.TimeoutExpired:
                raise HTTPException(504, "Conversion timed out")
        if not pdf_path.exists():
            raise HTTPException(500, "PDF conversion produced no output")

    # Render PNG cache per page
    slide_dir = SLIDE_CACHE_DIR / Path(path).parent / file_path.stem
    marker = slide_dir / ".mtime"

    if slide_dir.exists() and marker.exists():
        try:
            cached_mtime = float(marker.read_text().strip())
            if cached_mtime >= source_mtime and any(slide_dir.glob("page_*.png")):
                pages = sorted(slide_dir.glob("page_*.png"))
                return {"total": len(pages)}
        except (ValueError, OSError):
            pass

    slide_dir.mkdir(parents=True, exist_ok=True)
    try:
        import fitz
        doc = fitz.open(str(pdf_path))
        for old in slide_dir.glob("page_*.png"):
            old.unlink()
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=150)
            pix.save(str(slide_dir / f"page_{i}.png"))
        total = len(doc)
        doc.close()
        marker.write_text(str(source_mtime))
    except Exception as e:
        raise HTTPException(500, f"Slide rendering failed: {e}")

    return {"total": total}


@app.get("/api/projects/slide_page")
def get_slide_page(path: str, page: int, session: str = ""):
    """Serve a single slide PNG (1-indexed)."""
    if page < 1:
        raise HTTPException(400, "page must be >= 1")
    file_path = _resolve_path(path, session)
    slide_dir = SLIDE_CACHE_DIR / Path(path).parent / file_path.stem
    png_path = slide_dir / f"page_{page}.png"
    if not png_path.exists():
        raise HTTPException(404, "Slide not found (call /slides first)")
    return FileResponse(png_path, media_type="image/png")

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)

@app.get("/api/sessions/{session_id}/generating")
async def session_generating(session_id: str):
    """前端刷新后用来恢复按钮状态：true=还在生成，false=空闲。"""
    session = sessions.get(session_id)
    return {"generating": session is not None and session.process is not None}
