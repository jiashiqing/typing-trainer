#!/usr/bin/env bash
# =====================================================================
#  打字练习系统 · 每日备份
#  用法：
#    sudo ADMIN_CODE=你的超管访问码 bash deploy/backup.sh
#  建议放进 cron：
#    0 19 * * * ADMIN_CODE=xxx /opt/typing-trainer/deploy/backup.sh >> /var/log/typing-backup.log 2>&1
# =====================================================================
set -euo pipefail

PORT="${PORT:-8090}"
DEST="${DEST:-/var/backups/typing-trainer}"
KEEP="${KEEP:-14}"          # 保留天数
ADMIN_CODE="${ADMIN_CODE:-}"

[ -n "$ADMIN_CODE" ] || { echo "请设置 ADMIN_CODE=超级管理员访问码"; exit 1; }

mkdir -p "$DEST"
chmod 700 "$DEST"

# 换一个临时令牌（12 小时有效，用完即弃，不影响已有登录）
TOKEN=$(curl -fsS --max-time 10 -X POST "http://127.0.0.1:$PORT/api/auth" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$ADMIN_CODE\"}" 2>/dev/null \
  | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

[ -n "$TOKEN" ] || { echo "登录失败：访问码不对，或服务没在 127.0.0.1:$PORT 上"; exit 1; }

FILE="$DEST/db-$(date +%Y%m%d-%H%M).sqlite"
curl -fsS --max-time 120 -o "$FILE" -H "X-Token: $TOKEN" \
  "http://127.0.0.1:$PORT/api/backup" || { echo "下载备份失败"; rm -f "$FILE"; exit 1; }

SIZE=$(du -h "$FILE" | cut -f1)
echo "[$(date '+%F %T')] 已备份 $FILE ($SIZE)"

# 清掉过期备份
find "$DEST" -name 'db-*.sqlite' -type f -mtime +"$KEEP" -delete 2>/dev/null || true
echo "[$(date '+%F %T')] 当前保留 $(ls -1 "$DEST"/db-*.sqlite 2>/dev/null | wc -l) 份"
