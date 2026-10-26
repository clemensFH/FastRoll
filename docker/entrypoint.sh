#!/usr/bin/env bash
# Render this container's config, then become the service.
#
# The rendering lives in docker/render-config.ts, because building JSON is not
# something bash can do without either jq, which is not in this image, or string
# concatenation, which is what this file used to be. See that file for why.
#
# What is left is the part bash is actually good at: fail on an unset variable,
# and hand the process ID over to the service with exec so signals reach it.
set -euo pipefail

CONFIG=$(npx tsx docker/render-config.ts)
exec npx tsx "packages/${ROLE}/src/index.ts" "$CONFIG"
