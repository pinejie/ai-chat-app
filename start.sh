#!/bin/bash
cd "$(dirname "$0")/backend"
nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > uvicorn.log 2>&1 &
echo $! > .pid
echo "ZD Code started (PID: $(cat .pid))"
echo "http://localhost:8000"
