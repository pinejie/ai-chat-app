"""Claude Code Web Bridge - FastAPI Application."""
import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.claude_session import ClaudeSession
from app.session_store import SessionStore

# ─── Config ───────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).resolve().parent.parent / '.env')

WORKSPACE_DIR = os.getenv("WORKSPACE_DIR", os.path.expanduser("~/workspace"))
ENV_PATH = Path(__file__).resolve().parent.parent / '.env'
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = PROJECT_DIR / "frontend" / "static"
DATA_DIR = PROJECT_DIR / "data" / "sessions"
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
            if s.websocket is None and (now - s.last_active) > SESSION_TTL
        ]
        for sid in expired:
            await sessions[sid].stop()
            del sessions[sid]


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_data_dir()
    SessionStore._set_data_dir(DATA_DIR)
    task = asyncio.create_task(_cleanup_expired_sessions())
    yield
    task.cancel()
    for session in sessions.values():
        await session.stop()


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Claude Code Web Bridge", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


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

@app.post("/api/workspace")
def update_workspace(body: dict):
    global WORKSPACE_DIR
    new_dir = body.get("workspace", "").strip()
    if not new_dir:
        raise HTTPException(400, "workspace is required")
    new_dir = os.path.expanduser(new_dir)
    WORKSPACE_DIR = new_dir

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
    return {"workspace": WORKSPACE_DIR}



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

# ─── Routes: Sessions ─────────────────────────────────────────────────────────

@app.post("/api/sessions")
async def create_session():
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
    sessions[session_id] = ClaudeSession(session_id, WORKSPACE_DIR)
    title = "新对话"
    SessionStore.add_to_index(session_id, title)
    return {"session_id": session_id, "title": title}


@app.get("/api/sessions")
def list_sessions():
    return SessionStore.load_index()


@app.get("/api/sessions/{session_id}/history")
def session_history(session_id: str):
    return SessionStore.read_history(session_id)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    if session_id in sessions:
        await sessions[session_id].stop()
        del sessions[session_id]
    SessionStore.delete_session_files(session_id)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404, "Session not found")
    session = sessions[session_id]
    await session.stop()
    if session.websocket:
        try:
            await session.websocket.send_json({"type": "stopped"})
        except Exception:
            pass
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


@app.post("/api/sessions/{session_id}/mode")
def set_session_mode(session_id: str, body: dict):
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    mode = body.get("mode", "").strip()
    valid_ids = [m["id"] for m in ClaudeSession.AVAILABLE_MODES]
    if mode not in valid_ids:
        raise HTTPException(400, f"Invalid mode. Valid: {valid_ids}")
    session.permission_mode = mode
    return {"mode": mode}


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
    await websocket.accept()
    if session_id not in sessions:
        sessions[session_id] = ClaudeSession(session_id, WORKSPACE_DIR)
    session = sessions[session_id]
    session.websocket = websocket
    session.touch()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "message":
                files = data.get("files", [])
                asyncio.create_task(session.send_and_stream(data["content"], files))
    except WebSocketDisconnect:
        session.websocket = None
        asyncio.create_task(ClaudeSession._generate_summary(session_id))
    except Exception as e:
        import logging
        logging.getLogger("claude-bridge").error("WebSocket error: %s", e)
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
        except Exception:
            pass
        session.websocket = None
        asyncio.create_task(ClaudeSession._generate_summary(session_id))


# ─── Routes: Projects ─────────────────────────────────────────────────────────

def _validate_project_path(project_name: str, filename: str) -> Path:
    """Validate and resolve a project file path. Raises HTTPException on failure."""
    if '..' in project_name or '..' in filename or '/' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid path")
    project_root = Path(WORKSPACE_DIR) / "project"
    file_path = project_root / project_name / filename
    try:
        file_path.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    return file_path


@app.get("/api/projects")
def list_projects():
    project_root = Path(WORKSPACE_DIR) / "project"
    if not project_root.exists():
        return {}
    result = {}
    for proj_dir in sorted(project_root.iterdir()):
        if proj_dir.is_dir() and not proj_dir.name.startswith('.'):
            files = [f.name for f in sorted(proj_dir.iterdir()) if f.is_file() and f.suffix == '.md']
            if files:
                result[proj_dir.name] = files
    return result


@app.get("/api/projects/{project_name}/content/{filename}")
def get_project_file_content(project_name: str, filename: str):
    file_path = _validate_project_path(project_name, filename)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return {"filename": filename, "content": file_path.read_text(encoding="utf-8")}


@app.put("/api/projects/{project_name}/content/{filename}")
def update_project_file(project_name: str, filename: str, body: dict):
    file_path = _validate_project_path(project_name, filename)
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_path.write_text(body.get("content", ""), encoding="utf-8")
    return {"ok": True, "filename": filename}


@app.delete("/api/projects/{project_name}/content/{filename}")
def delete_project_file(project_name: str, filename: str):
    file_path = _validate_project_path(project_name, filename)
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_path.unlink()
    return {"ok": True}


@app.post("/api/projects/{project_name}/content")
def create_project_file(project_name: str, body: dict):
    if '..' in project_name or '/' in project_name or '\\' in project_name:
        raise HTTPException(400, "Invalid project name")
    filename = body.get("filename", "").strip()
    content_text = body.get("content", "")
    if not filename:
        raise HTTPException(400, "filename is required")
    if '..' in filename or '/' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid filename")
    if not filename.endswith('.md'):
        filename += '.md'
    proj_dir = Path(WORKSPACE_DIR) / "project" / project_name
    proj_dir.mkdir(parents=True, exist_ok=True)
    file_path = proj_dir / filename
    if file_path.exists():
        raise HTTPException(409, "File already exists")
    file_path.write_text(content_text, encoding="utf-8")
    return {"ok": True, "filename": filename}


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
