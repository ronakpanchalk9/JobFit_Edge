#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
VENV_DIR="$PROJECT_DIR/.venv"
RUN_DIR="$PROJECT_DIR/.run"
LOG_FILE="$RUN_DIR/server.log"
PID_FILE="$RUN_DIR/server.pid"
PORT=8766

mkdir -p "$RUN_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install Python 3 and run ./start.sh again." >&2
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install -q -r requirements.txt

# Stop a prior JobFit server, including one started manually before this script existed.
if command -v lsof >/dev/null 2>&1; then
  LISTENERS="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  LISTENERS="$(fuser -n tcp "$PORT" 2>/dev/null || true)"
else
  echo "Install lsof (macOS) or fuser (Linux) so start.sh can restart the server on port ${PORT}." >&2
  exit 1
fi

if [[ -n "${LISTENERS//[[:space:]]/}" ]]; then
  while read -r PID; do
    [[ -z "$PID" ]] && continue
    kill "$PID" 2>/dev/null || true
  done <<< "$LISTENERS"
  for _ in {1..30}; do
    if ! (command -v lsof >/dev/null 2>&1 && lsof -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1); then
      break
    fi
    sleep 0.2
  done
fi

nohup "$VENV_DIR/bin/python" -m uvicorn server:app --host 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 </dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "JobFit helper is running at http://127.0.0.1:${PORT} (PID ${SERVER_PID})."
    echo "Log: ${LOG_FILE}"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "JobFit helper failed to start. Recent log output:" >&2
    tail -40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.25
done

echo "JobFit helper did not become ready. Recent log output:" >&2
tail -40 "$LOG_FILE" >&2 || true
exit 1
