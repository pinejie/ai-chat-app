"""语音转写客户端：对接 FunASR HTTP 网关（Whisper 风格 multipart 接口，详见部署文档）。

流程：前端上传任意格式录音（webm/opus、m4a/aac、wav…）→ ffmpeg 解码成
16kHz/单声道/s16 WAV → 一次 HTTP POST 上传 → 响应 JSON 取 text。

为什么保留 ffmpeg 而不直传原文件：网关文档称支持常见格式自动重采样，但实测
（2026-10-27）不识别浏览器 MediaRecorder 产出的 webm/opus，wav 正常；故统一
转码为 wav 再上传，兼容所有前端录音格式。

环境变量（backend/.env）：
  ASR_API_URL         FunASR 网关完整地址，如 http://172.33.6.15:10095/v1/audio/transcriptions（必填才能用）
  ASR_MAX_BYTES       上传大小上限，默认 10MB
  ASR_MAX_SECONDS     音频时长上限，默认 60s（超出截断，响应带 truncated）
  ASR_TIMEOUT         单次转写总超时，默认 20s（RTF≈0.04，富余很大）
  ASR_MAX_CONCURRENCY 本端并发上限，默认 6（服务端 8 路，留余量）
  ASR_HOTWORDS_FILE   热词表文件，默认 backend/hotwords.txt；每行「词 [权重]」，
                      # 注释与空行忽略；按 mtime 缓存，改文件下次请求即生效
"""
import asyncio
import json
import logging
import os
import uuid
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

WAV_BYTE_RATE = 16000 * 2   # 16kHz 单声道 s16：32000 字节/秒（用于时长/截断判断）
WAV_HEADER_SIZE = 44        # 标准 RIFF/WAVE 头，估算 PCM 长度用
TMP_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "asr_tmp"

_semaphore: asyncio.Semaphore | None = None   # 懒创建，避免 import 期绑错事件循环
_hotwords_cache: tuple[str, float, dict[str, int]] | None = None   # (路径, mtime, 词表)


class AsrError(Exception):
    """转写失败，由路由层翻译成对用户友好的错误。"""


def _cfg() -> dict:
    """调用期读取 env：改配置后重启即生效，测试注入也方便。"""
    url = os.getenv("ASR_API_URL", "").strip()
    if not url:
        raise AsrError("未配置 ASR_API_URL，语音功能不可用")
    return {
        "url": url,
        "max_bytes": int(os.getenv("ASR_MAX_BYTES", str(10 * 1024 * 1024))),
        "max_seconds": int(os.getenv("ASR_MAX_SECONDS", "60")),
        "timeout": float(os.getenv("ASR_TIMEOUT", "20")),
        "concurrency": int(os.getenv("ASR_MAX_CONCURRENCY", "6")),
        "hotwords_file": os.getenv("ASR_HOTWORDS_FILE", "hotwords.txt").strip() or "hotwords.txt",
    }


def _get_semaphore(limit: int) -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(limit)
    return _semaphore


async def _decode_to_wav(audio: bytes, suffix: str, max_seconds: int) -> bytes:
    """ffmpeg 解码：任意容器/采样率 → 16k 单声道 s16 WAV（stdout 直出，不落地中间文件）。"""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    in_path = TMP_DIR / f"asr_in_{uuid.uuid4().hex}{suffix}"
    try:
        in_path.write_bytes(audio)
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", str(in_path), "-t", str(max_seconds),
            "-ar", "16000", "-ac", "1", "-f", "wav", "-",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        wav, err = await proc.communicate()
        if proc.returncode != 0:
            raise AsrError(f"音频解码失败: {(err or b'').decode(errors='ignore')[:200]}")
        return wav
    finally:
        in_path.unlink(missing_ok=True)


def _load_hotwords(spec: str) -> dict[str, int]:
    """读热词表（每行「词 [权重]」，# 注释/空行忽略）；mtime 变化即重读，改文件无需重启。
    文件缺失或读失败按「无热词」降级——语音转写本身照常可用。"""
    global _hotwords_cache
    path = Path(spec)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / spec   # 相对路径基准 = backend/
    try:
        mtime = path.stat().st_mtime
    except OSError:
        logger.warning("ASR 热词文件不存在: %s（本次不带热词）", path)
        return {}
    if _hotwords_cache and _hotwords_cache[:2] == (str(path), mtime):
        return _hotwords_cache[2]
    words: dict[str, int] = {}
    try:
        for ln in path.read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            parts = ln.split()
            try:
                weight = int(parts[1]) if len(parts) > 1 else 20
            except ValueError:
                weight = 20
            words[parts[0]] = weight
    except OSError as e:
        logger.warning("ASR 热词文件读取失败: %s（本次不带热词）", e)
        return {}
    _hotwords_cache = (str(path), mtime, words)
    logger.info("ASR 热词已加载：%d 条（%s）", len(words), path.name)
    return words


def _hotwords_json(words: dict[str, int]) -> str:
    """组装网关要求的 JSON 权重格式（空表返回空串，不带该字段）。"""
    if not words:
        return ""
    return json.dumps(words, ensure_ascii=False)


def _status_error(code: int, detail: str) -> AsrError:
    """把网关状态码翻译成用户可读的原因（状态码语义见部署文档）。"""
    if code == 400:
        return AsrError("音频无法解析，请重新录制后重试")
    if code == 413:
        return AsrError("录音过大，请缩短后重试")
    if code in (502, 503):
        return AsrError("语音服务后端异常，请联系管理员检查 FunASR 服务")
    return AsrError(f"语音服务返回异常（HTTP {code}），请联系管理员")


async def _http_transcribe(cfg: dict, wav: bytes) -> str:
    """一次 multipart POST 整段转写，返回识别文本。"""
    form = {"itn": "true"}
    hw = _hotwords_json(_load_hotwords(cfg["hotwords_file"]))
    if hw:
        form["hotwords"] = hw
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(cfg["timeout"], connect=5.0)
    ) as client:
        resp = await client.post(
            cfg["url"],
            files={"file": ("zd-code.wav", wav, "audio/wav")},
            data=form,
        )
    if resp.status_code != 200:
        raise _status_error(resp.status_code, resp.text)
    return resp.json().get("text", "")


async def transcribe(audio: bytes, suffix: str) -> dict:
    """入口：并发受限流。返回 {text, truncated}。"""
    cfg = _cfg()
    if len(audio) > cfg["max_bytes"]:
        raise AsrError("录音过大（上限约 60 秒），请缩短后重试")
    async with _get_semaphore(cfg["concurrency"]):
        wav = await _decode_to_wav(audio, suffix, cfg["max_seconds"])
        if len(wav) <= WAV_HEADER_SIZE:
            raise AsrError("音频解码结果为空，可能是静音或损坏的录音")
        try:
            text = await _http_transcribe(cfg, wav)
        except httpx.TimeoutException:
            raise AsrError("识别超时，请重试；若持续超时请联系管理员检查 ASR 服务")
        except httpx.HTTPError as e:
            logger.error("ASR 服务连接异常: %s", e)
            raise AsrError("语音服务连接失败，请联系管理员确认 ASR 服务状态")
        truncated = (len(wav) - WAV_HEADER_SIZE) >= cfg["max_seconds"] * WAV_BYTE_RATE
        return {"text": text, "truncated": truncated}
