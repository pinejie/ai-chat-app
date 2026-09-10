"""Claude Code session management - subprocess control + streaming + summary."""
import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket

from app.session_store import SessionStore

logger = logging.getLogger("claude-bridge")


class TraceBuilder:
    """Builds a structured trace from Claude Code stream-json events."""

    def __init__(self):
        self.spans: list[dict] = []
        self.start_time: float = 0
        self._pending_tools: dict[str, dict] = {}  # tool_use_id -> span
        self._llm_step = 0
        self._tool_names: list[str] = []  # for loop detection

    def begin(self):
        self.start_time = time.time()

    def process_event(self, data: dict) -> dict | None:
        """Process a stream-json event. Returns a trace event dict if something notable happened."""
        msg_type = data.get("type")
        msg = data.get("message", {})

        if msg_type == "assistant":
            content = msg.get("content", [])
            usage = msg.get("usage", {})
            events = []

            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")

                if btype == "tool_use":
                    tool_id = block.get("id", "")
                    tool_name = block.get("name", "unknown")
                    tool_input = block.get("input", {})
                    span = {
                        "type": "tool",
                        "name": tool_name,
                        "tool_id": tool_id,
                        "input_summary": _summarize_input(tool_name, tool_input),
                        "start": time.time(),
                        "end": None,
                        "status": "running",
                        "error": None,
                    }
                    self._pending_tools[tool_id] = span
                    self._tool_names.append(tool_name)
                    events.append({**span, "event": "tool_start"})

                elif btype == "tool_result":
                    tool_id = block.get("tool_use_id", "")
                    is_error = block.get("is_error", False)
                    result_content = block.get("content", "")
                    if tool_id in self._pending_tools:
                        span = self._pending_tools.pop(tool_id)
                        span["end"] = time.time()
                        span["status"] = "error" if is_error else "success"
                        span["duration"] = round(span["end"] - span["start"], 2)
                        if is_error:
                            span["error"] = str(result_content)[:300]
                        span["output_summary"] = str(result_content)[:200]
                        self.spans.append(span)
                        events.append({**span, "event": "tool_end"})

            if usage and usage.get("input_tokens", 0) > 0:
                self._llm_step += 1
                llm_span = {
                    "type": "llm",
                    "step": self._llm_step,
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "stop_reason": msg.get("stop_reason", "?"),
                    "ts": time.time(),
                }
                self.spans.append(llm_span)
                events.append({**llm_span, "event": "llm_call"})

            return {"type": "trace", "events": events} if events else None

        if msg_type == "result":
            return self._build_final_trace()

        return None

    def detect_issues(self) -> list[str]:
        """Detect potential problems in the trace."""
        issues = []

        # Loop detection: same tool called 3+ times in a row
        if len(self._tool_names) >= 6:
            recent = self._tool_names[-6:]
            for w in range(2, len(recent) // 2 + 1):
                pattern = recent[-w:]
                if recent[-(w * 2):-w] == pattern:
                    issues.append(f"循环检测: {' → '.join(pattern)} 重复执行")
                    break

        # Consecutive errors
        recent_spans = [s for s in self.spans if s.get("type") == "tool"][-5:]
        error_count = sum(1 for s in recent_spans if s.get("status") == "error")
        if error_count >= 3:
            issues.append(f"连续 {error_count} 个工具调用失败")

        return issues

    def _build_final_trace(self) -> dict:
        """Build the final summary trace event."""
        tool_spans = [s for s in self.spans if s.get("type") == "tool"]
        llm_spans = [s for s in self.spans if s.get("type") == "llm"]

        total_input = sum(s.get("input_tokens", 0) for s in llm_spans)
        total_output = sum(s.get("output_tokens", 0) for s in llm_spans)
        errors = [s for s in tool_spans if s.get("status") == "error"]

        # Tool frequency
        tool_freq = defaultdict(int)
        for s in tool_spans:
            tool_freq[s["name"]] += 1

        return {
            "type": "trace",
            "event": "trace_complete",
            "summary": {
                "total_tools": len(tool_spans),
                "total_llm_calls": len(llm_spans),
                "total_input_tokens": total_input,
                "total_output_tokens": total_output,
                "errors": len(errors),
                "tool_frequency": dict(tool_freq),
                "issues": self.detect_issues(),
                "duration": round(time.time() - self.start_time, 1) if self.start_time else 0,
            },
            "spans": [
                {k: v for k, v in s.items() if k not in ("start",)}
                for s in self.spans
            ],
        }

    def get_current_trace(self) -> dict:
        """Get current trace state (for API queries)."""
        return {
            "spans": self.spans,
            "issues": self.detect_issues(),
        }


def _summarize_input(tool_name: str, tool_input: dict) -> str:
    """Create a short summary of tool input for display."""
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        return cmd[:120] + ("..." if len(cmd) > 120 else "")
    elif tool_name in ("Read", "Write", "Edit"):
        return tool_input.get("file_path", "")
    elif tool_name == "Grep":
        return tool_input.get("pattern", "")
    else:
        s = json.dumps(tool_input, ensure_ascii=False)
        return s[:120] + ("..." if len(s) > 120 else "")


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
        self._stream_lock = asyncio.Lock()  # 同一对话同时只允许一个 claude 进程
        self.trace = TraceBuilder()
        self._debug_log_path: Optional[str] = None

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
        """Send message to Claude Code and stream output to WebSocket.
        同一对话同时只允许一个 claude 进程，新消息排队等待。"""
        async with self._stream_lock:
            await self._send_and_stream_impl(text, files)

    async def _send_and_stream_impl(self, text: str, files: list[str] = None):
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

        # Debug log for API-level tracing
        debug_dir = SessionStore.data_dir().parent / "debug-logs"
        debug_dir.mkdir(parents=True, exist_ok=True)
        self._debug_log_path = str(debug_dir / f"{self.id}-{int(time.time())}.log")
        cmd.extend(["--debug-file", self._debug_log_path])

        if files:
            file_info = "\n\n---\n用户上传的文件路径："
            for file_path in files:
                file_info += f"\n- {file_path}"
            file_info += "\n请使用 Read 工具读取这些文件内容。\n---"
            text = text + file_info

        cmd.append(text)

        # Reset trace for this round
        self.trace = TraceBuilder()
        self.trace.begin()

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

                # Build trace from stream events
                trace_event = self.trace.process_event(data)
                if trace_event and self.websocket:
                    try:
                        await self.websocket.send_json(trace_event)
                    except Exception:
                        pass

                if self.websocket:
                    await self.websocket.send_json(data)
                    self.touch()
                if data.get("type") == "assistant":
                    content = data.get("message", {}).get("content", [])
                    for block in content:
                        if block.get("type") == "text":
                            current_text += block.get("text", "")
                if data.get("type") == "result":
                    if current_text:
                        SessionStore.append_message(self.id, "assistant", current_text)
                        current_text = ""
                    # Save trace to disk
                    SessionStore.save_trace(self.id, self.trace)
                    # Send final trace summary
                    final = self.trace._build_final_trace()
                    if self.websocket:
                        try:
                            await self.websocket.send_json(final)
                        except Exception:
                            pass
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
