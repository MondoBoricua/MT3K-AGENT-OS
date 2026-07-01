#!/usr/bin/env bash
# MT3K Agent OS launcher — builds (if needed), starts the server, opens the panel on your LAN IP.
set -e
cd "$(dirname "$0")"

PORT=4288
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
URL="http://$IP:$PORT"

# deps
if [ ! -d panel/node_modules ]; then echo "→ instalando dependencias…"; pnpm --dir panel install; fi

# build the panel the first time, otherwise just refresh the ingested data
if [ ! -d panel/dist ]; then
  echo "→ build inicial del panel…"; pnpm --dir panel build
else
  echo "→ refrescando data de los repos…"; node scripts/build-data.mjs
fi

# free the port if something is already there
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

echo ""
echo "  ╭───────────────────────────────────────────╮"
echo "  │  MT3K Agent OS  ·  $URL"
echo "  │  (accesible desde tu LAN — móvil/tablet)    │"
echo "  ╰───────────────────────────────────────────╯"
echo ""

node scripts/server.mjs &
SRV=$!
trap "kill $SRV 2>/dev/null" EXIT INT TERM

# wait until it responds, then open the browser at the LAN IP
for _ in $(seq 1 25); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.3; done
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true

wait $SRV
