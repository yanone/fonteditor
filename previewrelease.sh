#!/bin/bash

# Cut a preview release: GitHub prerelease + tag that triggers preview deploy.
# Usage: ./previewrelease.sh

set -e

cd "$(dirname "$0")"

SERVICE_WORKER_FILE="webapp/coi-serviceworker.js"
CHANGELOG_FILE="CHANGELOG.md"
RELEASE_NOTES_FILE="release-notes.md"
GITHUB_RELEASES_URL="https://github.com/counterpunchspace/editor/releases/tag"

if [ ! -f "$SERVICE_WORKER_FILE" ]; then
    echo "Error: $SERVICE_WORKER_FILE not found"
    exit 1
fi

if [ ! -f "$CHANGELOG_FILE" ]; then
    echo "Error: $CHANGELOG_FILE not found"
    exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required to create the preview release"
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Error: preview releases must be cut from main (currently on $CURRENT_BRANCH)"
    exit 1
fi

if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then
    echo "Error: uncommitted changes. Commit or stash before cutting a preview release."
    exit 1
fi

echo "Fetching origin/main and tags..."
git fetch origin main --tags

if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Error: local main is behind or has diverged from origin/main"
    exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "Pushing unpushed main commits..."
    git push origin main
else
    echo "main is already up to date with origin/main"
fi

DATE=$(date -u +"%Y%m%d")
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
VERSION_TAG="v0.0.0-preview-${DATE}-${COMMIT_SHORT}"

if git rev-parse "$VERSION_TAG" >/dev/null 2>&1; then
    echo "Error: tag $VERSION_TAG already exists"
    exit 1
fi

echo "Resolving next preview build number..."
MAX_N=0
PREV_TAG=""
while IFS=$'\t' read -r name tag; do
    [ -z "$name" ] && continue
    num=$(printf '%s\n' "$name" | sed -n 's/^preview-build-\([0-9][0-9]*\)-on-.*$/\1/p')
    if [ -n "$num" ] && [ "$num" -gt "$MAX_N" ]; then
        MAX_N=$num
        PREV_TAG=$tag
    fi
done < <(
    gh release list --limit 100 --json name,tagName,isPrerelease \
        --jq '.[] | select(.isPrerelease) | [.name, .tagName] | @tsv'
)

NEXT_N=$((MAX_N + 1))
DISPLAY_VERSION="preview-build-${NEXT_N}-on-${DATE}"

echo "  Previous preview: ${PREV_TAG:-<none>}"
echo "  Next build: $DISPLAY_VERSION"
echo "  Tag: $VERSION_TAG"

OLD_CHANGELOG=$(mktemp)
cleanup() {
    rm -f "$OLD_CHANGELOG" "$RELEASE_NOTES_FILE"
}
trap cleanup EXIT

if [ -n "$PREV_TAG" ]; then
    git show "${PREV_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
else
    STABLE_TAG=$(git tag -l 'v*' | grep -v preview | sort -V | tail -1 || true)
    if [ -n "$STABLE_TAG" ]; then
        echo "  First preview notes vs last stable tag $STABLE_TAG"
        git show "${STABLE_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
    else
        : > "$OLD_CHANGELOG"
    fi
fi

echo "Computing Unreleased changelog diff..."
node scripts/unreleased-changelog-diff.mjs "$OLD_CHANGELOG" "$CHANGELOG_FILE" \
    > "$RELEASE_NOTES_FILE"

echo "Release notes:"
echo "----------------------------------------"
cat "$RELEASE_NOTES_FILE"
echo "----------------------------------------"

echo "Creating tag $VERSION_TAG..."
git tag "$VERSION_TAG" "$COMMIT_SHA"

echo "Creating GitHub prerelease $DISPLAY_VERSION..."
if ! gh release create "$VERSION_TAG" \
    --target "$COMMIT_SHA" \
    --title "$DISPLAY_VERSION" \
    --notes-file "$RELEASE_NOTES_FILE" \
    --prerelease; then
    git tag -d "$VERSION_TAG" >/dev/null 2>&1 || true
    echo "Error: failed to create GitHub prerelease"
    exit 1
fi

echo ""
echo "✅ Preview $DISPLAY_VERSION complete!"
echo "🚀 GitHub Actions will now:"
echo "   - Build and test the preview tag"
echo "   - Deploy to https://preview.editor.counterpunch.space"
echo ""
echo "View your release at: ${GITHUB_RELEASES_URL}/${VERSION_TAG}"
