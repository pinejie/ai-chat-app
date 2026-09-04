#!/bin/bash
PIDFILE="$(dirname "$0")/backend/.pid"
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
  echo "No PID file found, trying pkill..."
  pkill -f "uvicorn app.main:app" 2>/dev/null && echo "ZD Code stopped" || echo "ZD Code not running"
fi
