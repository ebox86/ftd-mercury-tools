#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_PORT="${BRIDGE_PORT:-17344}"

MODE=""
PROXY_TARGET=""

if [[ -n "${MERCURY_BASE_URL:-}" ]]; then
  MODE="bridge"
  export MERCURY_SOAP_NAMESPACE="${MERCURY_SOAP_NAMESPACE:-http://localhost/webservices/}"

  echo "Starting workflow bridge server (SOAP -> /api/workflow)..."
  (
    export PORT="${BRIDGE_PORT}"
    cd "${ROOT_DIR}/workflow-bridge"
    npm install
    npm start
  ) &

  sleep 2
  PROXY_TARGET="http://127.0.0.1:${BRIDGE_PORT}"
elif [[ -n "${WORKFLOW_API_BASE_URL:-}" ]]; then
  MODE="direct"
  PROXY_TARGET="${WORKFLOW_API_BASE_URL}"
else
  echo "Set WORKFLOW_API_BASE_URL (direct /api host) OR MERCURY_BASE_URL (SOAP host)."
  exit 1
fi

export VITE_WORKFLOW_PROXY_TARGET="${PROXY_TARGET}"

echo "Starting kiosk app..."
(
  cd "${ROOT_DIR}/kiosk-app"
  npm install
  npm run dev -- --host
)

