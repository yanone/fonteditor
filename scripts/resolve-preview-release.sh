#!/bin/bash

# Resolve preview tag, display version, and Unreleased notes.
# Does not create a GitHub tag or release.
# When GITHUB_OUTPUT is set, writes TAG, DISPLAY_VERSION, COMMIT_SHA, COMMIT_SHORT.
# Always writes release-notes.md in the repo root.

set -e

cd "$(dirname "$0")/.."

CHANGELOG_FILE="CHANGELOG.md"
RELEASE_NOTES_FILE="release-notes.md"

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required"
    exit 1
fi

DATE=$(date -u +"%Y%m%d")
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
TAG="v0.0.0-preview-${DATE}-${COMMIT_SHORT}"

if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
    echo "Error: remote tag $TAG already exists"
    exit 1
fi

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

echo "Previous preview: ${PREV_TAG:-<none>}"
echo "Next build: $DISPLAY_VERSION"
echo "Tag: $TAG"

OLD_CHANGELOG=$(mktemp)
cleanup() {
    rm -f "$OLD_CHANGELOG"
}
trap cleanup EXIT

if [ -n "$PREV_TAG" ]; then
    git show "${PREV_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
else
    STABLE_TAG=$(git tag -l 'v*' | grep -v preview | sort -V | tail -1 || true)
    if [ -n "$STABLE_TAG" ]; then
        echo "First preview notes vs last stable tag $STABLE_TAG"
        git show "${STABLE_TAG}:CHANGELOG.md" > "$OLD_CHANGELOG"
    else
        : > "$OLD_CHANGELOG"
    fi
fi

node scripts/unreleased-changelog-diff.mjs "$OLD_CHANGELOG" "$CHANGELOG_FILE" \
    > "$RELEASE_NOTES_FILE"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "TAG=$TAG" >> "$GITHUB_OUTPUT"
    echo "DISPLAY_VERSION=$DISPLAY_VERSION" >> "$GITHUB_OUTPUT"
    echo "COMMIT_SHA=$COMMIT_SHA" >> "$GITHUB_OUTPUT"
    echo "COMMIT_SHORT=$COMMIT_SHORT" >> "$GITHUB_OUTPUT"
fi
