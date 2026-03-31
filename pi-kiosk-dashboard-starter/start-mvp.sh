#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_PORT="${BRIDGE_PORT:-17344}"

echo "Starting Mercury workflow bridge..."
(
  export PORT="${BRIDGE_PORT}"
  cd "${ROOT_DIR}/workflow-bridge"
  npm install
  npm start
) &

sleep 2

echo "Starting kiosk app..."
(
  cd "${ROOT_DIR}/kiosk-app"
  npm install
  npm run dev -- --host
) &

echo "MVP boot started."
echo "Workflow API: http://127.0.0.1:${BRIDGE_PORT}/health"
echo "Kiosk UI: http://127.0.0.1:5173"

wait


