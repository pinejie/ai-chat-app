#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/backend/.pid"
LOGFILE="$DIR/backend/uvicorn.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "ZD Code already running (PID: $(cat "$PIDFILE"))"
    return 1
  fi
  cd "$DIR/backend"
  nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "ZD Code started (PID: $(cat "$PIDFILE"))"
  echo "http://localhost:8000"
}

stop() {
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "ZD Code stopped (PID: $PID)"
    else
      echo "Process $PID not running"
    fi
    rm -f "$PIDFILE"
  else
    pkill -f "uvicorn app.main:app" 2>/dev/null && echo "ZD Code stopped" || echo "ZD Code not running"
  fi
}

restart() {
  stop
  sleep 1
  start
}

case "${1:-}" in
  start)   start   ;;
  stop)    stop    ;;
  restart) restart ;;
  *)
    echo "Usage: $0 {start|stop|restart}"
    echo "  start   - 启动 ZD Code"
    echo "  stop    - 停止 ZD Code"
    echo "  restart - 重启 ZD Code"
    exit 1
    ;;
esac
