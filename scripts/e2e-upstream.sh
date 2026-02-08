#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# e2e-upstream.sh - Run vercel/workflow e2e tests against local world builds
#
# Usage:
#   ./scripts/e2e-upstream.sh <world-id> [options]
#
# Examples:
#   ./scripts/e2e-upstream.sh starter          # In-memory, no services needed
#   ./scripts/e2e-upstream.sh turso            # File-based SQLite
#   ./scripts/e2e-upstream.sh mongodb          # Requires Docker (mongo:7)
#   ./scripts/e2e-upstream.sh redis            # Requires Docker (redis:7-alpine)
#   ./scripts/e2e-upstream.sh starter --clean  # Fresh clone of upstream repo
#   ./scripts/e2e-upstream.sh starter --dev-tests  # Also run HMR dev tests
#
# Environment:
#   E2E_UPSTREAM_DIR    Override upstream clone location (default: .e2e-upstream)
#   E2E_UPSTREAM_REF    Git ref to checkout (default: main)
#   E2E_APP_NAME        Workbench app to test (default: nextjs-turbopack)
#   E2E_SKIP_BUILD      Skip building upstream packages (default: false)
#   E2E_KEEP_SERVICES   Don't stop Docker services on exit (default: false)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UPSTREAM_DIR="${E2E_UPSTREAM_DIR:-$ROOT_DIR/.e2e-upstream}"
UPSTREAM_REF="${E2E_UPSTREAM_REF:-main}"
UPSTREAM_REPO="https://github.com/vercel/workflow.git"
APP_NAME="${E2E_APP_NAME:-nextjs-turbopack}"
SKIP_BUILD="${E2E_SKIP_BUILD:-false}"
KEEP_SERVICES="${E2E_KEEP_SERVICES:-false}"

RUN_DEV_TESTS=false
CLEAN=false

# --- Colors ----------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- World Configuration ---------------------------------------------------

declare -A WORLD_PACKAGE
WORLD_PACKAGE[starter]="@workflow-worlds/starter"
WORLD_PACKAGE[turso]="@workflow-worlds/turso"
WORLD_PACKAGE[mongodb]="@workflow-worlds/mongodb"
WORLD_PACKAGE[redis]="@workflow-worlds/redis"

declare -A WORLD_LOCAL_DIR
WORLD_LOCAL_DIR[starter]="$ROOT_DIR/packages/starter"
WORLD_LOCAL_DIR[turso]="$ROOT_DIR/packages/turso"
WORLD_LOCAL_DIR[mongodb]="$ROOT_DIR/packages/mongodb"
WORLD_LOCAL_DIR[redis]="$ROOT_DIR/packages/redis"

declare -A WORLD_SERVICE
WORLD_SERVICE[starter]="none"
WORLD_SERVICE[turso]="none"
WORLD_SERVICE[mongodb]="mongodb"
WORLD_SERVICE[redis]="redis"

declare -A WORLD_SETUP
WORLD_SETUP[starter]=""
WORLD_SETUP[turso]="pnpm exec workflow-turso-setup"
WORLD_SETUP[mongodb]=""
WORLD_SETUP[redis]=""

# Environment variables per world (newline-separated KEY=VALUE pairs)
declare -A WORLD_ENV
WORLD_ENV[starter]="WORKFLOW_TARGET_WORLD=@workflow-worlds/starter"
WORLD_ENV[turso]="WORKFLOW_TARGET_WORLD=@workflow-worlds/turso
WORKFLOW_TURSO_DATABASE_URL=file:$UPSTREAM_DIR/workbench/$APP_NAME/workflow.db"
WORLD_ENV[mongodb]="WORKFLOW_TARGET_WORLD=@workflow-worlds/mongodb
WORKFLOW_MONGODB_URI=mongodb://localhost:27017
WORKFLOW_MONGODB_DATABASE_NAME=workflow"
WORLD_ENV[redis]="WORKFLOW_TARGET_WORLD=@workflow-worlds/redis
WORKFLOW_REDIS_URI=redis://localhost:6379"

# --- Functions --------------------------------------------------------------

usage() {
  echo -e "${BOLD}Usage:${NC} $0 <world-id> [options]"
  echo ""
  echo -e "${BOLD}World IDs:${NC}"
  echo "  starter    In-memory world (no external services)"
  echo "  turso      Turso/libSQL world (file-based, no services)"
  echo "  mongodb    MongoDB world (requires Docker)"
  echo "  redis      Redis world (requires Docker)"
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo "  --clean       Remove and re-clone the upstream repo"
  echo "  --dev-tests   Also run dev server HMR tests"
  echo "  -h, --help    Show this help message"
  echo ""
  echo -e "${BOLD}Environment Variables:${NC}"
  echo "  E2E_UPSTREAM_DIR    Override upstream clone location (default: .e2e-upstream)"
  echo "  E2E_UPSTREAM_REF    Git ref to checkout (default: main)"
  echo "  E2E_APP_NAME        Workbench app to test (default: nextjs-turbopack)"
  echo "  E2E_SKIP_BUILD      Skip building upstream packages if set to 'true'"
  echo "  E2E_KEEP_SERVICES   Don't stop Docker services on exit if set to 'true'"
}

log() {
  echo -e "${BLUE}[e2e]${NC} $*"
}

log_step() {
  echo -e "\n${CYAN}${BOLD}==> $*${NC}"
}

log_success() {
  echo -e "${GREEN}[e2e]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[e2e]${NC} $*"
}

log_error() {
  echo -e "${RED}[e2e]${NC} $*"
}

cleanup() {
  local exit_code=$?
  log_step "Cleaning up"

  # Stop the dev server if running
  if [[ -n "${DEV_SERVER_PID:-}" ]]; then
    log "Stopping dev server (PID $DEV_SERVER_PID)..."
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
  fi

  # Stop Docker services
  if [[ "$KEEP_SERVICES" != "true" ]]; then
    if docker ps -q --filter "name=e2e-mongodb" 2>/dev/null | grep -q .; then
      log "Stopping MongoDB container..."
      docker stop e2e-mongodb 2>/dev/null || true
      docker rm e2e-mongodb 2>/dev/null || true
    fi
    if docker ps -q --filter "name=e2e-redis" 2>/dev/null | grep -q .; then
      log "Stopping Redis container..."
      docker stop e2e-redis 2>/dev/null || true
      docker rm e2e-redis 2>/dev/null || true
    fi
  fi

  if [[ $exit_code -eq 0 ]]; then
    log_success "Done!"
  else
    log_error "Exited with code $exit_code"
  fi
}

trap cleanup EXIT

start_mongodb() {
  if docker ps --filter "name=e2e-mongodb" --format '{{.Names}}' 2>/dev/null | grep -q "e2e-mongodb"; then
    log "MongoDB container already running"
    return
  fi

  # Clean up stopped container with same name
  docker rm e2e-mongodb 2>/dev/null || true

  log "Starting MongoDB (mongo:7)..."
  docker run -d --name e2e-mongodb -p 27017:27017 mongo:7

  log "Waiting for MongoDB to be ready..."
  for i in $(seq 1 30); do
    if docker exec e2e-mongodb mongosh --eval 'db.runCommand({ ping: 1 })' &>/dev/null; then
      log_success "MongoDB is ready"
      return
    fi
    sleep 2
  done
  log_error "MongoDB failed to start within 60 seconds"
  exit 1
}

start_redis() {
  if docker ps --filter "name=e2e-redis" --format '{{.Names}}' 2>/dev/null | grep -q "e2e-redis"; then
    log "Redis container already running"
    return
  fi

  # Clean up stopped container with same name
  docker rm e2e-redis 2>/dev/null || true

  log "Starting Redis (redis:7-alpine)..."
  docker run -d --name e2e-redis -p 6379:6379 redis:7-alpine

  log "Waiting for Redis to be ready..."
  for i in $(seq 1 30); do
    if docker exec e2e-redis redis-cli ping 2>/dev/null | grep -q PONG; then
      log_success "Redis is ready"
      return
    fi
    sleep 2
  done
  log_error "Redis failed to start within 60 seconds"
  exit 1
}

wait_for_server() {
  local url="$1"
  local max_attempts="${2:-30}"
  local attempt=1

  log "Waiting for dev server at $url..."
  while [[ $attempt -le $max_attempts ]]; do
    if curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null | grep -qE "^(200|404|500)"; then
      log_success "Dev server is ready (attempt $attempt)"
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done

  log_error "Dev server failed to start within $((max_attempts * 2)) seconds"
  return 1
}

# --- Parse Arguments --------------------------------------------------------

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

WORLD_ID="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=true
      shift
      ;;
    --dev-tests)
      RUN_DEV_TESTS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# Validate world ID
if [[ -z "${WORLD_PACKAGE[$WORLD_ID]+x}" ]]; then
  log_error "Unknown world: $WORLD_ID"
  echo "Valid worlds: ${!WORLD_PACKAGE[*]}"
  exit 1
fi

PACKAGE="${WORLD_PACKAGE[$WORLD_ID]}"
LOCAL_DIR="${WORLD_LOCAL_DIR[$WORLD_ID]}"
SERVICE="${WORLD_SERVICE[$WORLD_ID]}"
SETUP_CMD="${WORLD_SETUP[$WORLD_ID]}"

echo -e "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  Upstream E2E Tests - ${WORLD_ID}$(printf '%*s' $((25 - ${#WORLD_ID})) '')║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${NC}"
log "World:     $WORLD_ID ($PACKAGE)"
log "Local dir: $LOCAL_DIR"
log "Service:   $SERVICE"
log "App:       $APP_NAME"
log "Upstream:  $UPSTREAM_REPO @ $UPSTREAM_REF"

# =============================================================================
# Step 1: Build local world package
# =============================================================================
log_step "Step 1: Building local world package"

cd "$ROOT_DIR"
log "Building $PACKAGE..."
pnpm build --filter="$PACKAGE..."

# Create a tarball for clean installation into upstream
cd "$LOCAL_DIR"
TARBALL_PATH=$(pnpm pack --pack-destination "$ROOT_DIR/.e2e-upstream-tarballs" 2>/dev/null | tail -1)

if [[ ! -f "$TARBALL_PATH" ]]; then
  # pnpm pack sometimes outputs the filename only
  TARBALL_DIR="$ROOT_DIR/.e2e-upstream-tarballs"
  mkdir -p "$TARBALL_DIR"
  TARBALL_PATH=$(pnpm pack --pack-destination "$TARBALL_DIR" 2>&1 | grep -E '\.tgz$' | tail -1)
fi

log_success "Packed: $TARBALL_PATH"
cd "$ROOT_DIR"

# =============================================================================
# Step 2: Clone or update upstream repo
# =============================================================================
log_step "Step 2: Setting up upstream repo (vercel/workflow)"

if [[ "$CLEAN" == "true" ]] && [[ -d "$UPSTREAM_DIR" ]]; then
  log "Removing existing upstream clone (--clean)..."
  rm -rf "$UPSTREAM_DIR"
fi

if [[ ! -d "$UPSTREAM_DIR/.git" ]]; then
  log "Cloning vercel/workflow..."
  git clone --depth 1 --branch "$UPSTREAM_REF" "$UPSTREAM_REPO" "$UPSTREAM_DIR"
else
  log "Updating existing clone..."
  cd "$UPSTREAM_DIR"
  git fetch origin "$UPSTREAM_REF" --depth 1
  git checkout FETCH_HEAD --force
  cd "$ROOT_DIR"
fi

# =============================================================================
# Step 3: Install dependencies and build upstream
# =============================================================================
log_step "Step 3: Installing upstream dependencies"

cd "$UPSTREAM_DIR"

# Rewrite ALL packageManager fields to match the local pnpm version.
# Multiple packages in the upstream repo have their own packageManager fields,
# and corepack tries to download those specific versions during turbo builds,
# which fails in restricted network environments.
LOCAL_PNPM_VERSION=$(pnpm --version)
log "Rewriting packageManager fields to pnpm@$LOCAL_PNPM_VERSION..."
node -e "
  const fs = require('fs');
  const path = require('path');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'package.json') {
        const raw = fs.readFileSync(full, 'utf8');
        if (raw.includes('packageManager')) {
          const pkg = JSON.parse(raw);
          if (pkg.packageManager) {
            pkg.packageManager = 'pnpm@${LOCAL_PNPM_VERSION}';
            fs.writeFileSync(full, JSON.stringify(pkg, null, 2) + '\n');
            process.stderr.write('  Rewrote: ' + full + '\n');
          }
        }
      }
    }
  }
  walk('.');
"
export COREPACK_ENABLE_STRICT=0

log "Installing dependencies..."
pnpm install --no-frozen-lockfile

if [[ "$SKIP_BUILD" != "true" ]]; then
  log_step "Step 3b: Building upstream packages"

  # The @workflow/swc-plugin package builds a WASM binary from Rust source,
  # which requires downloading the wasm32-unknown-unknown target from
  # static.rust-lang.org. This often fails in restricted environments.
  # Instead, we download the pre-built WASM from the published npm package.
  SWC_PLUGIN_DIR="packages/swc-plugin-workflow"
  SWC_WASM="$SWC_PLUGIN_DIR/swc_plugin_workflow.wasm"
  if [[ ! -f "$SWC_WASM" ]]; then
    log "Fetching pre-built SWC plugin WASM from npm..."
    SWC_VERSION=$(node -e "console.log(require('./$SWC_PLUGIN_DIR/package.json').version)")
    SWC_TMP=$(mktemp -d)
    # Use npm pack in a temp dir to avoid workspace interference
    (cd "$SWC_TMP" && npm pack "@workflow/swc-plugin@$SWC_VERSION" --silent 2>/dev/null)
    tar -xzf "$SWC_TMP"/*.tgz -C "$SWC_TMP"
    if [[ -f "$SWC_TMP/package/swc_plugin_workflow.wasm" ]]; then
      cp "$SWC_TMP/package/swc_plugin_workflow.wasm" "$SWC_WASM"
      # Also create the build-hash.json if it exists in the package
      if [[ -f "$SWC_TMP/package/build-hash.json" ]]; then
        cp "$SWC_TMP/package/build-hash.json" "$SWC_PLUGIN_DIR/build-hash.json"
      fi
      log_success "SWC plugin WASM installed from npm ($SWC_VERSION)"
    else
      log_warn "Could not extract SWC WASM from npm package, build may fail"
    fi
    rm -rf "$SWC_TMP"
  else
    log "SWC plugin WASM already exists, skipping"
  fi

  # Replace the SWC plugin build script with a no-op since we have the pre-built WASM
  node -e "
    const pkg = JSON.parse(require('fs').readFileSync('$SWC_PLUGIN_DIR/package.json', 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.scripts.build = 'echo \"Using pre-built WASM from npm\"';
    require('fs').writeFileSync('$SWC_PLUGIN_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  log "Building packages (this may take a while on first run)..."
  # Exclude workbenches, docs site, and docs-typecheck.
  # Use --continue so that non-essential build failures (e.g. @workflow/web
  # needing Google Fonts) don't block the packages we actually need.
  pnpm turbo run build \
    --filter='!./workbench/*' \
    --filter='!@workflow/web' \
    --filter='!docs' \
    --filter='!@workflow/docs-typecheck' \
    --continue || {
      # Check if the critical packages built successfully
      CRITICAL_OK=true
      for pkg_dir in core next builders errors serde utils world cli; do
        if [[ ! -d "packages/$pkg_dir/dist" ]] && [[ ! -d "packages/$pkg_dir/build" ]]; then
          REAL_DIR=$(ls -d packages/*$pkg_dir* 2>/dev/null | head -1)
          if [[ -n "$REAL_DIR" ]] && [[ ! -d "$REAL_DIR/dist" ]] && [[ ! -d "$REAL_DIR/build" ]]; then
            log_error "Critical package $pkg_dir failed to build"
            CRITICAL_OK=false
          fi
        fi
      done
      if [[ "$CRITICAL_OK" == "false" ]]; then
        log_error "Critical packages failed to build, cannot continue"
        exit 1
      fi
      log_warn "Some non-essential packages failed to build, continuing..."
    }
else
  log_warn "Skipping upstream build (E2E_SKIP_BUILD=true)"
fi

# =============================================================================
# Step 4: Start Docker services (if needed)
# =============================================================================
if [[ "$SERVICE" != "none" ]]; then
  log_step "Step 4: Starting Docker services ($SERVICE)"

  if ! command -v docker &>/dev/null; then
    log_error "Docker is required for the $WORLD_ID world but was not found"
    exit 1
  fi

  case "$SERVICE" in
    mongodb)
      start_mongodb
      ;;
    redis)
      start_redis
      ;;
  esac
else
  log_step "Step 4: No Docker services needed"
fi

# =============================================================================
# Step 5: Install local world package into upstream workbench
# =============================================================================
log_step "Step 5: Installing local $PACKAGE into workbench/$APP_NAME"

cd "$UPSTREAM_DIR"
pnpm --filter "$APP_NAME" add "$TARBALL_PATH"

# Run setup command if needed
if [[ -n "$SETUP_CMD" ]]; then
  log "Running setup: $SETUP_CMD"
  cd "$UPSTREAM_DIR/workbench/$APP_NAME"
  eval "$SETUP_CMD"
  cd "$UPSTREAM_DIR"
fi

# =============================================================================
# Step 6: Resolve symlinks
# =============================================================================
log_step "Step 6: Resolving symlinks"

if [[ -f "$UPSTREAM_DIR/scripts/resolve-symlinks.sh" ]]; then
  CI=true bash "$UPSTREAM_DIR/scripts/resolve-symlinks.sh" "workbench/$APP_NAME"
else
  log_warn "resolve-symlinks.sh not found, skipping"
fi

# =============================================================================
# Step 7: Set environment variables
# =============================================================================
log_step "Step 7: Setting environment variables"

# Export world-specific env vars
while IFS= read -r line; do
  if [[ -n "$line" ]]; then
    export "$line"
    log "  $line"
  fi
done <<< "${WORLD_ENV[$WORLD_ID]}"

# Standard test env vars
export DEPLOYMENT_URL="http://localhost:3000"
export APP_NAME="$APP_NAME"
export NODE_OPTIONS="--enable-source-maps"
export WORKFLOW_PUBLIC_MANIFEST="1"
export WORKFLOW_SERVICE_URL="http://localhost:3000"
export DEV_TEST_CONFIG="{\"name\":\"$APP_NAME\",\"project\":\"workbench-${APP_NAME}-workflow\",\"generatedStepPath\":\"app/.well-known/workflow/v1/step/route.js\",\"generatedWorkflowPath\":\"app/.well-known/workflow/v1/flow/route.js\",\"apiFilePath\":\"app/api/chat/route.ts\",\"apiFileImportPath\":\"../../..\"}"

# =============================================================================
# Step 8: Start dev server and run tests
# =============================================================================
log_step "Step 8: Starting dev server and running e2e tests"

cd "$UPSTREAM_DIR"

# Start dev server in background
log "Starting $APP_NAME dev server..."
cd "workbench/$APP_NAME"
pnpm dev &
DEV_SERVER_PID=$!
cd "$UPSTREAM_DIR"

# Wait for the server to be ready
if ! wait_for_server "http://localhost:3000" 45; then
  log_error "Dev server failed to start. Check workbench/$APP_NAME for errors."
  exit 1
fi

# Small extra buffer for full startup
sleep 5

E2E_EXIT_CODE=0

# Run main e2e tests
log_step "Running e2e.test.ts"
pnpm vitest run packages/core/e2e/e2e.test.ts \
  --reporter=default \
  --config vitest.config.ts \
  || E2E_EXIT_CODE=$?

# Run dev tests if requested
if [[ "$RUN_DEV_TESTS" == "true" ]]; then
  sleep 10
  log_step "Running dev.test.ts"
  pnpm vitest run packages/core/e2e/dev.test.ts \
    --reporter=default \
    --config vitest.config.ts \
    || E2E_EXIT_CODE=$?
fi

# =============================================================================
# Results
# =============================================================================
echo ""
if [[ $E2E_EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✓ All e2e tests passed for $WORLD_ID${NC}"
else
  echo -e "${RED}${BOLD}  ✗ Some e2e tests failed for $WORLD_ID (exit code: $E2E_EXIT_CODE)${NC}"
fi
echo ""

exit $E2E_EXIT_CODE
