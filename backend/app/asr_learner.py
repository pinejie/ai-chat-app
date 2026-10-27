"""自动学习「同音纠错」热词：把用户的随手改字变成模型的记忆。

信号源：语音识别回填后，用户改了字又发送 ——（识别文本, 发送文本）的差值
就是免费的人工标注，不需要任何人手动维护词表。

判定链（difflib → jieba → pypinyin 三连，每步各挡一类噪声）：
  1. difflib 字符级对齐，只取 replace 区间——insert/delete 没有对照组，学不了；
  2. jieba 把差值区间扩成完整词——中文没有空格，按标点扩会整句粘连；
  3. pypinyin 无调拼音比对：同音异形 = 模型选错了字（学）；
     不同音 = 用户在改措辞，「今天→昨天」不收（挡掉大部分误学）；
     两侧分词不对称导致整段不同音时，收缩找最长等长同音子段，找不到即弃；
  4. 单字词不学（他→她、手滑打一个字都凑不出稳定专名）；
  5. 同一「错词→对词」累计满 PROMOTE_MIN 次才晋级——一次性笔误进不了词表。

排气阀：「已学热词」面板可删词，删掉的进 blocked 永不复学（自动学习必须可治理）。
权重 LEARNED_WEIGHT(10) < 人工名单(20)，同词以人工维护为准。

存储 backend/learned_hotwords.json（gitignored——热词是业务数据不是配置）；
写操作线程锁 + 临时文件原子替换；环境变量 ASR_LEARNED_FILE 可改路径（测试用）。
"""
import difflib
import json
import logging
import os
import re
import threading
import time
from pathlib import Path

import jieba
from pypinyin import lazy_pinyin

logger = logging.getLogger(__name__)

PROMOTE_MIN = 2          # 同一纠错观察累计次数门槛
LEARNED_WEIGHT = 10      # 学到的词权重：低于人工名单(20)，不喧宾夺主
MAX_LEARNED = 500        # 已学词表上限，防请求体无限膨胀
MAX_TEXT_LEN = 2000      # 单次 feedback 文本上限（diff 是 O(n²)，必须封顶）

_EDGE_TRIM = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)   # 去首尾标点/空白，CJK 属 \w 不会误伤

_lock = threading.Lock()
_state: dict | None = None   # 进程内唯一真相（只有本模块写这个文件）


class LearnerError(Exception):
    """学习状态文件不可写等治理类错误；路由层翻译成 5xx。"""


def _file() -> Path:
    spec = os.getenv("ASR_LEARNED_FILE", "learned_hotwords.json").strip() or "learned_hotwords.json"
    p = Path(spec)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent / spec   # 相对基准 = backend/，与热词文件同款
    return p


def _load() -> dict:
    global _state
    if _state is not None:
        return _state
    try:
        raw = json.loads(_file().read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, ValueError):
        raw = {}   # 首启无文件/文件损坏都按空状态起步，不阻塞识别
    _state = {"candidates": raw.get("candidates") or {},
              "learned": raw.get("learned") or {},
              "blocked": raw.get("blocked") or []}
    return _state


def _save(st: dict) -> None:
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        raise LearnerError(f"学习状态落盘失败: {e}") from e


def _cut_positions(text: str) -> list[tuple[int, int]]:
    out, pos = [], 0
    for w in jieba.cut(text):
        out.append((pos, pos + len(w)))
        pos += len(w)
    return out


def _word_covering(segs: list[tuple[int, int]], text: str, i1: int, i2: int) -> str:
    """把 [i1,i2) 差值区间扩成覆盖它的完整词（跨多个分词段则取并集区间）。"""
    start = end = None
    for s, e in segs:
        if s < i2 and e > i1:
            if start is None or s < start:
                start = s
            if end is None or e > end:
                end = e
    if start is None:
        return ""
    return _EDGE_TRIM.sub("", text[start:end])


def _pinyin(word: str) -> str:
    return " ".join(lazy_pinyin(word))


def _homophone_pair(wrong: str, right: str) -> tuple[str, str] | None:
    """同音判定。整段不同音时（两侧分词不对称所致）收缩找最长等长同音子段。"""
    if wrong == right or _pinyin(wrong) == _pinyin(right):
        return (wrong, right) if wrong != right else None
    n = min(len(wrong), len(right))
    for L in range(n - 1, 1, -1):          # ≥2 字（单字防御在这里也兜住）
        for ow in range(len(wrong) - L + 1):
            sw = wrong[ow:ow + L]
            for orr in range(len(right) - L + 1):
                sr = right[orr:orr + L]
                if sw != sr and _pinyin(sw) == _pinyin(sr):
                    return sw, sr
    return None


def record(recognized: str, final: str) -> list[str]:
    """喂一对（识别文本, 发送文本）。返回本次晋级的词。路由层调用。"""
    promoted: list[str] = []
    with _lock:
        st = _load()
        r_segs = _cut_positions(recognized)
        f_segs = _cut_positions(final)
        sm = difflib.SequenceMatcher(None, recognized, final, autojunk=False)
        seen: set[str] = set()
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag != "replace":
                continue
            wrong = _word_covering(r_segs, recognized, i1, i2)
            right = _word_covering(f_segs, final, j1, j2)
            if not wrong or not right or len(wrong) < 2 or len(right) < 2:
                continue                                   # 单字不学
            pair = _homophone_pair(wrong, right)
            if not pair:
                continue                                   # 不同音 = 改措辞
            wrong, right = pair
            key = f"{wrong}→{right}"
            if key in seen:
                continue                                   # 同一次发送只计一次
            seen.add(key)
            if right in st["blocked"]:
                continue                                   # 被删过 = 永不再学
            c = st["candidates"].setdefault(key, {"wrong": wrong, "right": right, "count": 0})
            c["count"] += 1
            c["updated"] = int(time.time())
            if c["count"] >= PROMOTE_MIN and right not in st["learned"]:
                if len(st["learned"]) >= MAX_LEARNED:
                    logger.warning("已学热词达上限 %d，%s 不再晋级", MAX_LEARNED, right)
                    continue
                st["learned"][right] = LEARNED_WEIGHT
                promoted.append(right)
                logger.info("ASR 学习热词：%s ← %s（第 %d 次纠错）", right, wrong, c["count"])
        _save(st)
    return promoted


def learned_words() -> dict[str, int]:
    with _lock:
        return dict(_load()["learned"])


def delete_learned(word: str) -> bool:
    """面板删除：移出 learned 并拉黑进 blocked（永不再学）。返回是否删到。"""
    with _lock:
        st = _load()
        hit = st["learned"].pop(word, None) is not None
        if hit and word not in st["blocked"]:
            st["blocked"].append(word)
            _save(st)
        return hit


def candidates() -> dict:
    """观察中的候选（面板暂不展示，留给排查学习为什么没生效）。"""
    with _lock:
        return dict(_load()["candidates"])
