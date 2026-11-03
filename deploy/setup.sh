#!/usr/bin/env bash
# =====================================================================
#  打字练习系统 · Linux 一键部署 / 升级
#  支持 Ubuntu 20.04+ / Debian 11+ / Rocky 8+ / Alma 8+（glibc ≥ 2.28）
# ---------------------------------------------------------------------
#  用法（在项目根目录执行）：
#    sudo bash deploy/setup.sh                           # 装到 /opt，对外 80
#    sudo bash deploy/setup.sh typing.example.com          # 有域名，自动 HTTPS
#    sudo -E WEB_PORT=8090 bash deploy/setup.sh          # 对外 8090
#    sudo -E APP_DIR=/data/web/typing-trainer WEB_PORT=8090 bash deploy/setup.sh
#
#  可选环境变量（sudo 下请加 -E 传递）：
#    APP_DIR      安装目录，默认 /opt/typing-trainer
#    WEB_PORT     对外端口，默认 80（有域名时固定走 80/443）
#    BACKEND_PORT Node 内部端口，默认 8091，不对外
#    MODE         basic | ipallow | open，默认 basic
#    WEB_USER     口令用户名，默认 typing
#    WEB_PASS     口令密码，留空则随机生成并打印
#    ALLOW_CIDR   ipallow 模式的放行网段，空格分隔多个
#    EMAIL        certbot 注册邮箱
#    PUBLIC_URL   手动指定对外地址，默认自动推导（公网 IP + 端口）
#    NO_NGINX=1   不装 Nginx，Node 直接对外（无口令无防护，仅临时测试）
#    I_KNOW=1     源码里带数据库但确实要装到空目录时，用它跳过防呆检查
#
#  重复执行是安全的：data/ 目录永不覆盖，已有数据库会保留。
# =====================================================================
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="${APP_DIR:-/opt/typing-trainer}"
WEB_PORT="${WEB_PORT:-80}"
BACKEND_PORT="${BACKEND_PORT:-8091}"
MODE="${MODE:-basic}"
WEB_USER="${WEB_USER:-typing}"
WEB_PASS="${WEB_PASS:-}"
ALLOW_CIDR="${ALLOW_CIDR:-}"
EMAIL="${EMAIL:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
NO_NGINX="${NO_NGINX:-0}"
I_KNOW="${I_KNOW:-0}"
SVC="typing-trainer"
RUN_USER="typing"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

c_ok="\033[32m"; c_warn="\033[33m"; c_err="\033[31m"; c_dim="\033[2m"; c_0="\033[0m"
step() { echo -e "\n\033[36m▶ $*\033[0m"; }
ok()   { echo -e "  ${c_ok}✓${c_0} $*"; }
warn() { echo -e "  ${c_warn}!${c_0} $*"; }
die()  { echo -e "  ${c_err}✗ $*${c_0}"; exit 1; }

# ---------------------------------------------------------------- 参数校验
[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/setup.sh"
[ -f "$SRC/server.js" ] || die "没找到 server.js，请在项目根目录执行本脚本"
[ -f "$SRC/deploy/typing-trainer.service" ] || die "deploy/ 目录不完整，缺 typing-trainer.service"

case "$MODE" in basic|ipallow|open) ;; *) die "MODE 只能是 basic / ipallow / open";; esac
case "$WEB_PORT" in ''|*[!0-9]*) die "WEB_PORT 必须是数字";; esac
case "$BACKEND_PORT" in ''|*[!0-9]*) die "BACKEND_PORT 必须是数字";; esac

if [ -n "$DOMAIN" ] && [ "$WEB_PORT" != "80" ]; then
  warn "有域名时对外固定用 80/443，已忽略 WEB_PORT=$WEB_PORT"
  WEB_PORT=80
fi

if [ "$NO_NGINX" = "1" ]; then
  BIND_HOST="0.0.0.0"
  NODE_PORT="$WEB_PORT"
else
  BIND_HOST="127.0.0.1"
  NODE_PORT="$BACKEND_PORT"
  [ "$NODE_PORT" = "$WEB_PORT" ] && die "BACKEND_PORT 不能和 WEB_PORT 相同"
fi

echo -e "${c_dim}源目录：$SRC${c_0}"
echo -e "${c_dim}部署到：$APP_DIR${c_0}"
echo -e "${c_dim}对外端口：$WEB_PORT   Node 端口：$NODE_PORT ($BIND_HOST)${c_0}"
echo -e "${c_dim}访问方式：${MODE}$([ "$NO_NGINX" = "1" ] && echo '（无 Nginx，直连）')${c_0}"

# ---------------------------------------------------------------- 系统检测
step "检测系统"
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
else
  die "不认识的发行版（没有 apt / dnf / yum）"
fi
ok "包管理器：$PKG"

# ---------------------------------------------------------------- 装依赖
step "安装系统依赖"
if [ "$PKG" = "apt" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  if [ "$NO_NGINX" = "1" ]; then
    apt-get install -y -qq curl ca-certificates tar >/dev/null
  else
    apt-get install -y -qq curl ca-certificates nginx apache2-utils tar >/dev/null
  fi
else
  if [ "$NO_NGINX" = "1" ]; then
    $PKG install -y -q curl ca-certificates tar >/dev/null 2>&1 || true
  else
    $PKG install -y -q curl ca-certificates nginx httpd-tools tar >/dev/null 2>&1 || true
    systemctl enable nginx >/dev/null 2>&1 || true
  fi
fi
ok "基础依赖就绪"

# ---------------------------------------------------------------- Node
step "检查 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  NV=$(node -p "process.versions.node" 2>/dev/null || echo "0")
  MAJ="${NV%%.*}"
  REST="${NV#*.}"
  MIN="${REST%%.*}"
  if [ "$MAJ" -gt 22 ] 2>/dev/null; then
    need_node=0
  elif [ "$MAJ" -eq 22 ] 2>/dev/null && [ "$MIN" -ge 5 ] 2>/dev/null; then
    need_node=0
  fi
  if [ "$need_node" -eq 0 ]; then
    ok "已装 Node $NV（满足 22.5+）"
  else
    warn "现有 Node $NV 太旧（需要 22.5+），将安装 22.x"
  fi
fi

if [ "$need_node" -eq 1 ]; then
  if [ "$PKG" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh || die "下载 NodeSource 源失败，检查网络"
    bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || die "NodeSource 源配置失败"
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh || die "下载 NodeSource 源失败，检查网络"
    bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || die "NodeSource 源配置失败"
    $PKG install -y -q nodejs >/dev/null
  fi
  NV=$(node -p "process.versions.node")
  ok "已安装 Node $NV"
fi

NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || die "找不到 node 可执行文件"
ok "node 路径：$NODE_BIN"

if ! "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1; then
  die "这个 Node 加载不了内置 node:sqlite（通常是 glibc 太旧）。请换 Ubuntu 20.04+ / Rocky 8+，CentOS 7 不支持"
fi
ok "node:sqlite 可用"

# ---------------------------------------------------------------- 建用户
step "创建运行账号"
if id "$RUN_USER" >/dev/null 2>&1; then
  ok "用户 $RUN_USER 已存在"
else
  NOSHELL="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home "$APP_DIR" --shell "$NOSHELL" "$RUN_USER"
  ok "已创建系统用户 $RUN_USER（不给登录 shell）"
fi

# ---------------------------------------------------------------- 停旧服务
if systemctl cat "$SVC" >/dev/null 2>&1; then
  step "停止旧实例"
  systemctl stop "$SVC" 2>/dev/null || true
  ok "旧服务已停止（稍后重启）"
fi

# ---------------------------------------------------------------- 拷代码
step "部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"

KEEP_DATA=0
[ -f "$APP_DIR/data/db.sqlite" ] && KEEP_DATA=1

SAME_DIR=0
if [ "$(cd "$SRC" && pwd -P)" = "$(cd "$APP_DIR" && pwd -P)" ]; then SAME_DIR=1; fi

# 防呆：源码里带着数据库，却要部署到另一个空目录 —— 那等于把现有成绩"搬丢"
if [ "$SAME_DIR" != "1" ] && [ -f "$SRC/data/db.sqlite" ] && [ ! -f "$APP_DIR/data/db.sqlite" ] && [ "$I_KNOW" != "1" ]; then
  warn "源目录里已有数据库：$SRC/data/db.sqlite"
  warn "但安装目录 $APP_DIR 是空的，继续会部署成一个全新的空库"
  die "如果这是升级，请改用 APP_DIR=$SRC ；确认要全新部署请加 I_KNOW=1"
fi

if [ "$SAME_DIR" = "1" ]; then
  ok "安装目录即源目录，跳过拷贝"
else
  tar -C "$SRC" -cf - \
    --exclude='./data' --exclude='./deploy' --exclude='./.git' \
    --exclude='./node_modules' --exclude='./_edgetmp*' \
    --exclude='./_backup_*' --exclude='./.deploy' \
    --exclude='./预览截图' --exclude='./__pycache__' . 2>/dev/null \
    | tar -C "$APP_DIR" -xf -
fi

mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 755 "$APP_DIR" "$APP_DIR/data"
ok "代码已就位（$(du -sh "$APP_DIR" 2>/dev/null | cut -f1)）"

if [ "$KEEP_DATA" -eq 1 ]; then
  ok "检测到已有数据库，data/ 未被覆盖"
else
  ok "首次部署，data/ 将在服务启动时自动建库"
fi

# ---------------------------------------------------------------- 推导访问地址
step "确定对外地址"
if [ -z "$PUBLIC_URL" ]; then
  if [ -n "$DOMAIN" ]; then
    PUBLIC_URL="http://$DOMAIN"
  else
    PUB_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if [ -z "$PUB_IP" ]; then
      PUB_IP="$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)"
    fi
    [ -n "$PUB_IP" ] || PUB_IP="127.0.0.1"
    if [ "$WEB_PORT" = "80" ]; then
      PUBLIC_URL="http://$PUB_IP"
    else
      PUBLIC_URL="http://$PUB_IP:$WEB_PORT"
    fi
  fi
fi
ok "PUBLIC_URL = $PUBLIC_URL"
[ -z "$DOMAIN" ] && warn "二维码和启动横幅使用这个地址；学生从校外访问时，它必须是公网 IP"

# ---------------------------------------------------------------- systemd
step "写入 systemd 服务"
sed -e "s|__ROOT__|$APP_DIR|g" \
    -e "s|__PORT__|$NODE_PORT|g" \
    -e "s|__BIND_HOST__|$BIND_HOST|g" \
    -e "s|__PUBLIC_URL__|$PUBLIC_URL|g" \
    -e "s|/usr/bin/node|$NODE_BIN|g" \
    "$SRC/deploy/typing-trainer.service" > "/etc/systemd/system/$SVC.service"

systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1
ok "服务已注册：$SVC"

# ---------------------------------------------------------------- 访问控制
AUTH_LINE=""
if [ "$NO_NGINX" = "1" ]; then
  step "跳过访问控制"
  warn "NO_NGINX=1：没有口令、没有限速，任何人拿到地址就能进"
  warn "仅用于临时测试。正式使用请去掉 NO_NGINX 并走 Nginx"
else
  step "生成访问控制（$MODE）"
  case "$MODE" in
    basic)
      if [ -z "$WEB_PASS" ]; then
        WEB_PASS="$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12 2>/dev/null || true)"
        [ -n "$WEB_PASS" ] || WEB_PASS="tt$(date +%s)${RANDOM}"
      fi
      htpasswd -bc /etc/nginx/typing.htpasswd "$WEB_USER" "$WEB_PASS" >/dev/null 2>&1 \
        || die "生成口令文件失败，确认 apache2-utils / httpd-tools 已安装"
      chmod 644 /etc/nginx/typing.htpasswd
      AUTH_LINE='auth_basic "打字练习系统"; auth_basic_user_file /etc/nginx/typing.htpasswd;'
      ok "整站口令：$WEB_USER / $WEB_PASS"
      ;;
    ipallow)
      [ -n "$ALLOW_CIDR" ] || die "ipallow 模式请设置 ALLOW_CIDR=\"学校出口IP/24\""
      for c in $ALLOW_CIDR; do AUTH_LINE="$AUTH_LINE allow $c;"; done
      AUTH_LINE="$AUTH_LINE allow 127.0.0.1; deny all;"
      ok "只放行：$ALLOW_CIDR"
      ;;
    open)
      AUTH_LINE="# open 模式：没有任何访问控制"
      warn "open 模式 = 任何人都能看到全校学生姓名和成绩"
      ;;
  esac
fi

# ---------------------------------------------------------------- Nginx
if [ "$NO_NGINX" != "1" ]; then
  step "配置 Nginx 反向代理"
  [ -f "$SRC/deploy/nginx-http.conf" ] || die "deploy/nginx-http.conf 不存在"

  sed -e "s|__WEB_PORT__|$WEB_PORT|g" \
      -e "s|__PORT__|$NODE_PORT|g" \
      -e "s|__AUTH__|$AUTH_LINE|g" \
      "$SRC/deploy/nginx-http.conf" > "/etc/nginx/conf.d/$SVC.conf"

  if [ -n "$DOMAIN" ]; then
    sed -i "s|server_name _;|server_name $DOMAIN;|" "/etc/nginx/conf.d/$SVC.conf"
  fi

  if [ "$WEB_PORT" = "80" ] && [ -f /etc/nginx/sites-enabled/default ]; then
    BAK="/etc/nginx/default.disabled.$(date +%Y%m%d%H%M%S)"
    mv /etc/nginx/sites-enabled/default "$BAK"
    ok "已停用 Ubuntu 默认站点（备份：$BAK）"
  fi

  if ! nginx -t >/dev/null 2>&1; then
    nginx -t || true
    die "Nginx 配置有误，见上面的报错（文件：/etc/nginx/conf.d/$SVC.conf）"
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  ok "Nginx 已加载，监听 $WEB_PORT"
fi

# ---------------------------------------------------------------- 防火墙
step "放行端口"
PORTS="$WEB_PORT"
[ -n "$DOMAIN" ] && PORTS="80 443"

opened=0
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for p in $PORTS; do ufw allow "$p/tcp" >/dev/null 2>&1 || true; done
  ok "ufw 已放行：$PORTS"
  opened=1
fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  for p in $PORTS; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null 2>&1 || true; done
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld 已放行：$PORTS"
  opened=1
fi
[ "$opened" -eq 0 ] && warn "没检测到启用的本机防火墙"
warn "云平台安全组 / 防火墙必须单独放行 $PORTS，否则外网连不上"

# ---------------------------------------------------------------- 启动
step "启动服务"
systemctl restart "$SVC"
sleep 2
if ! systemctl is-active --quiet "$SVC"; then
  journalctl -u "$SVC" -n 30 --no-pager
  die "服务启动失败，日志见上"
fi
ok "服务已运行（$SVC，端口 $NODE_PORT）"

if curl -fsS "http://127.0.0.1:$NODE_PORT/api/ping" >/dev/null 2>&1; then
  ok "内部探针 /api/ping 正常"
else
  journalctl -u "$SVC" -n 30 --no-pager
  die "服务在跑但探针不通，检查日志：journalctl -u $SVC -n 50"
fi

if [ "$NO_NGINX" != "1" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" 2>/dev/null || echo 000)"
  case "$CODE" in
    200) ok "Nginx 转发正常（HTTP 200）" ;;
    401) ok "Nginx 转发正常（HTTP 401 = 口令生效）" ;;
    403) ok "Nginx 转发正常（HTTP 403 = IP 白名单生效）" ;;
    000) warn "Nginx 端口 $WEB_PORT 无响应，检查 /etc/nginx/conf.d/$SVC.conf" ;;
    *)   warn "Nginx 返回 HTTP $CODE，请检查：sudo tail -20 /var/log/nginx/error.log" ;;
  esac
fi

# ---------------------------------------------------------------- HTTPS
if [ -n "$DOMAIN" ]; then
  step "申请 HTTPS 证书（Let's Encrypt）"
  if [ "$PKG" = "apt" ]; then
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  else
    $PKG install -y -q certbot python3-certbot-nginx >/dev/null 2>&1 \
      || die "装 certbot 失败，请手动执行：certbot --nginx -d $DOMAIN"
  fi

  CB_ARGS=(--nginx -d "$DOMAIN" --agree-tos --redirect --non-interactive)
  if [ -n "$EMAIL" ]; then
    CB_ARGS+=(-m "$EMAIL")
  else
    CB_ARGS+=(--register-unsafely-without-email)
    warn "没填 EMAIL，证书到期提醒收不到（续期任务仍会自动跑）"
  fi

  if certbot "${CB_ARGS[@]}"; then
    ok "证书已签发"
    sed -e "s|__DOMAIN__|$DOMAIN|g" \
        -e "s|__PORT__|$NODE_PORT|g" \
        -e "s|__AUTH__|$AUTH_LINE|g" \
        "$SRC/deploy/nginx-https.conf" > "/etc/nginx/conf.d/$SVC.conf"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    ok "已切到 HTTPS 加固配置"

    sed -i "s|^Environment=PUBLIC_URL=.*|Environment=PUBLIC_URL=https://$DOMAIN|" \
      "/etc/systemd/system/$SVC.service"
    systemctl daemon-reload && systemctl restart "$SVC"
    PUBLIC_URL="https://$DOMAIN"
    ok "已通知服务端使用 $PUBLIC_URL"
  else
    warn "证书申请失败（常见原因：域名没解析到这台机器 / 80 端口没放行）"
    warn "服务仍可通过 http://$DOMAIN 访问，修好后手动执行：certbot --nginx -d $DOMAIN"
  fi
else
  warn "没有域名，只能走 HTTP —— 访问码和成绩是明文传输，建议尽快配域名"
fi

# ---------------------------------------------------------------- 完成
LINE="======================================================================"
echo ""
echo -e "\033[32m$LINE\033[0m"
echo -e "\033[32m   部署完成\033[0m"
echo -e "\033[32m$LINE\033[0m"
echo "  学生端：   $PUBLIC_URL/"
echo "  教师端：   $PUBLIC_URL/teacher"
echo "  大屏看板： $PUBLIC_URL/screen"
echo ""
if [ "$MODE" = "basic" ] && [ "$NO_NGINX" != "1" ]; then
  echo "  网页口令： $WEB_USER / $WEB_PASS   （先输这个，再输教师访问码）"
fi
[ "$MODE" = "ipallow" ] && echo "  访问白名单：$ALLOW_CIDR（其余来源 403）"
echo "  教师访问码：默认 admin888 / teacher888，进教师端设置里改"
echo ""
echo "  目录布局："
echo "    代码   $APP_DIR"
echo "    数据库 $APP_DIR/data/db.sqlite"
echo "    服务   /etc/systemd/system/$SVC.service"
[ "$NO_NGINX" != "1" ] && echo "    站点   /etc/nginx/conf.d/$SVC.conf"
echo ""
echo "  常用命令："
echo "    systemctl status  $SVC      查看状态"
echo "    systemctl restart $SVC      重启"
echo "    journalctl -u $SVC -f       看实时日志"
echo "    ls -lh $APP_DIR/data        看数据库文件"
echo ""
echo "  ⚠ 下一步务必做：改掉默认访问码（admin888 / teacher888）"
[ -z "$DOMAIN" ] && echo "  ⚠ 建议尽快配域名上 HTTPS，否则口令与成绩明文过公网"
echo -e "\033[32m$LINE\033[0m"
