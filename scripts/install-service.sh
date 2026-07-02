#!/usr/bin/env bash
# MT3K Agent OS — autostart installer.
#   macOS → LaunchAgent (starts at login, restarts if it dies)
#   Linux → systemd unit (starts at boot, KillMode=process so restarts never kill agent tmux sessions)
#
#   ./scripts/install-service.sh install [--token <MT3K_TOKEN>]
#   ./scripts/install-service.sh status
#   ./scripts/install-service.sh uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CMD="${1:-install}"
TOKEN=""
[ "${2:-}" = "--token" ] && TOKEN="${3:-}"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "✗ node no está en el PATH"; exit 1; }

# first-time build so the service has something to serve
if [ "$CMD" = "install" ] && [ ! -f panel/dist/index.html ]; then
  echo "→ build inicial del panel…"
  pnpm --dir panel install && pnpm --dir panel build
fi

# ---------- macOS: LaunchAgent ----------
if [ "$(uname)" = "Darwin" ]; then
  LABEL="com.mt3k.agent-os"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/mt3k-agent-os.log"
  case "$CMD" in
    install)
      mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$ROOT/scripts/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- tmux's socket lives under the user's real TMPDIR (/var/folders/…); launchd doesn't
         inherit it, and without this the panel can't see any tmux session -->
    <key>TMPDIR</key><string>$(getconf DARWIN_USER_TEMP_DIR)</string>$([ -n "$TOKEN" ] && printf '\n    <key>MT3K_TOKEN</key><string>%s</string>' "$TOKEN")
  </dict>
</dict></plist>
EOF
      chmod 600 "$PLIST"   # may hold MT3K_TOKEN
      launchctl unload "$PLIST" 2>/dev/null || true
      # free the port if an ad-hoc server is running
      lsof -ti tcp:4288 2>/dev/null | xargs kill 2>/dev/null || true
      launchctl load -w "$PLIST"
      sleep 2
      curl -sf -o /dev/null http://localhost:4288/ \
        && echo "✓ instalado — arranca al iniciar sesión · http://localhost:4288 · log: $LOG" \
        || { echo "⚠ instalado, pero aún no responde — mira el log: $LOG"; exit 1; }
      ;;
    status)
      launchctl list | grep "$LABEL" || echo "(no instalado)"
      curl -sf -o /dev/null http://localhost:4288/ && echo "panel: responde en :4288" || echo "panel: no responde"
      ;;
    uninstall)
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "✓ desinstalado (las sesiones tmux de los agentes siguen vivas)"
      ;;
    *) echo "uso: $0 install [--token <t>] | status | uninstall"; exit 1;;
  esac
  exit 0
fi

# ---------- Linux: systemd ----------
UNIT=/etc/systemd/system/mt3k-agent-os.service
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
case "$CMD" in
  install)
    $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=MT3K Agent OS panel
After=network.target

[Service]
WorkingDirectory=$ROOT
Environment=HOME=$HOME
$([ -n "$TOKEN" ] && echo "Environment=MT3K_TOKEN=$TOKEN")
ExecStart=$NODE $ROOT/scripts/server.mjs
Restart=always
RestartSec=2
# the tmux server spawned by /api/launch lives in this cgroup — without this,
# every service restart kills ALL the agents' tmux sessions
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
    $SUDO chmod 600 "$UNIT"
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now mt3k-agent-os
    sleep 2
    systemctl is-active mt3k-agent-os && echo "✓ instalado — arranca con el sistema · puerto 4288"
    ;;
  status)  systemctl status mt3k-agent-os --no-pager | head -8 ;;
  uninstall)
    $SUDO systemctl disable --now mt3k-agent-os 2>/dev/null || true
    $SUDO rm -f "$UNIT"; $SUDO systemctl daemon-reload
    echo "✓ desinstalado (las sesiones tmux de los agentes siguen vivas)"
    ;;
  *) echo "uso: $0 install [--token <t>] | status | uninstall"; exit 1;;
esac
