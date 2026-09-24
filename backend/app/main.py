"""Claude Code Web Bridge - FastAPI Application."""
import asyncio
import mimetypes
import os
import shutil
import subprocess
import time
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
    except Exception as e:
        import logging
        logging.getLogger("claude-bridge").error("WebSocket error: %s", e)
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
        except Exception:
            pass
        session.websocket = None


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





def _resolve_path(path: str) -> Path:
    """Resolve a path relative to project/ root. Validates no path traversal."""
    if '..' in path or '\\' in path:
        raise HTTPException(400, "Invalid path")
    project_root = Path(WORKSPACE_DIR) / "project"
    file_path = project_root / path
    try:
        file_path.resolve().relative_to(project_root.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid path")
    return file_path

@app.get("/api/browse")
def browse_directory(rel_path: str = ""):
    """Browse a directory under project/. Returns files + subdirectories.
    rel_path is relative to project/ root. Empty string = root."""
    project_root = Path(WORKSPACE_DIR) / "project"
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
def list_projects():
    project_root = Path(WORKSPACE_DIR) / "project"
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
def download_project_file(path: str):
    """Download any project file as an attachment."""
    file_path = _resolve_path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type, filename=file_path.name)


@app.get("/api/projects/content")
def get_project_file_content(path: str):
    file_path = _resolve_path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return {"filename": file_path.name, "content": file_path.read_text(encoding="utf-8", errors="replace")}


@app.get("/api/projects/image")
def get_project_image(path: str):
    """Serve an image file from a project directory (binary-safe)."""
    file_path = _resolve_path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return FileResponse(file_path, media_type=media_type)


@app.put("/api/projects/content")
def update_project_file(path: str, body: dict):
    file_path = _resolve_path(path)
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_path.write_text(body.get("content", ""), encoding="utf-8")
    return {"ok": True, "filename": file_path.name}


@app.delete("/api/projects/content")
def delete_project_file(path: str):
    file_path = _resolve_path(path)
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    file_path.unlink()
    return {"ok": True}


@app.post("/api/projects/content")
def create_project_file(dir: str = "", body: dict = None):
    """Create a new file. dir = relative directory path from project/ root."""
    if '..' in dir or '\\' in dir:
        raise HTTPException(400, "Invalid directory path")
    filename = (body or {}).get("filename", "").strip()
    content_text = (body or {}).get("content", "")
    if not filename:
        raise HTTPException(400, "filename is required")
    if '..' in filename or '/' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid filename")
    if not filename.endswith('.md'):
        filename += '.md'
    target_dir = Path(WORKSPACE_DIR) / "project" / dir if dir else Path(WORKSPACE_DIR) / "project"
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
def preview_office_file(path: str):
    """Convert an Office file (pptx/docx/xlsx) to PDF via LibreOffice and serve it."""
    file_path = _resolve_path(path)
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
def list_slides(path: str):
    """Return total slide count for a presentation, generating PNGs from PDF."""
    file_path = _resolve_path(path)
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
def get_slide_page(path: str, page: int):
    """Serve a single slide PNG (1-indexed)."""
    if page < 1:
        raise HTTPException(400, "page must be >= 1")
    file_path = _resolve_path(path)
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
