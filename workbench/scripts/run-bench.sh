#!/bin/bash
set -e

# For Redis world, flush stale jobs before starting
if [[ "$WORKFLOW_TARGET_WORLD" == *"redis"* ]] && [[ -n "$WORKFLOW_REDIS_URI" ]]; then
  echo "Flushing Redis to clear stale jobs..."
  # Extract host and port from URI (redis://host:port)
  REDIS_HOST=$(echo "$WORKFLOW_REDIS_URI" | sed -E 's|redis://([^:]+):([0-9]+).*|\1|')
  REDIS_PORT=$(echo "$WORKFLOW_REDIS_URI" | sed -E 's|redis://([^:]+):([0-9]+).*|\2|')
  echo "FLUSHALL" | nc -w 2 "${REDIS_HOST:-localhost}" "${REDIS_PORT:-6379}" || echo "Warning: Could not flush Redis"
  sleep 1
fi

# Build the workbench
pnpm build

# Start the server in background
echo "Starting server..."
node .output/server/index.mjs &
SERVER_PID=$!

# Cleanup function to kill server on exit
cleanup() {
  echo "Stopping server (PID: $SERVER_PID)..."
  kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
echo "Waiting for server to start..."
for i in {1..30}; do
  if curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo "Server is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Server failed to start after 30 seconds"
    exit 1
  fi
  sleep 1
done

# Determine world name for timing file
WORLD_NAME=${WORKFLOW_TARGET_WORLD:-starter}
WORLD_NAME=${WORLD_NAME##*@workflow-worlds/}

# Run benchmarks
echo "Running benchmarks against $WORLD_NAME..."
DEPLOYMENT_URL=http://localhost:3000 WORLD_NAME=$WORLD_NAME pnpm exec vitest bench --run --outputJson=bench-results-$WORLD_NAME.json "$@"
