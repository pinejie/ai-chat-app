"""Claude Code session management - subprocess control + streaming + history recovery."""
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
    """Manages a Claude Code session using --resume for continuity.

    Context management:
    - 正常流程：依赖 Claude Code 自身压缩，ai-chat-app 不干预
    - 恢复流程：session 丢失时，从 JSONL 读历史 → 分批调 Claude Code 压缩
      （--resume 串联）→ 第一批成功后立即记录 session_id
      → 失败重试 → 再失败只压缩最后一批 → 再失败放弃
    """

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
        self._first_message = not SessionStore.is_title_manually_set(session_id)
        self._stream_lock = asyncio.Lock()
        self.trace = TraceBuilder()
        self._debug_log_path: Optional[str] = None
        self._last_stderr: str = ""
        self._last_result_is_error: bool = False
        self._last_error_text: str = ""

    def touch(self):
        self.last_active = time.monotonic()
        SessionStore.touch_index(self.id)

    async def send_and_stream(self, text: str, files: list[str] = None):
        """Send message to Claude Code and stream output to WebSocket.
        同一对话同时只允许一个 claude 进程，新消息排队等待。"""
        async with self._stream_lock:
            # 检测是否需要恢复（无 session_id 但有历史）
            if not self.claude_session_id:
                history = SessionStore.read_history(self.id)
                if history:
                    await self._recover_from_history(history, text, files)
                    return
            await self._send_and_stream_impl(text, files)

    async def _send_and_stream_impl(self, text: str, files: list[str] = None):
        SessionStore.append_message(self.id, "user", text, files=files)
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

        # Reset trace and error flag for this round
        self.trace = TraceBuilder()
        self.trace.begin()
        self._last_result_is_error = False
        self._last_error_text = ""

        # prompt 走 stdin，避免超长消息触发 Linux 128KB argv 限制 (E2BIG)
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workspace,
            env={**os.environ},
        )
        self.process = process

        async def _feed_stdin(proc):
            try:
                proc.stdin.write(text.encode("utf-8"))
                await proc.stdin.drain()
            finally:
                proc.stdin.close()

        try:
            await asyncio.gather(
                _feed_stdin(process),
                self._read_stdout(process),
                self._read_stderr(process),
            )
        finally:
            self.process = None

        # Check if --resume failed due to session loss
        # Claude Code outputs errors as JSON result to stdout (is_error=true), not always to stderr
        had_resume = self.claude_session_id is not None and "--resume" in cmd
        logger.warning(f"After gather: had_resume={had_resume}, returncode={process.returncode}, is_error={self._last_result_is_error}")
        logger.warning(f"Error text: '{self._last_error_text}', stderr: '{self._last_stderr[:200]}'")
        if had_resume and (self._last_result_is_error or process.returncode != 0):
            combined_text = self._last_error_text + " " + self._last_stderr
            is_session_not_found = self._is_session_not_found(combined_text)
            logger.warning(f"combined_text: '{combined_text[:200]}', is_session_not_found: {is_session_not_found}")
            if is_session_not_found:
                logger.warning(
                    "Session %s lost (resume failed), entering recovery",
                    self.claude_session_id,
                )
                # Notify frontend immediately before clearing session_id
                logger.warning(f"Session lost: websocket={'connected' if self.websocket else 'None'}")
                if self.websocket:
                    try:
                        await self.websocket.send_json({
                            "type": "recovery_start",
                            "content": "正在恢复上下文，请稍候...",
                        })
                        logger.warning("Sent recovery_start to frontend")
                    except Exception as e:
                        logger.warning(f"Failed to send recovery_start: {e}")
                self.claude_session_id = None
                SessionStore.clear_claude_session_id(self.id)
                # Enter recovery flow
                history = SessionStore.read_history(self.id)
                if history:
                    await self._recover_from_history(history, text, files)
                else:
                    # No history, just notify and start fresh
                    if self.websocket:
                        try:
                            await self.websocket.send_json({
                                "type": "error",
                                "content": "会话已丢失，已开始新对话",
                            })
                        except Exception:
                            pass

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
                    # Detect error results (e.g. session not found)
                    if data.get("is_error"):
                        self._last_result_is_error = True
                        errors = data.get("errors", [])
                        self._last_error_text = " ".join(errors) if errors else ""
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
        self._last_stderr = ""
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace")
            self._last_stderr += text
            logger.warning("claude stderr: %s", text.strip())

    @staticmethod
    def _is_session_not_found(stderr: str) -> bool:
        """Detect if session was lost (for --resume failures)."""
        error_patterns = [
            "Session not found",
            "Failed to load session",
            "session does not exist",
            "invalid session",
            "could not find session",
            "No conversation found",
        ]
        return any(p in stderr for p in error_patterns)

    # ─── History recovery ───────────────────────────────────────────────

    async def _recover_from_history(self, history: list[dict], text: str, files: list[str]):
        """从历史记录恢复上下文。

        触发条件：无 claude_session_id 但有历史消息。
        流程：分批压缩（--resume 串联）→ 第一批成功后立即记录 session_id
              → 某批失败重试 → 仍失败则降级为只压缩最后一批 → 仍失败则放弃。
        """

        batches = [history[i:i + 20] for i in range(0, len(history), 20)]

        recovery_session_id = None
        accumulated_summary = ""

        for i, batch in enumerate(batches):
            success = False

            for attempt in range(2):  # 最多重试 1 次
                try:
                    result = await self._send_batch(
                        batch, recovery_session_id, accumulated_summary,
                        is_first=(recovery_session_id is None)
                    )

                    # 第一批成功后立即保存 session_id
                    if not recovery_session_id and result["session_id"]:
                        recovery_session_id = result["session_id"]
                        self.claude_session_id = recovery_session_id
                        SessionStore.save_claude_session_id(self.id, recovery_session_id)
                        logger.info(f"Recovery: session {recovery_session_id} saved after batch 1")

                    # --resume 失败：session 中途丢失
                    if recovery_session_id and result.get("session_lost"):
                        logger.warning(f"Recovery: session {recovery_session_id} lost at batch {i + 1}")
                        recovery_session_id = None
                        self.claude_session_id = None
                        SessionStore.clear_claude_session_id(self.id)
                        break  # 跳出重试，进入降级

                    accumulated_summary = result["summary"]
                    success = True
                    break

                except Exception as e:
                    logger.error(f"Recovery: batch {i + 1} attempt {attempt + 1} failed: {e}")

            if not success:
                # 重试后仍失败 → 降级：只压缩最后一批
                logger.warning(f"Recovery: batch {i + 1} failed after retry, falling back to last batch")
                recovery_session_id = await self._fallback_to_last_batch(history)
                if not recovery_session_id:
                    # 降级也失败 → 放弃恢复，开新会话
                    await self._notify_recovery_failed()
                    await self._send_and_stream_impl(text, files)
                    return
                accumulated_summary = ""
                break

        # 恢复完成，发送用户消息（带摘要上下文）
        if accumulated_summary:
            recovery_text = (
                f"[以下是之前对话历史的压缩摘要，请据此理解上下文]\n\n"
                f"{accumulated_summary}\n\n"
                f"[用户新消息]\n{text}"
            )
        else:
            recovery_text = text

        # 通知前端恢复完成
        if self.websocket:
            try:
                await self.websocket.send_json({
                    "type": "recovery_complete",
                    "content": "上下文恢复完成",
                })
            except Exception:
                pass

        await self._send_and_stream_impl(recovery_text, files)

    async def _send_batch(
        self, batch: list[dict], session_id: Optional[str],
        prev_summary: str, is_first: bool
    ) -> dict:
        """发送一批历史给 Claude Code 压缩。不流式输出，只拿结果。"""
        cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose"]
        cmd.extend(["--permission-mode", self.permission_mode])

        if session_id:
            cmd.extend(["--resume", session_id])

        prompt = self._build_batch_prompt(batch, prev_summary, is_first)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workspace,
            env={**os.environ},
        )
        stdout_data, stderr_data = await process.communicate(input=prompt.encode("utf-8"))
        stderr_text = stderr_data.decode("utf-8", errors="replace")
        stdout_text = stdout_data.decode("utf-8", errors="replace")

        result = {"session_id": None, "summary": "", "session_lost": False}

        # Check for error result in stdout (Claude Code outputs errors as JSON, not stderr)
        has_error = False
        for line in stdout_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if data.get("type") == "result" and data.get("is_error"):
                    has_error = True
                    # Check if it's a session-not-found error
                    errors = data.get("errors", [])
                    error_text = " ".join(errors) if errors else ""
                    if session_id and self._is_session_not_found(error_text):
                        result["session_lost"] = True
                        return result
            except json.JSONDecodeError:
                pass

        # Also check stderr for session-not-found (older versions may write there)
        if session_id and self._is_session_not_found(stderr_text):
            result["session_lost"] = True
            return result

        if has_error or process.returncode != 0:
            raise RuntimeError(f"claude exited with code {process.returncode}: {stderr_text[:200]}")

        full_output = ""
        for line in stdout_data.decode("utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if data.get("type") == "system" and data.get("subtype") == "init":
                    result["session_id"] = data.get("session_id")
                if data.get("type") == "assistant":
                    for block in data.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            full_output += block.get("text", "")
            except json.JSONDecodeError:
                pass

        result["summary"] = full_output.strip()
        return result

    async def _fallback_to_last_batch(self, history: list[dict]) -> Optional[str]:
        """降级：只压缩最后一批（最近 20 条）。"""
        last_batch = history[-20:] if len(history) > 20 else history
        try:
            result = await self._send_batch(last_batch, None, "", is_first=True)
            if result["session_id"]:
                self.claude_session_id = result["session_id"]
                SessionStore.save_claude_session_id(self.id, result["session_id"])
                logger.info(f"Fallback: session {result['session_id']} saved")
            return result["session_id"]
        except Exception as e:
            logger.error(f"Fallback failed: {e}")
            return None

    @staticmethod
    def _build_batch_prompt(batch: list[dict], prev_summary: str, is_first: bool) -> str:
        """构建分批压缩的 prompt。"""
        conv_lines = []
        for msg in batch:
            role = "用户" if msg.get("role") == "user" else "助手"
            content = msg.get("content", "")
            conv_lines.append(f"{role}: {content}")
        conv_text = "\n".join(conv_lines)

        if is_first or not prev_summary:
            return (
                "请将以下对话记录压缩为结构化摘要，必须包含：\n"
                "1. 背景与目标\n"
                "2. 关键结论与决策\n"
                "3. 具体产物（完整保留 SQL 语句、代码片段、文件路径、配置值，不要省略或改写）\n"
                "4. 待办与未完成事项\n"
                "5. 最近要点\n\n"
                "用中文输出。只输出摘要本身，不要其他废话。\n\n"
                f"以下是需要压缩的对话记录：\n\n{conv_text}"
            )
        else:
            return (
                "以下是之前批次的摘要：\n\n"
                f"{prev_summary}\n\n"
                "---\n\n"
                "请将以上摘要与以下新增对话合并压缩，保留关键信息，"
                "完整保留 SQL、代码、文件路径等技术细节。\n"
                "用中文输出。只输出合并后的摘要，不要其他废话。\n\n"
                f"以下是新增对话记录：\n\n{conv_text}"
            )

    # ─── Recovery notifications ──────────────────────────────────────────

    async def _notify_recovery_start(self):
        """通知前端正在恢复上下文。"""
        if self.websocket:
            try:
                await self.websocket.send_json({
                    "type": "recovery_start",
                    "content": "正在恢复上下文，请稍候...",
                })
            except Exception:
                pass

    async def _notify_recovery_failed(self):
        """通知前端恢复失败。"""
        if self.websocket:
            try:
                await self.websocket.send_json({
                    "type": "recovery_failed",
                    "content": "恢复失败，已开始新会话",
                })
            except Exception:
                pass

    async def stop(self):
        if self.process:
            proc = self.process
            self.process = None
            try:
                proc.terminate()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    return
                await proc.wait()
