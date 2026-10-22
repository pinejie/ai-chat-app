"""工作目录注册表：集中管理可供对话选择的工作目录。

数据文件 data/workspaces.json，结构 [{id, name, path, is_default}]。
设计约束（与需求评审一致）：
- 必须且只有一个默认目录：新建对话默认落到它；默认条目不可删除。
- 被对话引用中的条目不可删除（引用计数由调用方查会话索引得出）。
- 会话创建时把 path 冗余写进会话索引（workspace_path），注册表后续
  改名/改路径不影响已建对话——对话的目录以索引里的快照为准。
"""
import json
import os
import time
import uuid

from app.session_store import SessionStore


def registry_file():
    return SessionStore.data_dir() / "workspaces.json"


def load() -> list[dict]:
    path = registry_file()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def save(items: list[dict]):
    registry_file().write_text(
        json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def normalize_path(raw: str) -> str:
    """展开 ~、转绝对路径。注册表存的一定是绝对路径。"""
    return os.path.abspath(os.path.expanduser((raw or "").strip()))


def ensure_registry(default_path: str):
    """首次启动迁移：把旧全局 WORKSPACE_DIR 收编为唯一默认条目，无缝升级。"""
    items = load()
    if items:
        return
    p = normalize_path(default_path)
    items = [{
        "id": uuid.uuid4().hex[:8],
        "name": "默认目录",
        "path": p,
        "is_default": True,
        "created": int(time.time()),
    }]
    save(items)


def get(wid: str) -> dict | None:
    for item in load():
        if item["id"] == wid:
            return item
    return None


def default_item() -> dict:
    items = load()
    for item in items:
        if item.get("is_default"):
            return item
    if items:
        return items[0]
    raise RuntimeError("工作目录注册表为空（ensure_registry 未执行？）")


def add(name: str, path: str, is_default: bool = False) -> dict:
    """新增目录条目。path 必须是已存在的目录；is_default=True 会移交默认权。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("名称不能为空")
    p = normalize_path(path)
    if not os.path.isdir(p):
        raise ValueError(f"目录不存在或不是目录：{p}")
    items = load()
    if any(item["path"] == p for item in items):
        raise ValueError("该目录已在列表中")
    item = {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "path": p,
        "is_default": bool(is_default),
        "created": int(time.time()),
    }
    if item["is_default"]:
        for other in items:
            other["is_default"] = False
    items.append(item)
    save(items)
    return item


def update(wid: str, name: str | None = None, path: str | None = None,
           is_default: bool | None = None) -> dict:
    """编辑条目。注意：已创建的对话用的是自己索引里的路径快照，不受此处改动影响。"""
    items = load()
    target = None
    for item in items:
        if item["id"] == wid:
            target = item
            break
    if target is None:
        raise KeyError(wid)
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("名称不能为空")
        target["name"] = name
    if path is not None:
        p = normalize_path(path)
        if not os.path.isdir(p):
            raise ValueError(f"目录不存在或不是目录：{p}")
        target["path"] = p
    if is_default is not None:
        target["is_default"] = bool(is_default)
    if target.get("is_default"):
        for other in items:
            if other["id"] != wid:
                other["is_default"] = False
    # 默认权唯一性兜底：不许把最后一个默认改名成非默认
    if not any(item.get("is_default") for item in items):
        target["is_default"] = True
    save(items)
    return target


def delete(wid: str, usage_count: int) -> bool:
    """删除条目。调用方负责传入引用计数；这里再兜底两层硬约束。"""
    items = load()
    target = next((item for item in items if item["id"] == wid), None)
    if target is None:
        return False
    if target.get("is_default"):
        raise ValueError("默认目录不可删除，请先将默认移给其他目录")
    if usage_count > 0:
        raise ValueError(f"有 {usage_count} 个对话在使用该目录，不能删除")
    save([item for item in items if item["id"] != wid])
    return True
