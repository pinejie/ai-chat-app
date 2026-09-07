"""Claude Code session management - subprocess control + streaming + summary."""
import asyncio
import json
import logging
import os
from typing import Optional

from fastapi import WebSocket

from app.session_store import SessionStore

logger = logging.getLogger("claude-bridge")


class ClaudeSession:
    """Manages a Claude Code session using --resume for continuity"""

    AVAILABLE_MODES = [
        {"id": "default", "name": "默认", "description": "每次工具调用都询问权限"},
        {"id": "acceptEdits", "name": "自动编辑", "description": "自动接受编辑，其他仍询问"},
        {"id": "plan", "name": "计划模式", "description": "只分析规划，不执行操作"},
        {"id": "auto", "name": "自动模式", "description": "自动处理大部分操作"},
        {"id": "bypassPermissions", "name": "无限制", "description": "跳过所有权限检查"},
    ]

    def __init__(self, session_id: str, workspace: str, permission_mode: str = "bypassPermissions"):
        self.id = session_id
        self.workspace = workspace
        self.permission_mode = permission_mode
        self.claude_session_id: Optional[str] = SessionStore.load_claude_session_id(session_id)
        self.websocket: Optional[WebSocket] = None
        self.process: Optional[asyncio.subprocess.Process] = None
        self.last_active: float = 0
        self._summary: Optional[str] = None
        self._first_message = not SessionStore.is_title_manually_set(session_id)

    def touch(self):
        import time
        self.last_active = time.monotonic()
        SessionStore.touch_index(self.id)

    def _load_and_check_summary(self) -> str | None:
        """Load summary if valid (covers all messages before current one)."""
        summary, generated_at = SessionStore.get_summary(self.id)
        if not summary or not generated_at:
            return None
        history = SessionStore.read_history(self.id)
        if len(history) >= 2:
            prev_ts = history[-2].get("ts", 0)
            if generated_at >= prev_ts:
                self._summary = summary
                return summary
        return None

    async def send_and_stream(self, text: str, files: list[str] = None):
        """Send message to Claude Code and stream output to WebSocket"""
        SessionStore.append_message(self.id, "user", text, files=files)
        self.touch()

        if self._first_message:
            title = text[:20] + ("..." if len(text) > 20 else "")
            SessionStore.update_title(self.id, title)
            self._first_message = False

        # Inject summary if --resume is not available (no session_id)
        summary = self._load_and_check_summary()
        if summary and not self.claude_session_id:
            text = f"[以下是之前对话的摘要，请据此理解上下文]\n{summary}\n\n[用户新问题]\n{text}"

        cmd = [
            "claude",
            "-p",
            "--output-format", "stream-json",
            "--verbose",
        ]

        cmd.extend(["--permission-mode", self.permission_mode])

        if self.claude_session_id:
            cmd.extend(["--resume", self.claude_session_id])

        if files:
            file_info = "\n\n---\n用户上传的文件路径："
            for file_path in files:
                file_info += f"\n- {file_path}"
            file_info += "\n请使用 Read 工具读取这些文件内容。\n---"
            text = text + file_info

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
                    SessionStore.save_claude_session_id(self.id, self.claude_session_id)
                if self.websocket:
                    await self.websocket.send_json(data)
                    self.touch()
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

    @staticmethod
    async def _generate_summary(session_id: str):
        """Generate summary for a session using claude CLI."""
        history = SessionStore.read_history(session_id)
        if not history:
            return

        conv_lines = []
        for msg in history:
            role = "用户" if msg.get("role") == "user" else "助手"
            conv_lines.append(f"{role}: {msg.get('content', '')}")
        conv_text = "\n".join(conv_lines)

        prompt = (
            "请总结以下对话的关键信息，包括：项目背景、已解决的问题、技术决策、待办事项。"
            "用简洁的中文回答，控制在200字以内。只输出摘要内容，不要其他废话。\n\n"
            f"{conv_text}"
        )

        workspace = os.getenv("WORKSPACE_DIR", os.path.expanduser("~/workspace"))

        try:
            process = await asyncio.create_subprocess_exec(
                "claude", "--bare", "-p", "--output-format", "stream-json", "--verbose", prompt,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workspace,
                env={**os.environ},
            )
            full_output = ""
            claude_sid = None
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.decode().strip())
                    if data.get("type") == "system" and data.get("subtype") == "init":
                        claude_sid = data.get("session_id")
                    if data.get("type") == "assistant":
                        content_blocks = data.get("message", {}).get("content", [])
                        for block in content_blocks:
                            if block.get("type") == "text":
                                full_output += block.get("text", "")
                except json.JSONDecodeError:
                    pass
            await process.wait()

            if full_output.strip():
                import time
                last_ts = history[-1].get("ts", int(time.time()))
                SessionStore.update_summary(session_id, full_output.strip(), last_ts)
                if claude_sid:
                    SessionStore.save_claude_session_id(session_id, claude_sid)
                logger.info(f"Summary generated for session {session_id}")
        except Exception as e:
            logger.error(f"Failed to generate summary for session {session_id}: {e}")
