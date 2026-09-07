"""Session persistence layer - JSONL storage + index management."""
import json
import time
from pathlib import Path


class SessionStore:
    """JSONL-based session persistence."""

    _data_dir: Path = None

    @classmethod
    def _set_data_dir(cls, data_dir: Path):
        cls._data_dir = data_dir

    @staticmethod
    def _index_path() -> Path:
        return SessionStore._data_dir / "index.json"

    @staticmethod
    def _session_path(session_id: str) -> Path:
        return SessionStore._data_dir / f"{session_id}.jsonl"

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
    def update_title(cls, session_id: str, title: str, manually_set: bool = False):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["title"] = title
                if manually_set:
                    entry["title_manually_set"] = True
                break
        cls.save_index(index)

    @classmethod
    def is_title_manually_set(cls, session_id: str) -> bool:
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                if "title_manually_set" in entry:
                    return entry["title_manually_set"]
                return entry.get("title", "") != "新对话"
        return False

    @classmethod
    def save_claude_session_id(cls, session_id: str, claude_session_id: str):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["claude_session_id"] = claude_session_id
                break
        cls.save_index(index)

    @classmethod
    def load_claude_session_id(cls, session_id: str) -> str | None:
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                return entry.get("claude_session_id")
        return None

    @classmethod
    def update_summary(cls, session_id: str, summary: str, summary_generated_at: int):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["summary"] = summary
                entry["summary_generated_at"] = summary_generated_at
                break
        cls.save_index(index)

    @classmethod
    def get_summary(cls, session_id: str) -> tuple[str | None, int | None]:
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                return entry.get("summary"), entry.get("summary_generated_at")
        return None, None

    @classmethod
    def get_last_message_ts(cls, session_id: str) -> int:
        history = cls.read_history(session_id)
        if history:
            return history[-1].get("ts", 0)
        return 0

    @classmethod
    def touch_index(cls, session_id: str):
        index = cls.load_index()
        for entry in index:
            if entry["id"] == session_id:
                entry["last_active"] = int(time.time())
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
