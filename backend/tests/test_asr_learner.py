"""同音纠错热词自动学习测试。

隔离方式与 test_workspaces 同款：环境变量指到 tmp、不触发 lifespan、
httpx.AsyncClient + ASGITransport。全程不碰生产 learned_hotwords.json。
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("APP_TOKEN", "test-token")

import urllib.parse

import httpx  # noqa: E402

from app import asr_learner  # noqa: E402
from app import asr_service  # noqa: E402
from app import main as app_main  # noqa: E402

# 人名同音错字（jieba 扩词后整段同音，核心正向场景）
REC_NAME = "这个事找庄叶辉确认一下"
FIN_NAME = "这个事找庄烨辉确认一下"


class LearnerBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="zd-learn-test-"))
        os.environ["ASR_LEARNED_FILE"] = str(self.tmp / "learned_hotwords.json")
        asr_learner._state = None   # 每个用例从空状态起步

    def tearDown(self):
        del os.environ["ASR_LEARNED_FILE"]
        asr_learner._state = None
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def learned(self):
        return asr_learner.learned_words()


class TestLearner(LearnerBase):
    def test_homophone_promotes_after_threshold(self):
        p1 = asr_learner.record(REC_NAME, FIN_NAME)
        self.assertEqual(p1, [])                       # 第 1 次只观察，不晋级
        self.assertEqual(self.learned(), {})
        p2 = asr_learner.record(REC_NAME, FIN_NAME)
        self.assertTrue(any("烨辉" in w for w in p2), p2)   # 第 2 次晋级
        w = next(w for w in self.learned() if "烨辉" in w)
        self.assertEqual(self.learned()[w], asr_learner.LEARNED_WEIGHT)

    def test_wording_change_ignored(self):
        for _ in range(3):
            asr_learner.record("今天天气不错", "昨天天气不错")
        self.assertEqual(self.learned(), {})           # jin≠zuo，改措辞不是听错

    def test_single_char_ignored(self):
        for _ in range(3):
            asr_learner.record("这件事找他办", "这件事找她办")
        self.assertEqual(self.learned(), {})           # 单字不学（ta 同音也不算）

    def test_itn_diff_ignored(self):
        for _ in range(3):
            asr_learner.record("会议改到二零二六", "会议改到2026")
        self.assertEqual(self.learned(), {})           # 数字规范化差异不学

    def test_identical_text_no_candidates(self):
        p = asr_learner.record(FIN_NAME, FIN_NAME)
        self.assertEqual(p, [])
        self.assertEqual(asr_learner.candidates(), {})

    def test_repeat_in_one_feedback_counts_once(self):
        rec = "找庄叶辉和庄叶辉"
        fin = "找庄烨辉和庄烨辉"
        asr_learner.record(rec, fin)                   # 同词两次出现
        asr_learner.record(rec, fin)                   # 第二次发送 → 累计 2 → 晋级
        self.assertTrue(any("烨辉" in w for w in self.learned()))

    def test_delete_blocks_forever(self):
        asr_learner.record(REC_NAME, FIN_NAME)
        asr_learner.record(REC_NAME, FIN_NAME)
        word = next(w for w in self.learned() if "烨辉" in w)
        self.assertTrue(asr_learner.delete_learned(word))
        self.assertNotIn(word, self.learned())
        for _ in range(5):
            asr_learner.record(REC_NAME, FIN_NAME)     # 拉黑后永不复学
        self.assertNotIn(word, self.learned())
        self.assertFalse(asr_learner.delete_learned("不存在的词"))

    def test_persistence_roundtrip(self):
        asr_learner.record(REC_NAME, FIN_NAME)
        asr_learner.record(REC_NAME, FIN_NAME)
        raw = json.loads(Path(os.environ["ASR_LEARNED_FILE"]).read_text(encoding="utf-8"))
        self.assertTrue(any("烨辉" in w for w in raw["learned"]))
        asr_learner._state = None                      # 模拟重启：从文件恢复
        self.assertTrue(any("烨辉" in w for w in self.learned()))


class TestCompose(unittest.TestCase):
    """请求侧合并：人工名单同名赢学习词权重。"""

    def test_human_wins_same_word(self):
        hwf = Path(tempfile.mkdtemp(prefix="zd-hw-test-")) / "hotwords.txt"
        hwf.write_text("庄烨辉 20\n", encoding="utf-8")
        words = asr_service.compose_hotwords(str(hwf))
        self.assertEqual(words.get("庄烨辉"), 20)      # 人工 20 覆盖学习 10


class TestApi(LearnerBase):
    """feedback / learned / delete 三个端点冒烟。"""
    TOKEN = os.environ["APP_TOKEN"]

    def api(self):
        transport = httpx.ASGITransport(app=app_main.app)
        return httpx.AsyncClient(transport=transport, base_url="http://t",
                                 cookies={"zd_auth": self.TOKEN})

    def run_async(self, fn):
        import asyncio
        return asyncio.run(fn)

    def test_feedback_flow(self):
        async def go():
            async with self.api() as c:
                r1 = await c.post("/api/asr/feedback",
                                  json={"recognized": REC_NAME, "final": FIN_NAME})
                assert r1.status_code == 200, r1.text
                assert r1.json()["promoted"] == []
                r2 = await c.post("/api/asr/feedback",
                                  json={"recognized": REC_NAME, "final": FIN_NAME})
                assert r2.json()["promoted"], r2.text
                g = await c.get("/api/asr/hotwords/learned")
                assert g.status_code == 200
                assert any("烨辉" in w for w in g.json()["hotwords"]), g.text
                word = next(w for w in g.json()["hotwords"] if "烨辉" in w)
                d = await c.delete(f"/api/asr/hotwords/{urllib.parse.quote(word, safe="")}")
                assert d.status_code == 200, d.text
                g2 = await c.get("/api/asr/hotwords/learned")
                assert word not in g2.json()["hotwords"]
                d2 = await c.delete(f"/api/asr/hotwords/{urllib.parse.quote(word, safe="")}")
                assert d2.status_code == 404
        self.run_async(go())

    def test_feedback_rejects_empty(self):
        async def go():
            async with self.api() as c:
                r = await c.post("/api/asr/feedback", json={"recognized": "  ", "final": "x"})
                assert r.status_code == 400
                r2 = await c.post("/api/asr/feedback", json={"recognized": "x"})
                assert r2.status_code == 422   # pydantic 缺字段
        self.run_async(go())


if __name__ == "__main__":
    unittest.main()
