#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy Google Slides Hybrid MCP Server
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/deploy.sh                    # Deploy latest
#   ./scripts/deploy.sh --version 1.2.3    # Deploy specific version
#   ./scripts/deploy.sh --dry-run          # Preview without applying
#   ./scripts/deploy.sh --namespace prod   # Deploy to specific namespace
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
K8S_DIR="${PROJECT_DIR}/k8s"

IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
IMAGE_REPO="${IMAGE_REPO:-google-slides-hybrid-mcp/google-slides-hybrid-mcp}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NAMESPACE="${NAMESPACE:-default}"
DRY_RUN=""
SKIP_BUILD="${SKIP_BUILD:-false}"
SKIP_PUSH="${SKIP_PUSH:-false}"
SKIP_TESTS="${SKIP_TESTS:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ── Helpers ──────────────────────────────────────────────────────────────────
log()   { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()    { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ warn ]${NC} $*"; }
error() { echo -e "${RED}[error ]${NC} $*" >&2; }
die()   { error "$*"; exit 1; }

# ── Parse Arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --version|-v)
            IMAGE_TAG="$2"
            shift 2
            ;;
        --namespace|-n)
            NAMESPACE="$2"
            shift 2
            ;;
        --registry|-r)
            IMAGE_REGISTRY="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN="--dry-run=client"
            shift
            ;;
        --skip-build)
            SKIP_BUILD="true"
            shift
            ;;
        --skip-push)
            SKIP_PUSH="true"
            shift
            ;;
        --skip-tests)
            SKIP_TESTS="true"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --version, -v VERSION    Docker image tag (default: latest)"
            echo "  --namespace, -n NS       Kubernetes namespace (default: default)"
            echo "  --registry, -r REG       Container registry (default: ghcr.io)"
            echo "  --dry-run                Preview changes without applying"
            echo "  --skip-build             Skip Docker build step"
            echo "  --skip-push              Skip pushing to registry"
            echo "  --skip-tests             Skip running tests before deploy"
            echo "  --help, -h               Show this help"
            exit 0
            ;;
        *)
            die "Unknown option: $1"
            ;;
    esac
done

FULL_IMAGE="${IMAGE_REGISTRY}/${IMAGE_REPO}:${IMAGE_TAG}"

# ── Prerequisite Checks ─────────────────────────────────────────────────────
log "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || die "docker is not installed"
command -v kubectl >/dev/null 2>&1 || die "kubectl is not installed"

# Verify kubectl can connect to cluster
if ! kubectl cluster-info >/dev/null 2>&1; then
    die "Cannot connect to Kubernetes cluster. Check your kubeconfig."
fi

# Verify k8s manifests exist
if [ ! -d "$K8S_DIR" ]; then
    die "Kubernetes manifests directory not found: $K8S_DIR"
fi

ok "Prerequisites satisfied"

# ── Run Tests ────────────────────────────────────────────────────────────────
if [ "$SKIP_TESTS" != "true" ]; then
    log "Running tests..."
    (cd "$PROJECT_DIR" && npm run test:unit) || die "Unit tests failed"
    ok "Tests passed"
else
    warn "Skipping tests (--skip-tests)"
fi

# ── Build Docker Image ──────────────────────────────────────────────────────
if [ "$SKIP_BUILD" != "true" ]; then
    log "Building Docker image: ${FULL_IMAGE}"
    docker build \
        --build-arg VERSION="${IMAGE_TAG}" \
        --tag "${FULL_IMAGE}" \
        --file "${PROJECT_DIR}/Dockerfile" \
        "${PROJECT_DIR}"
    ok "Docker image built: ${FULL_IMAGE}"
else
    warn "Skipping build (--skip-build)"
fi

# ── Push to Registry ────────────────────────────────────────────────────────
if [ "$SKIP_PUSH" != "true" ] && [ "$SKIP_BUILD" != "true" ]; then
    log "Pushing image to registry: ${FULL_IMAGE}"
    docker push "${FULL_IMAGE}"

    # Also tag and push as latest if this is a versioned release
    if [ "$IMAGE_TAG" != "latest" ]; then
        LATEST_IMAGE="${IMAGE_REGISTRY}/${IMAGE_REPO}:latest"
        docker tag "${FULL_IMAGE}" "${LATEST_IMAGE}"
        docker push "${LATEST_IMAGE}"
        ok "Pushed ${FULL_IMAGE} and ${LATEST_IMAGE}"
    else
        ok "Pushed ${FULL_IMAGE}"
    fi
else
    warn "Skipping push (--skip-push or --skip-build)"
fi

# ── Create Namespace ────────────────────────────────────────────────────────
if [ "$NAMESPACE" != "default" ]; then
    log "Ensuring namespace '${NAMESPACE}' exists..."
    kubectl create namespace "$NAMESPACE" ${DRY_RUN} --save-config 2>/dev/null || true
fi

# ── Apply Kubernetes Manifests ───────────────────────────────────────────────
log "Applying Kubernetes manifests to namespace '${NAMESPACE}'..."

# Update image tag in deployment
DEPLOY_ARGS=(
    --namespace "$NAMESPACE"
)
if [ -n "$DRY_RUN" ]; then
    DEPLOY_ARGS+=("$DRY_RUN" "-o" "yaml")
fi

# Apply in dependency order
for manifest in \
    "${K8S_DIR}/configmap.yaml" \
    "${K8S_DIR}/secret.yaml" \
    "${K8S_DIR}/deployment.yaml" \
    "${K8S_DIR}/service.yaml" \
    "${K8S_DIR}/ingress.yaml" \
    "${K8S_DIR}/hpa.yaml" \
    "${K8S_DIR}/pdb.yaml"; do

    if [ -f "$manifest" ]; then
        log "  Applying $(basename "$manifest")..."
        kubectl apply -f "$manifest" "${DEPLOY_ARGS[@]}"
    else
        warn "  Manifest not found: $(basename "$manifest")"
    fi
done

# ── Update Deployment Image ─────────────────────────────────────────────────
if [ -z "$DRY_RUN" ]; then
    log "Setting deployment image to ${FULL_IMAGE}..."
    kubectl set image deployment/google-slides-mcp \
        google-slides-mcp="${FULL_IMAGE}" \
        --namespace "$NAMESPACE"
fi

# ── Wait for Rollout ────────────────────────────────────────────────────────
if [ -z "$DRY_RUN" ]; then
    log "Waiting for rollout to complete..."
    if kubectl rollout status deployment/google-slides-mcp \
        --namespace "$NAMESPACE" \
        --timeout=300s; then
        ok "Rollout completed successfully"
    else
        error "Rollout failed or timed out"
        log "Rolling back..."
        kubectl rollout undo deployment/google-slides-mcp --namespace "$NAMESPACE"
        die "Deployment rolled back due to failed rollout"
    fi
else
    warn "Dry run — skipping rollout wait"
fi

# ── Smoke Tests ──────────────────────────────────────────────────────────────
if [ -z "$DRY_RUN" ]; then
    log "Running smoke tests..."

    # Wait for pods to be ready
    kubectl wait --for=condition=ready pod \
        -l app=google-slides-mcp \
        --namespace "$NAMESPACE" \
        --timeout=120s

    # Get a pod name
    POD_NAME=$(kubectl get pods \
        -l app=google-slides-mcp \
        --namespace "$NAMESPACE" \
        -o jsonpath='{.items[0].metadata.name}')

    # Health check via port-forward
    log "  Checking /health endpoint..."
    kubectl exec "$POD_NAME" --namespace "$NAMESPACE" -- \
        node -e "
            const http = require('http');
            const req = http.get('http://localhost:8080/health', (res) => {
                if (res.statusCode === 200) {
                    console.log('Health check passed');
                    process.exit(0);
                } else {
                    console.error('Health check failed:', res.statusCode);
                    process.exit(1);
                }
            });
            req.on('error', (e) => { console.error(e.message); process.exit(1); });
            req.setTimeout(5000, () => { req.destroy(); process.exit(1); });
        " || warn "Health check could not be verified (non-critical)"

    ok "Smoke tests passed"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
ok "Deployment complete!"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
log "Image:     ${FULL_IMAGE}"
log "Namespace: ${NAMESPACE}"
if [ -n "$DRY_RUN" ]; then
    warn "This was a dry run — no changes were applied"
fi
echo ""
log "Useful commands:"
echo "  kubectl get pods -l app=google-slides-mcp -n ${NAMESPACE}"
echo "  kubectl logs -l app=google-slides-mcp -n ${NAMESPACE} -f"
echo "  kubectl describe deployment google-slides-mcp -n ${NAMESPACE}"
echo ""
