#!/bin/bash
# ZD Code 前台启动脚本 —— 供 systemd ExecStart 使用（勿后台化，systemd 自己管）。
# 与 ai-chat-app.sh 的区别：那个是 nohup 手工管理（保留作回滚手段），这个只 exec 进程，
# 解释器固定用 .venv（终结「代码钉一套、系统 python 跑另一套」的漂移历史，见 requirements.txt）。
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="$DIR/.venv/bin/python"

# Claude CLI 装在 ~/bin，而 systemd 服务默认 PATH 不含该目录；不补上则后端
# spawn claude 子进程报 FileNotFoundError（2026-10-21 对话无反应事故根因）。
export PATH="$HOME/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: claude 不在 PATH（已含 $HOME/bin），拒绝启动。请检查 Claude CLI 安装。" >&2
  exit 1
fi

cd "$DIR/backend"
exec "$PYTHON" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
