#!/usr/bin/env bash
# =====================================================================
#  打字练习系统 · 从远程仓库部署（保留本地数据 · 支持回滚）
#
#  和 deploy/setup.sh 的分工：
#    setup.sh      首次部署。装 Node、建账号、写 systemd、配 Nginx、开端口。
#    pull-deploy.sh 日常更新。git 拉代码 → 装依赖 → 重启 → 探活。
#    两者不冲突：setup.sh 不碰 .git，本脚本不碰 systemd/Nginx 配置。
#
#  ---- 常用 ----
#    sudo bash deploy/pull-deploy.sh                 拉默认分支最新并部署
#    sudo bash deploy/pull-deploy.sh v1.2.0          部署某个 tag
#    sudo bash deploy/pull-deploy.sh a1b2c3d         部署某个 commit
#    sudo bash deploy/pull-deploy.sh --rollback      回退到上一次部署的版本
#    sudo bash deploy/pull-deploy.sh --rollback <sha> 回退到指定版本
#    sudo bash deploy/pull-deploy.sh --list          看部署历史
#    sudo bash deploy/pull-deploy.sh --status        看当前版本与远程差多少
#    sudo bash deploy/pull-deploy.sh --init <仓库地址>  首次：把已有目录接上远程仓库
#
#  ---- 环境变量 ----
#    APP_DIR     代码目录，默认本脚本的上一级
#    SVC         systemd 服务名，默认 typing-trainer
#    BRANCH      默认分支，默认从 origin/HEAD 推断
#    HEALTH      健康检查路径，默认 /api/ping
#    BACKUP_DIR  部署前数据库备份位置，默认 /data/backup
#    HIST_KEEP   部署历史保留条数，默认 50
#    FORCE=1     允许丢弃工作区里未提交的本地修改
#    SKIP_BACKUP=1  跳过部署前数据库备份（不推荐）
#
#  ---- 三条硬规则 ----
#   1. data/ 在 .gitignore 里，git 永远不碰它；本脚本也从不执行 git clean。
#   2. 部署前必定先停服务、再备份 db.sqlite，避免 WAL 半截状态。
#   3. 新版本启动失败会自动切回上一个版本并重启，不需要人守着。
# =====================================================================
set -euo pipefail

# ---------------------------------------------------------------- 自复制
# 部署过程中会把仓库切到别的 commit，脚本文件本身可能被替换甚至删除。
# bash 是边读边执行的，文件被换掉会导致后半段读错。先把自己拷到 /tmp 再 exec。
if [ -z "${PD_REEXEC:-}" ]; then
  PD_TMP="$(mktemp -t pull-deploy-XXXXXX.sh)"
  cat "${BASH_SOURCE[0]}" > "$PD_TMP"
  export PD_REEXEC=1
  export APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  exec bash "$PD_TMP" "$@"
fi
trap 'rm -f "$0" 2>/dev/null || true' EXIT

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_0=$'\033[0m'
step() { echo -e "\n\033[36m▶ $*\033[0m"; }
ok()   { echo -e "  ${c_ok}✓${c_0} $*"; }
warn() { echo -e "  ${c_warn}!${c_0} $*"; }
die()  { echo -e "  ${c_err}✗ $*${c_0}"; exit 1; }

APP_DIR="${APP_DIR:-$PWD}"

# git ≥ 2.35 遇到「仓库属主 ≠ 当前用户」会拒绝操作，报
#   fatal: detected dubious ownership in repository at '...'
# 而 setup.sh 会把代码目录 chown 给运行账号（typing），本脚本却要用 root 跑，
# 两边对不上 —— 不放行的话，装完第一次更新就挂在这里。
# 做法：先探一下这个目录能不能正常读，读不了才为它单独放行（不放开全局）。
# 已经放行过就读得通，不会重复追加。
if [ -d "$APP_DIR/.git" ] && ! git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
fi

SVC="${SVC:-typing-trainer}"
BRANCH="${BRANCH:-}"
HEALTH="${HEALTH:-/api/ping}"
BACKUP_DIR="${BACKUP_DIR:-/data/backup}"
HIST_KEEP="${HIST_KEEP:-50}"
FORCE="${FORCE:-0}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"

ACTION=deploy
TARGET=""
INIT_URL=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --init)
      ACTION=init; shift
      [ $# -gt 0 ] || die "--init 后面要跟仓库地址"
      INIT_URL="$1"; shift ;;
    --rollback)
      ACTION=rollback; shift
      if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then TARGET="$1"; shift; fi ;;
    --list)   ACTION=list;   shift ;;
    --status) ACTION=status; shift ;;
    --force)  FORCE=1;       shift ;;
    --no-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "未知参数：$1（--help 看用法）" ;;
    *)  TARGET="$1"; shift ;;
  esac
done

# ---------------------------------------------------------------- 工具
detect_branch() {
  if [ -n "$BRANCH" ]; then echo "$BRANCH"; return; fi
  local b
  b="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  if [ -n "$b" ]; then echo "$b"; return; fi
  if git rev-parse --verify --quiet origin/main   >/dev/null 2>&1; then echo main;   return; fi
  if git rev-parse --verify --quiet origin/master >/dev/null 2>&1; then echo master; return; fi
  echo main
}

# 把任意写法（空 / 分支名 / tag / sha / HEAD~1）解析成 commit sha
resolve_sha() {
  local t="${1:-}"
  [ -n "$t" ] || t="$(detect_branch)"
  # 优先远程分支，避免本地分支落后于远程
  if git rev-parse --verify --quiet "origin/$t^{commit}" >/dev/null 2>&1; then
    git rev-parse "origin/$t^{commit}"; return 0
  fi
  if git rev-parse --verify --quiet "$t^{commit}" >/dev/null 2>&1; then
    git rev-parse "$t^{commit}"; return 0
  fi
  return 1
}

short() { git rev-parse --short "$1" 2>/dev/null || echo "${1:0:7}"; }

probe() {
  local i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT$HEALTH" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

record() {
  local sha="$1" ref="$2" res="$3"
  mkdir -p "$APP_DIR/.deploy"
  printf '%s %s %s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$sha" "$ref" "$res" \
    >> "$APP_DIR/.deploy/history"
  if [ "$(wc -l < "$APP_DIR/.deploy/history")" -gt "$HIST_KEEP" ]; then
    tail -n "$HIST_KEEP" "$APP_DIR/.deploy/history" > "$APP_DIR/.deploy/.h.tmp"
    mv "$APP_DIR/.deploy/.h.tmp" "$APP_DIR/.deploy/history"
  fi
}

read_runtime() {
  RUN_USER="$(systemctl show -p User --value "$SVC" 2>/dev/null || true)"
  [ -n "$RUN_USER" ] || RUN_USER="$(stat -c %U "$APP_DIR" 2>/dev/null || echo root)"
  PORT="$(systemctl show -p Environment --value "$SVC" 2>/dev/null \
    | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1 || true)"
  [ -n "$PORT" ] || PORT=8091
}

# ---------------------------------------------------------------- 备份
backup_db() {
  local db="$APP_DIR/data/db.sqlite"
  if [ ! -f "$db" ]; then
    ok "没有数据库文件，跳过备份"
    return 0
  fi
  if [ "$SKIP_BACKUP" = "1" ]; then
    warn "SKIP_BACKUP=1：跳过了数据库备份"
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  local out="$BACKUP_DIR/db-$(date +%F-%H%M%S)-predeploy.sqlite"
  # 此刻服务已停，三个文件是静止的，直接 cp 就是一致的
  cp -p "$db" "$out"
  [ -f "$db-wal" ] && cp -p "$db-wal" "$out-wal" || true
  [ -f "$db-shm" ] && cp -p "$db-shm" "$out-shm" || true
  ok "数据库已备份：$out（$(du -h "$out" | cut -f1)）"
  # 只留最近 20 份，别把磁盘堆满
  ls -1t "$BACKUP_DIR"/db-*-predeploy.sqlite 2>/dev/null | tail -n +21 | xargs -r rm -f || true
}

# ---------------------------------------------------------------- 依赖
install_deps() {
  if [ -f "$APP_DIR/package.json" ]; then
    local marker="$APP_DIR/node_modules/.package-lock.json"
    local need=0
    [ -d "$APP_DIR/node_modules" ] || need=1
    [ -f "$marker" ] || need=1
    if [ "$need" = "0" ] && [ "$APP_DIR/package.json" -nt "$marker" ]; then need=1; fi
    if [ "$need" = "0" ] && [ -f "$APP_DIR/package-lock.json" ] \
       && [ "$APP_DIR/package-lock.json" -nt "$marker" ]; then need=1; fi

    if [ "$need" = "0" ]; then
      ok "依赖未变化，跳过安装"
      return 0
    fi
    local npm; npm="$(command -v npm || true)"
    [ -n "$npm" ] || die "找不到 npm，检查 Node 是否安装"
    if ( cd "$APP_DIR" && "$npm" ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
      ok "依赖已安装（npm ci）"
    elif ( cd "$APP_DIR" && "$npm" install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
      ok "依赖已安装（npm install）"
    elif ( cd "$APP_DIR" && "$npm" install --production --no-audit --no-fund >/dev/null 2>&1 ); then
      ok "依赖已安装（npm install --production）"
    else
      die "依赖安装失败，手动排查：cd $APP_DIR && npm install --omit=dev"
    fi
  elif [ -f "$APP_DIR/requirements.txt" ]; then
    [ -x "$APP_DIR/.venv/bin/pip" ] || die "没找到 .venv，Python 项目请先用 setup-python.sh 部署一次"
    "$APP_DIR/.venv/bin/pip" install --no-cache-dir -q -r "$APP_DIR/requirements.txt" \
      || die "pip 安装失败"
    ok "Python 依赖已安装"
  fi
}

# ---------------------------------------------------------------- 核心部署
# 把工作区切到 $1 指定的版本，起服务，探活；失败自动退回上一个版本。
do_deploy() {
  local ref="$1"
  local new_sha prev_sha
  prev_sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  new_sha="$(resolve_sha "$ref")" || die "找不到版本：$ref（先 --status 看远程有什么）"

  step "目标版本"
  echo "  目标  $(short "$new_sha")  $(git log -1 --format=%s "$new_sha" | cut -c1-60)"
  [ -n "$prev_sha" ] && echo "  当前  $(short "$prev_sha")  $(git log -1 --format=%s "$prev_sha" | cut -c1-60)"

  if [ "$new_sha" = "$prev_sha" ]; then
    ok "已经是这个版本，只做重启"
  else
    step "切换代码"
    # checkout 具体 sha 会进 detached HEAD：不移动任何分支指针，
    # 所以"部署旧版本"不会把 main 搞乱。
    git checkout -f "$new_sha" 2>&1 | sed 's/^/    /'
    ok "已切到 $(short "$new_sha")"
  fi

  install_deps
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

  step "启动服务"
  systemctl start "$SVC" 2>/dev/null || systemctl restart "$SVC"
  if probe; then
    ok "服务正常（127.0.0.1:$PORT$HEALTH）"
    record "$new_sha" "$(short "$new_sha")" ok
    return 0
  fi

  # ---- 失败自动回滚 ----
  echo ""
  warn "新版本启动失败，日志如下："
  journalctl -u "$SVC" -n 30 --no-pager 2>/dev/null | sed 's/^/    /' || true
  if [ -z "$prev_sha" ]; then
    record "$new_sha" "$(short "$new_sha")" fail
    die "没有可回退的上一版本，需要人工处理"
  fi

  warn "自动回退到 $(short "$prev_sha")"
  git checkout -f "$prev_sha" >/dev/null 2>&1 || true
  install_deps || true
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
  systemctl restart "$SVC" || true
  if probe; then
    record "$new_sha" "$(short "$new_sha")" fail
    echo ""
    die "新版本有问题，已自动回退到 $(short "$prev_sha") 并恢复正常。修复后重新部署即可"
  fi
  record "$new_sha" "$(short "$new_sha")" fail
  die "回退后仍然连不上，需要人工介入：journalctl -u $SVC -n 50"
}

# ---------------------------------------------------------------- 各动作
do_init() {
  local url="$1"
  [ -n "$url" ] || die "--init 需要仓库地址，例如 https://github.com/you/repo.git"
  cd "$APP_DIR"

  step "关联远程仓库"
  if [ -d .git ]; then
    ok "已经是 git 仓库"
    if git remote get-url origin >/dev/null 2>&1; then
      git remote set-url origin "$url"
    else
      git remote add origin "$url"
    fi
  else
    git init -q
    git remote add origin "$url"
    ok "已初始化：$APP_DIR"
  fi
  ok "origin = $url"

  step "拉取远程"
  if ! git fetch origin --prune 2>&1 | sed 's/^/    /'; then
    die "git fetch 失败。先确认服务器能访问 github.com（curl -I https://github.com）；若仓库已改回私有，需要配部署密钥，见 deploy/README-git.md"
  fi

  local b; b="$(detect_branch)"
  git rev-parse --verify --quiet "origin/$b" >/dev/null 2>&1 \
    || die "远程没有分支 $b（用 BRANCH=xxx 指定）"

  # 关键顺序：先落 .gitignore，再 checkout。
  # 否则 data/ 还没被忽略，git 会把里面的文件当成"要删除的旧文件"。
  if git cat-file -e "origin/$b:.gitignore" 2>/dev/null; then
    git show "origin/$b:.gitignore" > .gitignore
    ok "已写入远程仓库的 .gitignore（data/ 受保护）"
  else
    warn "远程仓库没有 .gitignore，data/ 可能被当成普通文件"
  fi

  step "同步代码"
  git checkout -f --detach "origin/$b" 2>&1 | sed 's/^/    /'
  ok "已同步到 $(short "$(git rev-parse HEAD)")"

  echo ""
  echo "  数据目录：$APP_DIR/data"
  if [ -f "$APP_DIR/data/db.sqlite" ]; then
    ok "原有数据库还在，没被动过"
  else
    warn "data/ 里没有数据库，服务首次启动会新建空库（如果这里有历史成绩，先停下来检查）"
  fi
  echo ""
  echo "  下一步：sudo bash deploy/pull-deploy.sh --status"
}

do_list() {
  local h="$APP_DIR/.deploy/history"
  [ -f "$h" ] || die "还没有部署记录（先跑一次部署，或 --init 后部署）"
  echo ""
  printf '  %-20s %-9s %-10s %s\n' "时间" "版本" "结果" "目标"
  printf '  %-20s %-9s %-10s %s\n' "--------------------" "---------" "----------" "----"
  tail -n 20 "$h" | awk '{
    r = ($4 == "ok") ? "成功" : "失败";
    printf "  %-20s %-9s %-10s %s\n", $1, substr($2,1,7), r, $3
  }'
  echo ""
  echo "  当前 HEAD：$(short "$(git rev-parse HEAD 2>/dev/null || echo none)")"
}

do_status() {
  cd "$APP_DIR"
  step "当前版本"
  git log -1 --format='  %h  %ad  %s' --date=short

  step "工作区"
  local dirty
  dirty="$(git status --porcelain 2>/dev/null || true)"
  if [ -z "$dirty" ]; then
    ok "干净（data/ 已被忽略，不算修改）"
  else
    warn "有未提交的修改，部署时会被丢弃："
    echo "$dirty" | head -15 | sed 's/^/    /'
  fi

  step "与远程对比"
  if ! git fetch --quiet origin --prune 2>/dev/null; then
    warn "git fetch 失败（网络或凭据问题）"
    return 0
  fi
  local b behind ahead
  b="$(detect_branch)"
  behind="$(git rev-list --count "HEAD..origin/$b" 2>/dev/null || echo '?')"
  ahead="$(git rev-list --count "origin/$b..HEAD" 2>/dev/null || echo '?')"
  echo "  远程 $b：落后 $behind 个提交，领先 $ahead 个"
  if [ "$behind" != "0" ] && [ "$behind" != "?" ]; then
    echo "  可以拉的提交："
    git log --oneline "HEAD..origin/$b" 2>/dev/null | head -10 | sed 's/^/    /'
  fi
}

do_rollback() {
  local cur target
  cur="$(git rev-parse HEAD)"
  if [ -n "$TARGET" ]; then
    target="$TARGET"
  else
    local h="$APP_DIR/.deploy/history"
    [ -f "$h" ] || die "没有部署历史，无法自动回滚。可以指定版本：--rollback <sha>"
    # 从最新往回找第一个和当前不同的版本
    target="$(awk -v cur="$cur" '{a[NR]=$2} END{for(i=NR;i>0;i--) if(a[i]!=cur){print a[i]; exit}}' "$h")"
    [ -n "$target" ] || die "历史里只有当前这一个版本，没有可回退的目标"
  fi
  ok "回退目标：$(short "$target")"
  do_deploy "$target"
}

# ---------------------------------------------------------------- 主流程
main() {
  [ -d "$APP_DIR" ] || die "目录不存在：$APP_DIR"
  cd "$APP_DIR"

  # 只读动作不要求 root，方便本地/普通用户先看看情况
  case "$ACTION" in
    list|status) ;;
    *) [ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0" ;;
  esac

  case "$ACTION" in
    init)   do_init "$INIT_URL"; exit 0 ;;
    list)   do_list;   exit 0 ;;
    status) do_status; exit 0 ;;
  esac

  # ---- 以下都是要动服务的动作 ----
  [ -d .git ] || die "$APP_DIR 不是 git 仓库。首次请先：bash deploy/pull-deploy.sh --init <仓库地址>"
  git remote get-url origin >/dev/null 2>&1 || die "没有配置 origin 远程地址"
  systemctl cat "$SVC" >/dev/null 2>&1 \
    || die "服务 $SVC 未注册。首次部署请先跑 deploy/setup.sh，本脚本只管更新"

  read_runtime

  step "拉取远程"
  if ! git fetch --all --tags --prune 2>&1 | sed 's/^/    /'; then
    die "git fetch 失败：检查网络、仓库地址、部署密钥（见 deploy/README-git.md）"
  fi

  # 工作区有未提交修改 → checkout 会丢。先亮出来再决定
  local dirty
  dirty="$(git status --porcelain 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    warn "工作区有未提交的本地修改，部署会丢弃："
    echo "$dirty" | head -15 | sed 's/^/    /'
    if [ "$FORCE" != "1" ]; then
      die "确认要丢弃请加 --force；想保留就先 git stash 或提交"
    fi
    warn "FORCE=1，继续（这些修改将被丢弃）"
  fi

  step "停止服务"
  systemctl stop "$SVC" 2>/dev/null || true
  ok "已停止（保证数据库是静止的，备份才一致）"

  backup_db

  if [ "$ACTION" = "rollback" ]; then
    do_rollback
  else
    do_deploy "$TARGET"
  fi

  # ---- 收尾 ----
  local cur
  cur="$(git rev-parse HEAD)"
  echo ""
  echo -e "${c_ok}======================================================================${c_0}"
  echo -e "${c_ok}   部署完成${c_0}"
  echo -e "${c_ok}======================================================================${c_0}"
  echo "  当前版本： $(short "$cur")  $(git log -1 --format=%s "$cur" | cut -c1-50)"
  echo "  服务状态： $(systemctl is-active "$SVC" 2>/dev/null || echo unknown)"
  if [ -f "$APP_DIR/data/db.sqlite" ]; then
    echo "  数据库：   $APP_DIR/data/db.sqlite（未被改动）"
  fi
  echo ""
  echo "  看历史：   sudo bash deploy/pull-deploy.sh --list"
  echo "  要回滚：   sudo bash deploy/pull-deploy.sh --rollback"
  echo ""
}

main
