"""多工作目录功能测试。

零新增依赖：标准库 unittest + httpx（随生产 TestClient 需要已在）。
隔离方式：不触发 lifespan，手动把 SessionStore 数据目录、模块全局
WORKSPACE_DIR、注册表文件指到 tmp 目录 —— 全程不碰生产 data/ 与 .env。
"""
import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("APP_TOKEN", "test-token")
os.environ.setdefault("WORKSPACE_DIR", "/tmp/zd-test-ws-default")

import httpx  # noqa: E402

from app import main as app_main  # noqa: E402
from app import workspace_registry as wsreg  # noqa: E402
from app.session_store import SessionStore  # noqa: E402

TOKEN = os.environ["APP_TOKEN"]


class Api:
    """轻量 ASGI 测试客户端。

    不用 fastapi TestClient：它对 httpx>=0.28 有兼容性问题（Client.__init__
    传 app= 参数被移除）。这里直接 httpx.AsyncClient + ASGITransport，
    每次请求独立事件循环，不依赖 lifespan。"""

    def _do(self, method, path, json):
        async def go():
            transport = httpx.ASGITransport(app=app_main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                         cookies={"zd_auth": TOKEN}) as c:
                return await c.request(method, path, json=json)
        return asyncio.run(go())

    def get(self, path): return self._do("GET", path, None)
    def post(self, path, json=None): return self._do("POST", path, json)
    def put(self, path, json=None): return self._do("PUT", path, json)
    def delete(self, path): return self._do("DELETE", path, None)


class WorkspaceTests(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="zd-ws-test-"))
        self.default_ws = self.tmp / "ws-default"
        self.default_ws.mkdir()
        app_main.WORKSPACE_DIR = str(self.default_ws)
        (self.tmp / "data").mkdir()
        SessionStore._set_data_dir(self.tmp / "data")
        wsreg.ensure_registry(str(self.default_ws))
        self.client = Api()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 注册表 ----

    def _add_dir(self, name, is_default=False):
        d = self.tmp / name
        d.mkdir(exist_ok=True)
        res = self.client.post("/api/workspaces", json={"name": name, "path": str(d), "is_default": is_default})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json(), d

    def test_registry_seeded_with_default(self):
        data = self.client.get("/api/workspaces").json()
        self.assertEqual(len(data["items"]), 1)
        self.assertTrue(data["items"][0]["is_default"])
        self.assertEqual(data["items"][0]["path"], str(self.default_ws))
        self.assertEqual(data["default_id"], data["items"][0]["id"])

    def test_add_validates_path_and_duplicate(self):
        r = self.client.post("/api/workspaces", json={"name": "x", "path": str(self.tmp / "nope")})
        self.assertEqual(r.status_code, 400)
        self._add_dir("ws-a")
        d = self.tmp / "ws-a"
        r = self.client.post("/api/workspaces", json={"name": "again", "path": str(d)})
        self.assertEqual(r.status_code, 400)  # 重复目录

    def test_default_cannot_be_deleted(self):
        items = wsreg.load()
        r = self.client.delete("/api/workspaces/" + items[0]["id"])
        self.assertEqual(r.status_code, 400)

    def test_default_handover_then_delete(self):
        old_id = wsreg.load()[0]["id"]
        new, _ = self._add_dir("ws-b")
        self.client.put("/api/workspaces/" + new["id"], json={"is_default": True})
        self.assertEqual(wsreg.default_item()["id"], new["id"])
        r = self.client.delete("/api/workspaces/" + old_id)
        self.assertEqual(r.status_code, 200)

    # ---- 会话绑定与快照 ----

    def test_session_binds_workspace_snapshot(self):
        ws2, _ = self._add_dir("ws-c")
        s = self.client.post("/api/sessions", json={"workspace_id": ws2["id"]}).json()
        self.assertEqual(s["workspace_path"], ws2["path"])
        entry = next(e for e in self.client.get("/api/sessions").json() if e["id"] == s["session_id"])
        self.assertEqual(entry["workspace_id"], ws2["id"])
        self.assertEqual(entry["workspace_path"], ws2["path"])
        # 注册表后续改路径，不影响已建对话的快照
        self.client.put("/api/workspaces/" + ws2["id"], json={"path": str(self.default_ws)})
        entry = next(e for e in self.client.get("/api/sessions").json() if e["id"] == s["session_id"])
        self.assertEqual(entry["workspace_path"], ws2["path"])

    def test_in_use_workspace_cannot_be_deleted(self):
        ws2, _ = self._add_dir("ws-d")
        self.client.post("/api/sessions", json={"workspace_id": ws2["id"]})
        r = self.client.delete("/api/workspaces/" + ws2["id"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("对话", r.json()["detail"])

    def test_fork_creates_copy_in_other_workspace(self):
        ws2, _ = self._add_dir("ws-e")
        s = self.client.post("/api/sessions", json={}).json()  # 默认目录
        f = self.client.post("/api/sessions/%s/fork" % s["session_id"],
                             json={"workspace_id": ws2["id"]}).json()
        entries = {e["id"]: e for e in self.client.get("/api/sessions").json()}
        self.assertTrue(f["forked"])
        self.assertTrue(entries[f["session_id"]]["title"].endswith("（副本）"))
        self.assertEqual(entries[f["session_id"]]["workspace_path"], ws2["path"])
        self.assertEqual(entries[s["session_id"]]["workspace_path"], str(self.default_ws))

    def test_fork_same_workspace_does_not_copy(self):
        ws2, _ = self._add_dir("ws-g")
        s = self.client.post("/api/sessions", json={"workspace_id": ws2["id"]}).json()
        f = self.client.post("/api/sessions/%s/fork" % s["session_id"],
                             json={"workspace_id": ws2["id"]}).json()
        self.assertFalse(f["forked"])
        self.assertEqual(f["session_id"], s["session_id"])
        entries = self.client.get("/api/sessions").json()
        self.assertEqual(len(entries), 1)  # 没产生副本
        self.assertFalse(any(e["title"].endswith("（副本）") for e in entries))

    def test_fork_legacy_session_falls_back_to_path(self):
        # 旧会话索引里没有 workspace_id，换目录比较退化为路径快照
        s = self.client.post("/api/sessions", json={}).json()  # 默认目录
        idx = SessionStore.load_index()
        next(e for e in idx if e["id"] == s["session_id"]).pop("workspace_id")
        SessionStore.save_index(idx)
        f = self.client.post("/api/sessions/%s/fork" % s["session_id"], json={}).json()
        self.assertFalse(f["forked"])
        self.assertEqual(f["session_id"], s["session_id"])
        ws2, _ = self._add_dir("ws-h")
        f2 = self.client.post("/api/sessions/%s/fork" % s["session_id"],
                              json={"workspace_id": ws2["id"]}).json()
        self.assertTrue(f2["forked"])
        self.assertNotEqual(f2["session_id"], s["session_id"])

    # ---- 列表排序（单一排序键 sort_order；查看/重连不跳位，只有 reorder 会变） ----

    def test_sessions_list_migrates_to_sort_order_without_changing_view(self):
        # 存量数据缺 sort_order：首次读取按 created 降序补号，屏幕顺序与旧契约一致
        a = self.client.post("/api/sessions", json={}).json()["session_id"]
        b = self.client.post("/api/sessions", json={}).json()["session_id"]
        c = self.client.post("/api/sessions", json={}).json()["session_id"]
        by_id = {e["id"]: e for e in SessionStore.load_index()}
        for sid, ts in ((a, 100), (b, 300), (c, 200)):
            by_id[sid].pop("sort_order", None)
            by_id[sid]["created"] = ts
        SessionStore.save_index([by_id[a], by_id[b], by_id[c]])  # 无排序键 + 乱序落盘
        ids = [e["id"] for e in self.client.get("/api/sessions").json()]
        self.assertEqual(ids[:3], [b, c, a])                     # 迁移即 created 降序
        idx = SessionStore.load_index()
        self.assertTrue(all("sort_order" in e for e in idx))     # 迁移已落盘
        SessionStore.save_index(list(reversed(idx)))             # 文件序颠倒、sort_order 未动
        self.assertEqual([e["id"] for e in self.client.get("/api/sessions").json()], ids)

    def test_reorder_persists_and_validates(self):
        for _ in range(3):
            self.client.post("/api/sessions", json={})
        ids = [e["id"] for e in self.client.get("/api/sessions").json()]
        rev = list(reversed(ids))
        r = self.client.post("/api/sessions/reorder", json={"ids": rev})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([e["id"] for e in self.client.get("/api/sessions").json()], rev)
        # 新建仍恒插最顶（add_to_index 取 min-1，与 created 解耦）
        d = self.client.post("/api/sessions", json={}).json()["session_id"]
        self.assertEqual(self.client.get("/api/sessions").json()[0]["id"], d)
        # 陈旧集合（少一个）与重复 ids 都拒绝，防覆盖并行变更
        self.assertEqual(self.client.post("/api/sessions/reorder", json={"ids": ids}).status_code, 400)
        self.assertEqual(self.client.post("/api/sessions/reorder",
                                          json={"ids": rev + [rev[0]]}).status_code, 400)
        self.assertEqual(self.client.post("/api/sessions/reorder", json={"ids": "x"}).status_code, 400)

    def test_touch_does_not_reorder_index(self):
        a = self.client.post("/api/sessions", json={}).json()["session_id"]
        b = self.client.post("/api/sessions", json={}).json()["session_id"]
        before = [e["id"] for e in SessionStore.load_index()]
        sess = app_main.sessions.get(b)
        self.assertIsNotNone(sess)
        sess.touch()                                             # 模拟打开/重连时的 touch
        self.assertEqual([e["id"] for e in SessionStore.load_index()], before)
        self.assertEqual(a, before[1])                           # touch 后 b 也没被插到最前

    def test_projects_api_follows_session(self):
        ws1, d1 = self._add_dir("ws-f")
        (d1 / "project").mkdir()
        (d1 / "project" / "a.md").write_text("内容A", encoding="utf-8")
        s1 = self.client.post("/api/sessions", json={"workspace_id": ws1["id"]}).json()
        r = self.client.get("/api/projects/content?path=a.md&session=" + s1["session_id"])
        self.assertEqual(r.json()["content"], "内容A")
        # 不带 session → 全局默认目录（tmp 下没有 project/a.md）
        r = self.client.get("/api/projects/content?path=a.md")
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
