#!/bin/bash

# Resolve preview tag, display version, and Unreleased notes.
# Does not create a GitHub tag or release.
# When GITHUB_OUTPUT is set, writes TAG, DISPLAY_VERSION, COMMIT_SHA, COMMIT_SHORT.
# Always writes release-notes.md in the repo root.
#
# Display/tag: DATE-build-N / v0.0.0-preview.DATE.N
# N is a monotonic build number (not reset per day). DATE is the UTC day of
# this cut and keeps semver/git version-sort descending.

set -e

cd "$(dirname "$0")/.."

CHANGELOG_FILE="CHANGELOG.md"
RELEASE_NOTES_FILE="release-notes.md"

DATE=$(date -u +"%Y%m%d")
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)

git fetch origin --tags --force >/dev/null 2>&1 || true

TAG=""
DISPLAY_VERSION=""
PREV_TAG=""
NEXT_N=""
while IFS= read -r line; do
    case "$line" in
        TAG=*) TAG=${line#TAG=} ;;
        DISPLAY_VERSION=*) DISPLAY_VERSION=${line#DISPLAY_VERSION=} ;;
        PREV_TAG=*) PREV_TAG=${line#PREV_TAG=} ;;
        NEXT_N=*) NEXT_N=${line#NEXT_N=} ;;
    esac
done < <(
    git tag -l 'v0.0.0-preview.*' |
        node scripts/preview-version.mjs --date="$DATE"
)

if [ -z "$TAG" ] || [ -z "$DISPLAY_VERSION" ]; then
    echo "Error: could not resolve next preview version"
    exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
    echo "Error: remote tag $TAG already exists"
    exit 1
fi

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
