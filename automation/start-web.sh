#!/bin/sh
set -eu
mkdir -p /browser-profile /tmp/career-ops-x11
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp > /tmp/career-ops-x11/xvfb.log 2>&1 &
x11vnc -display :99 -forever -shared -passwdfile /run/secrets/novnc_password -localhost > /tmp/career-ops-x11/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 > /tmp/career-ops-x11/novnc.log 2>&1 &
cd /app/web
exec npm run start -- --hostname 0.0.0.0
