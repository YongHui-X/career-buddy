#!/bin/sh
set -eu
cd /app/web
exec npm run start -- --hostname 0.0.0.0
