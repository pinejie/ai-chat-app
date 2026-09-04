#!/bin/bash
DIR="$(dirname "$0")"
bash "$DIR/stop.sh"
sleep 1
bash "$DIR/start.sh"
