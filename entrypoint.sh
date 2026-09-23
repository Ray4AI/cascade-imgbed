#!/bin/sh
# Ensure /data is writable by the unprivileged runtime user, then drop privileges.
mkdir -p /data/images
chown -R node:node /data 2>/dev/null || true
exec su-exec node node src/server.js
