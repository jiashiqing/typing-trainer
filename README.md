# 打字练习系统 · 联网版

面向中小学信息技术课的键盘技能训练系统。学生在浏览器里练打字，教师端实时看进度和成绩，大屏可以投屏到教室前面。

**零依赖**：只用 Node.js 内置模块，不需要 `npm install`，没有第三方包。

**仓库**：<https://github.com/jiashiqing/typing-trainer>（公开仓库，任何服务器 `git clone` 直接拉，不需要账号口令）

---

## 功能

| 模块 | 内容 |
|---|---|
| 学生端 | 键位闯关（虚拟键盘 + 手指提示）、落字游戏、速度练习（跟打）、单词冲刺、中文跟打 |
| 教师端 | 课堂总览（实时进度墙）、排行榜（五种榜单）、学情分析（错键热力图）、课堂管理 |
| 大屏看板 | 榜单 + 进度墙 + 实时动态，适合投影到教室前面 |
| 权限 | 超级管理员 / 普通教师两档访问码。普通教师看不到学校名单、测评下发等管理功能 |

**成绩口径**：准确率低于 60% 的成绩只记录、不进榜、不计分；速度超过上限的判为异常数据。判定全部在服务端完成，前端改数字没有用。

---

## 环境要求

- **Node.js ≥ 22.13**（用到内置的 `node:sqlite`；22.5–22.12 也能跑，但启动要加 `--experimental-sqlite`）
- 浏览器：Chrome / Edge / 任何现代浏览器
- 服务器部署：Ubuntu 20.04+ / Debian 11+ / Rocky 8+（glibc ≥ 2.28）

> CentOS 7 跑不了，它的 glibc 2.17 太老，装不上 Node 22。

---

## 快速开始（本地）

```bash
git clone https://github.com/jiashiqing/typing-trainer.git typing-trainer
cd typing-trainer
node server.js
```

启动后终端会打印两个地址和两个访问码：

```
学生端  http://192.168.1.10:8090/
教师端  http://192.168.1.10:8090/teacher
大屏    http://192.168.1.10:8090/screen

教师端访问码：超级管理员 xxxxxx   普通教师 xxxxxx
```

同机房的学生用「学生端」地址就能进。

Windows 上也可以直接双击 `start.bat`；`查看服务状态.bat` / `停止服务.bat` 管进程。

---

## 部署到服务器

两套脚本，分工明确：

| 脚本 | 什么时候用 | 干什么 |
|---|---|---|
| `deploy/setup.sh` | **首次**上服务器 | 装 Node、建运行账号、写 systemd、配 Nginx、开端口、可选 HTTPS |
| `deploy/pull-deploy.sh` | 以后**每次更新** | 从 git 拉代码、装依赖、重启、探活，失败自动回滚 |

### 首次

```bash
# 服务器上，以 root 执行
apt update && apt install -y git      # 全新系统可能没装 git
git clone https://github.com/jiashiqing/typing-trainer.git /data/web/typing-trainer
cd /data/web/typing-trainer
sudo -E APP_DIR="$(pwd)" WEB_PORT=8090 bash deploy/setup.sh
```

> `APP_DIR` 写成当前目录，就是「原地部署」：不拷贝代码，数据也留在原地。
> 仓库名、目录名、systemd 服务名统一为 `typing-trainer`，查状态用 `systemctl status typing-trainer`。
> 云服务器（腾讯云 / 阿里云）还要在**安全组**入站规则里放行 `8090`，否则装完了外面也打不开。
> 脚本跑完会打印学生端 / 教师端 / 大屏地址和网页口令，照着敲进浏览器即可。

#### 只有 ubuntu 账号、没有 root 权限怎么办

云服务器现在多数默认给 `ubuntu` 用户，**不用切 root，也不用开 root 登录**，命令前加 `sudo` 就行。只有一处要额外做：先把 `/data/web` 交给 `ubuntu`，否则 `git clone` 写不进去。

```bash
sudo apt update && sudo apt install -y git

sudo mkdir -p /data/web
sudo chown "$(id -un):$(id -gn)" /data/web      # 让当前用户能往这个目录写

mkdir -p /data/web && cd /data/web
git clone https://github.com/jiashiqing/typing-trainer.git typing-trainer
cd typing-trainer
sudo -E APP_DIR="$(pwd)" WEB_PORT=8090 bash deploy/setup.sh
```

装完之后代码目录归运行账号 `typing` 所有（服务以它身份跑，权限比 root 小），所以：

- 以后更新一律 `sudo bash deploy/pull-deploy.sh`
- 手工看仓库状态用 `sudo git -C /data/web/typing-trainer status`；直接 `git status` 会报 `dubious ownership`（脚本已自动给它加 `safe.directory`，手工命令没这条）
- 改代码**不在服务器上改**：本地改完 push，服务器拉

#### 国内服务器拉不动 GitHub 怎么办

看到 `GnuTLS recv error (-110): The TLS connection was non-properly terminated` 这个报错，是国内服务器连 GitHub 时 TLS 被中断，**不是仓库权限问题，也不是地址写错了**。三个办法，从快到稳：

**① 套一个加速前缀**（十几秒搞定；clone 后 `origin` 就是这个地址，以后拉取也走加速）

```bash
git clone https://ghfast.top/https://github.com/jiashiqing/typing-trainer.git typing-trainer
# 不通就换下面两个前缀，任选其一：
#   https://ghproxy.net/https://github.com/jiashiqing/typing-trainer.git
#   https://gh-proxy.com/https://github.com/jiashiqing/typing-trainer.git
```

**② Node 也别从 NodeSource 下**（同样会被卡住）。先用国内镜像把 Node 装好，`setup.sh` 检测到版本够了就直接跳过联网安装：

```bash
cd /tmp
curl -fsSLO https://registry.npmmirror.com/-/binary/node/v22.20.0/node-v22.20.0-linux-x64.tar.xz
sudo tar -xJf node-v22.20.0-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v      # 应输出 v22.20.0
```

> 若提示 `xz: command not found`，先 `sudo apt install -y xz-utils`。

**③ 长期方案：Gitee 镜像。** Gitee 上「新建仓库 → 导入 GitHub 仓库」，同步完从 Gitee clone，国内通常几 MB/s。本地同时推两个 remote，见 [deploy/README-git.md](deploy/README-git.md) 第 3 节。

#### 全部可传参数

**`deploy/setup.sh`（首次部署 / 改配置都跑它，重复执行安全）**

位置参数（放在最后，`bash deploy/setup.sh` 后面）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `域名` | 无 | 传了自动申请 Let's Encrypt 证书并切 HTTPS；此时对外端口固定 80/443 |

环境变量（**必须写在 `sudo -E` 之后、`bash` 之前**）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_DIR` | `/opt/typing-trainer` | 装到哪；原地部署写 `"$(pwd)"` |
| `WEB_PORT` | `80` | 对外端口；有域名时忽略 |
| `BACKEND_PORT` | `8091` | Node 实际监听端口，只绑 127.0.0.1，不对外 |
| `MODE` | `basic` | `basic` 整站口令 / `ipallow` 按来源 IP 白名单 / `open` 不设防 |
| `WEB_USER` | `typing` | basic 模式的口令用户名 |
| `WEB_PASS` | 随机 12 位 | basic 模式的口令密码，留空自动生成并打印 |
| `ALLOW_CIDR` | 空 | `ipallow` 必填，空格分隔多个：`"10.0.0.0/8 192.168.31.0/24"` |
| `EMAIL` | 空 | certbot 注册邮箱；不填则不注册（收不到到期提醒，续期照跑） |
| `PUBLIC_URL` | 自动推导 | 手动指定对外地址，影响二维码和启动横幅；默认取公网 IP + 端口 |
| `NO_NGINX` | `0` | `1`＝不装 Nginx，Node 直接对外；无口令无限速，仅临时测试 |
| `I_KNOW` | `0` | `1`＝跳过「源码里带数据库却装到空目录」的防呆拦截 |

服务名（`typing-trainer`）和运行账号（`typing`）是写死的，不接受传参。

**`deploy/pull-deploy.sh`（日常更新 / 回滚）**

| 用法 | 作用 |
|---|---|
| `sudo bash deploy/pull-deploy.sh` | 拉默认分支最新并部署 |
| `... v1.0` 或 `... a1b2c3d` | 部署指定 tag / commit |
| `... --rollback` | 退回上一次部署的版本 |
| `... --rollback <sha>` | 退回指定版本 |
| `... --list` | 看部署历史（不需要 root） |
| `... --status` | 看当前版本比远程差多少（不需要 root） |
| `... --init <仓库地址>` | 首次把已有目录接上远程仓库 |

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_DIR` | 脚本所在目录的上一级 | 一般不用传 |
| `SVC` | `typing-trainer` | systemd 服务名 |
| `BRANCH` | 从 `origin/HEAD` 推断 | 主分支不叫 main/master 时用 |
| `HEALTH` | `/api/ping` | 探活路径 |
| `BACKUP_DIR` | `/data/backup` | 部署前数据库备份放哪 |
| `HIST_KEEP` | `50` | 部署历史保留条数 |
| `FORCE` | `0` | `1`＝丢弃工作区里未提交的本地修改 |
| `SKIP_BACKUP` | `0` | `1`＝跳过部署前备份（不推荐） |

**几个常用组合**

```bash
# 校内内网：只放行学校出口网段，学生完全无感
sudo -E APP_DIR=/data/web/typing-trainer WEB_PORT=8090 MODE=ipallow \
     ALLOW_CIDR="10.0.0.0/8 192.168.31.0/24" bash deploy/setup.sh

# 自定义网页口令
sudo -E APP_DIR=/data/web/typing-trainer WEB_PORT=8090 \
     WEB_USER=teacher WEB_PASS='Rizhao2026' bash deploy/setup.sh

# 有域名 + HTTPS + 到期提醒邮箱
sudo -E APP_DIR=/data/web/typing-trainer EMAIL=you@qq.com \
     bash deploy/setup.sh typing.example.com

# 换端口重装（重复执行安全，data/ 不动）
sudo -E APP_DIR=/data/web/typing-trainer WEB_PORT=8080 bash deploy/setup.sh
```

### 日常更新

```bash
sudo bash deploy/pull-deploy.sh            # 拉最新
sudo bash deploy/pull-deploy.sh --status   # 只看差异
sudo bash deploy/pull-deploy.sh --list     # 部署历史
sudo bash deploy/pull-deploy.sh --rollback # 退一个版本
```

详细步骤、GitHub / Gitee 选择、部署密钥配置、回滚的三种情况，见 **[deploy/README-git.md](deploy/README-git.md)**。

小白向的从零部署手册见 **[deploy/部署全流程-小白版.md](deploy/部署全流程-小白版.md)**。

---

## 目录结构

```
typing-trainer/
├── server.js              服务端：HTTP、SSE 推送、成绩计算、SQLite
├── lib/
│   ├── store.js           SQLite 封装（node:sqlite）
│   ├── qrcode.js          二维码生成（零依赖）
│   └── xlsx.js            Excel 解析（教师端导入名单）
├── public/
│   ├── index.html         学生端
│   ├── teacher.html       教师端
│   ├── screen.html        大屏看板
│   ├── core.js            公共状态与登录
│   ├── app.js             学生端主逻辑
│   ├── keydrill.js        键位闯关
│   ├── falling.js         落字游戏
│   ├── speed.js           速度练习
│   ├── wordrush.js        单词冲刺
│   ├── chinese.js         中文跟打
│   ├── rank.js            榜单合并与名次重算
│   └── teacher.js         教师端
├── deploy/                部署脚本与文档（不进运行时依赖）
├── tools/svc.js           本地服务管理（查状态 / 停止）
└── data/                  【运行时生成，不在版本库里】
```

---

## 数据在哪

**全部成绩存在 `data/db.sqlite` 一个文件里。**

- 这个目录在 `.gitignore` 里，永远不会进版本库
- 部署脚本从不覆盖它，切版本、回滚都碰不到
- 备份就是拷贝这个文件（最好连同 `-wal`、`-shm` 一起）

```bash
# 备份
cp data/db.sqlite /path/to/backup/db-$(date +%F).sqlite

# 恢复（必须先停服务）
systemctl stop typing-trainer
cp /path/to/backup/db-2026-11-03.sqlite data/db.sqlite
rm -f data/db.sqlite-wal data/db.sqlite-shm
systemctl start typing-trainer
```

---

## 技术要点

- **SSE 增量推送**：只推变化的那一行，不推整份榜单。5,000 人在线时单条消息约 1 KB，整表要 2 MB
- **机位互斥**：同一台电脑换人，服务端立刻把上一位从在线列表摘掉，不用等超时
- **登录态分两档**：学生身份存 `sessionStorage`（关页失效、F5 保留），学校班级记忆存 `localStorage`
- **名次前端重算**：前端必须和服务端的排序算法严格同构，否则名次会跳

---

## 许可

内部教学使用。
