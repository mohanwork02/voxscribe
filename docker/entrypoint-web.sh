#!/bin/sh
set -eu

# Ensure uploads volume is writable for the non-root `node` user.
mkdir -p /app/login/uploads
chown -R node:node /app/login/uploads || true

exec gosu node "$@"

