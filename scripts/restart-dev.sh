#!/bin/sh
# Dev helper: restart the local dev server in the background (logs in /var/tmp/dev.log).
pkill -f "[t]sx scripts/dev.ts" 2>/dev/null; sleep 1
nohup npx tsx scripts/dev.ts > /var/tmp/dev.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:8888/api/health >/dev/null && break; sleep 0.5; done
