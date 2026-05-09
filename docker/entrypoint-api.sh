#!/bin/sh
set -eu

# Ensure artifacts volume is writable for the non-root `app` user.
mkdir -p /app/interview_langgraph/artifacts
chown -R app:app /app/interview_langgraph/artifacts || true

exec gosu app "$@"
