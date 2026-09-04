"""Claude Code Web Bridge - Backend"""
import asyncio
import json
import logging
import time
import uuid
import os
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from typing import Optional

logger = logging.getLogger("claude-bridge")

WORKSPACE_DIR = os.getenv("WORKSPACE_DIR", "/home/wangg/workspace")
PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = PROJECT_DIR / "frontend" / "static"
DATA_DIR = PROJECT_DIR / "data" / "sessions"
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "100"))
MAX_STORED_SESSIONS = int(os.getenv("MAX_STORED_SESSIONS", "50"))
SESSION_TTL = int(os.getenv("SESSION_TTL", "3600"))

sessions: dict[str, "ClaudeSession"] = {}


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


class SessionStore:
    """JSONL-based session persistence."""

    @staticmethod
    def _index_path() -> Path:
        return DATA_DIR / "index.json"

    @staticmethod
    def _session_path(session_id: str) -> Path:
        return DATA_DIR / f"{session_id}.jsonl"

    @classmethod
    def load_index(cls) -> list[dict]:
        path = cls._index_path()
        if not path.exists():
            return []
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []

    @classmethod
    def save_index(cls, index: list[dict]):
        cls._index_path().write_text(
            json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @classmethod
    def add_to_index(cls, session_id: str, title: str):
        index = cls.load_index()
        entry = {
            "id": session_id,
            "title": title,
            "created": int(time.time()),
            "last_active": int(time.time()),
        }
        index.insert(0, entry)
        cls.save_index(index)

    @classmethod
    def update_title(cls, session_id: str, title: str):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["title"] = title
                break
        cls.save_index(index)

    @classmethod
    def touch_index(cls, session_id: str):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["last_active"] = int(time.time())
                # move to front
                index.remove(entry)
                index.insert(0, entry)
                break
        cls.save_index(index)

    @classmethod
    def remove_from_index(cls, session_id: str):
        index = cls.load_index()
        index = [e for e in index if e["id"] != session_id]
        cls.save_index(index)

    @classmethod
    def append_message(cls, session_id: str, role: str, content: str, **extra):
        path = cls._session_path(session_id)
        entry = {"role": role, "content": content, "ts": int(time.time())}
        entry.update(extra)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    @classmethod
    def read_history(cls, session_id: str) -> list[dict]:
        path = cls._session_path(session_id)
        if not path.exists():
            return []
        result = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        result.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return result

    @classmethod
    def delete_session_files(cls, session_id: str):
        cls._session_path(session_id).unlink(missing_ok=True)
        cls.remove_from_index(session_id)


class ClaudeSession:
    """Manages a Claude Code session using --resume for continuity"""

    def __init__(self, session_id: str, workspace: str = WORKSPACE_DIR):
        self.id = session_id
        self.workspace = workspace
        self.claude_session_id: Optional[str] = None
        self.websocket: Optional[WebSocket] = None
        self.process: Optional[asyncio.subprocess.Process] = None
        self.last_active: float = time.monotonic()
        self._first_message = True

    def touch(self):
        self.last_active = time.monotonic()
        SessionStore.touch_index(self.id)

    async def send_and_stream(self, text: str):
        """Send message to Claude Code and stream output to WebSocket"""
        SessionStore.append_message(self.id, "user", text)
        self.touch()

        if self._first_message:
            title = text[:20] + ("..." if len(text) > 20 else "")
            SessionStore.update_title(self.id, title)
            self._first_message = False

        cmd = [
            "claude",
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions",
        ]

        if self.claude_session_id:
            cmd.extend(["--resume", self.claude_session_id])

        cmd.append(text)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workspace,
            env={**os.environ},
        )
        self.process = process

        await asyncio.gather(
            self._read_stdout(process),
            self._read_stderr(process),
        )
        self.process = None

    async def _read_stdout(self, process):
        if not process.stdout:
            return
        current_text = ""
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            try:
                data = json.loads(line.decode().strip())
                if data.get("type") == "system" and data.get("subtype") == "init":
                    self.claude_session_id = data.get("session_id")
                if self.websocket:
                    await self.websocket.send_json(data)
                    self.touch()
                # accumulate assistant text for persistence
                if data.get("type") == "assistant":
                    content = data.get("message", {}).get("content", [])
                    for block in content:
                        if block.get("type") == "text":
                            current_text += block.get("text", "")
                if data.get("type") == "result" and current_text:
                    SessionStore.append_message(self.id, "assistant", current_text)
                    current_text = ""
            except json.JSONDecodeError:
                if self.websocket:
                    try:
                        await self.websocket.send_json({"type": "raw", "content": line.decode().strip()})
                    except Exception:
                        pass

    async def _read_stderr(self, process):
        if not process.stderr:
            return
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            logger.warning("claude stderr: %s", line.decode().strip())

    async def stop(self):
        if self.process:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
            self.process = None


async def cleanup_expired_sessions():
    """Periodically remove sessions past TTL with no active WebSocket."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        expired = [
            sid for sid, s in sessions.items()
            if s.websocket is None and (now - s.last_active) > SESSION_TTL
        ]
        for sid in expired:
            await sessions[sid].stop()
            del sessions[sid]
        if expired:
            logger.info("Cleaned up %d expired session(s)", len(expired))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_data_dir()
    task = asyncio.create_task(cleanup_expired_sessions())
    yield
    task.cancel()
    for session in sessions.values():
        await session.stop()


app = FastAPI(title="Claude Code Web Bridge", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"status": "ok", "active_sessions": len(sessions)}


@app.post("/api/sessions")
async def create_session():
    # Auto-evict oldest sessions if at storage limit
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
    sessions[session_id] = ClaudeSession(session_id)
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


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    if session_id not in sessions:
        sessions[session_id] = ClaudeSession(session_id)
    session = sessions[session_id]
    session.websocket = websocket
    session.touch()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "message":
                asyncio.create_task(session.send_and_stream(data["content"]))
    except WebSocketDisconnect:
        session.websocket = None
    except Exception as e:
        logger.error("WebSocket error: %s", e)
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
        except Exception:
            pass
        session.websocket = None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
