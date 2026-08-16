#!/bin/bash

# Wait until ci.yml has a successful push run for HEAD.
# Fails if that run failed, was cancelled, or does not finish in time.

set -e

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI (gh) is required"
    exit 1
fi

COMMIT_SHA=$(git rev-parse HEAD)
DEADLINE=$((SECONDS + 5400))

echo "Waiting for a green CI push run on $COMMIT_SHA"

latest_push_run() {
    gh run list --workflow=ci.yml --commit="$COMMIT_SHA" --limit 20 \
        --json databaseId,status,conclusion,event \
        --jq '[.[] | select(.event=="push")] | sort_by(.databaseId) | last // empty'
}

while [ "$SECONDS" -lt "$DEADLINE" ]; do
    run_json=$(latest_push_run)
    if [ -z "$run_json" ] || [ "$run_json" = "null" ]; then
        echo "No CI push run yet; retrying in 20s..."
        sleep 20
        continue
    fi

    run_id=$(printf '%s\n' "$run_json" | jq -r '.databaseId')
    status=$(printf '%s\n' "$run_json" | jq -r '.status')
    conclusion=$(printf '%s\n' "$run_json" | jq -r '.conclusion // empty')

    echo "CI run $run_id status=$status conclusion=${conclusion:-<none>}"

    if [ "$status" = "completed" ]; then
        if [ "$conclusion" = "success" ]; then
            echo "CI is green for $COMMIT_SHA"
            exit 0
        fi
        echo "Error: CI run $run_id concluded $conclusion; refusing to publish"
        exit 1
    fi

    echo "CI still running; watching run $run_id..."
    gh run watch "$run_id" --exit-status
    watch_status=$?
    if [ "$watch_status" -eq 0 ]; then
        echo "CI is green for $COMMIT_SHA"
        exit 0
    fi
    echo "Error: CI run $run_id did not succeed; refusing to publish"
    exit 1
done

echo "Error: timed out waiting for a green CI push run on $COMMIT_SHA"
exit 1
