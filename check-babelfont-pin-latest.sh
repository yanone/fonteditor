#!/bin/bash
set -e

echo "🔍 Checking babelfont-rs pin freshness..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_FILE="$SCRIPT_DIR/.babelfont-rs-ref"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -f "$PIN_FILE" ]; then
    echo -e "${RED}❌ Error: Pin file not found: $PIN_FILE${NC}"
    exit 1
fi

PINNED_REPO_URL=$(grep '^repo=' "$PIN_FILE" | tail -1 | cut -d'=' -f2-)
PINNED_COMMIT=$(grep '^commit=' "$PIN_FILE" | tail -1 | cut -d'=' -f2-)
PINNED_BRANCH=$(grep '^branch=' "$PIN_FILE" | tail -1 | cut -d'=' -f2-)

# Backward compatibility: commit-only format
if [ -z "$PINNED_COMMIT" ]; then
    PINNED_COMMIT=$(tr -d '[:space:]' < "$PIN_FILE")
fi

if [ -z "$PINNED_REPO_URL" ]; then
    PINNED_REPO_URL="https://github.com/simoncozens/babelfont-rs.git"
fi

if [ -z "$PINNED_COMMIT" ]; then
    echo -e "${RED}❌ Error: Could not read pinned commit from $PIN_FILE${NC}"
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: git is required for pin freshness check${NC}"
    exit 1
fi

if [ -n "$PINNED_BRANCH" ]; then
    REMOTE_REF="refs/heads/$PINNED_BRANCH"
    LATEST_COMMIT=$(git ls-remote "$PINNED_REPO_URL" "$REMOTE_REF" | awk '{print $1}' | head -1)
else
    LATEST_COMMIT=$(git ls-remote "$PINNED_REPO_URL" HEAD | awk '{print $1}' | head -1)
fi

if [ -z "$LATEST_COMMIT" ]; then
    echo -e "${RED}❌ Error: Could not resolve latest commit from $PINNED_REPO_URL${NC}"
    if [ -n "$PINNED_BRANCH" ]; then
        echo "   Branch requested: $PINNED_BRANCH"
    fi
    exit 1
fi

echo "📦 Pinned: $PINNED_REPO_URL@$PINNED_COMMIT"
if [ -n "$PINNED_BRANCH" ]; then
    echo "🌐 Latest: $PINNED_REPO_URL@$LATEST_COMMIT (branch $PINNED_BRANCH)"
else
    echo "🌐 Latest: $PINNED_REPO_URL@$LATEST_COMMIT (remote HEAD)"
fi

if [ "$PINNED_COMMIT" = "$LATEST_COMMIT" ]; then
    echo -e "${GREEN}✅ Pin is up to date${NC}"
    exit 0
fi

echo -e "${RED}❌ Pin is outdated${NC}"
echo ""
echo -e "${YELLOW}Update .babelfont-rs-ref to latest commit:${NC}"
echo "  repo=$PINNED_REPO_URL"
if [ -n "$PINNED_BRANCH" ]; then
    echo "  branch=$PINNED_BRANCH"
fi
echo "  commit=$LATEST_COMMIT"
exit 1
