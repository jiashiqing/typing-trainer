# 用 Git 管理代码并从服务器拉取部署

> 前提：已经用 `deploy/setup.sh` 完成过首次部署（systemd、Nginx、端口都配好了）。
> 本文解决的是**日常更新**：改完代码推上去，服务器拉下来重启。

---

## 目录

1. [两种部署脚本的分工](#1-两种部署脚本的分工)
2. [第一步：把项目推上 GitHub / Gitee](#2-第一步把项目推上-github--gitee)
3. [GitHub 还是 Gitee](#3-github-还是-gitee)
4. [私有仓库怎么让服务器有权限拉](#4-私有仓库怎么让服务器有权限拉)
5. [服务器首次接上远程仓库](#5-服务器首次接上远程仓库)
6. [日常部署](#6-日常部署)
7. [回滚的三种情况](#7-回滚的三种情况)
8. [数据安全说明](#8-数据安全说明)
9. [常见问题](#9-常见问题)

---

## 1. 两种部署脚本的分工

| | `deploy/setup.sh` | `deploy/pull-deploy.sh` |
|---|---|---|
| 用在什么时候 | **首次**上服务器 | **每次更新** |
| 代码从哪来 | 从你电脑 scp 上去 | 从 git 仓库拉 |
| 管什么 | 装 Node、建账号、写 systemd、配 Nginx、开端口 | 换代码、装依赖、重启、探活 |
| 会动 systemd/Nginx 吗 | 会写配置 | **完全不碰** |
| 会动 data/ 吗 | 不覆盖（tar 排除） | 不动（.gitignore + 脚本不执行 git clean） |

**两个脚本可以共存，互不覆盖。** 首次用 setup.sh，之后一直用 pull-deploy.sh。改过 Nginx 配置想重新下发，再跑一次 setup.sh 也没问题。

---

## 2. 第一步：把项目推上 GitHub / Gitee

### 2.1 先建一个**空仓库**

- GitHub：右上角 `+` → New repository → 填名字（比如 `typing-trainer`）→ **不要**勾 "Add a README file"、**不要**选 .gitignore 模板
- Gitee：新建仓库 → 同样保持空仓库

勾了会多出一个初始提交，你第一次 push 会冲突，得多绕一步。空仓库最省事。

### 2.2 本地初始化并推送

在**你自己的电脑**上，打开 PowerShell：

```powershell
cd D:\工作空间\WorkBuddy工作空间\AI×教师\打字练习系统-联网版

git init
git add .
git status
```

**这一步必须停下来看一眼 `git status` 的输出。** 确认这两样东西**没有**出现在待提交列表里：

- `data/` —— 学生成绩库，进了 git 就等于把全校名单传到公网
- `预览截图/` —— 3.8 MB 图片，部署用不上

如果它们出现了，说明 `.gitignore` 没生效，检查文件是不是存在、有没有被改名。

确认干净后：

```powershell
git commit -m "初始版本：五种练习模式 + 教师端 + 大屏"
git branch -M main
git remote add origin https://github.com/jiashiqing/typing-trainer.git
git push -u origin main
```

> 地址换成你刚建的那个仓库。私有仓库会弹窗要账号，用 **Personal Access Token** 当密码（GitHub 早就不让用登录密码了），Token 在 Settings → Developer settings → Personal access tokens 里生成，勾 `repo` 权限即可。

### 2.3 打一个版本标签

标签是回滚时的锚点，比记 commit 哈希靠谱：

```powershell
git tag -a v1.0 -m "首个线上版本"
git push origin v1.0
```

以后每次上线前打一个：`v1.1`、`v1.2`……

---

## 3. GitHub 还是 Gitee

| | GitHub | Gitee |
|---|---|---|
| 国内服务器 `git clone` 速度 | 慢，几十 KB/s，偶尔超时 | 快，通常几 MB/s |
| 私有仓库 | 免费 | 免费 |
| 注册门槛 | 邮箱就行 | **需要实名认证**（手机号+身份证） |
| 稳定性（国内访问） | 一般 | 好 |

**建议：代码主库放 GitHub，同时在 Gitee 放一份镜像。** 服务器优先从 Gitee 拉，快且稳；GitHub 那份用来长期存档和后续接 CI。

加镜像很简单，在本地仓库里：

```powershell
git remote add gitee https://gitee.com/你的用户名/typing-trainer.git
git push gitee main --tags
```

以后每次推两个：

```powershell
git push origin main --tags
git push gitee main --tags
```

服务器上想换源，一条命令：

```bash
git remote set-url origin https://gitee.com/你的用户名/typing-trainer.git
```

---

## 4. 私有仓库怎么让服务器有权限拉

**不要**把账号密码或 Token 写进 URL（会明文躺在 `.git/config` 里，任何能读这个文件的人都能看到）。

推荐 **Deploy Key**：只读、只对一个仓库有效、泄露了也只影响这一个仓库。

### 4.1 在服务器上生成密钥

```bash
ssh-keygen -t ed25519 -C "deploy@typing-trainer" -f /root/.ssh/typing_deploy -N ""
cat /root/.ssh/typing_deploy.pub
```

会输出一行 `ssh-ed25519 AAAA...`，**整行复制**。

### 4.2 加到仓库

- GitHub：仓库 → Settings → **Deploy keys** → Add deploy key → 粘贴 → **不要**勾 "Allow write access"
- Gitee：仓库 → 管理 → **部署公钥管理** → 添加部署公钥 → 粘贴

### 4.3 告诉 ssh 用这把钥匙

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/typing_deploy
  StrictHostKeyChecking accept-new

Host gitee.com
  IdentityFile /root/.ssh/typing_deploy
  StrictHostKeyChecking accept-new
EOF
chmod 600 /root/.ssh/config /root/.ssh/typing_deploy
```

测试：

```bash
ssh -T git@github.com
```

看到 `Hi 用户名/repo! You've successfully authenticated` 就通了（提示 `does not provide shell access` 是正常的）。

### 4.4 远程地址用 SSH 形式

```bash
git remote set-url origin git@github.com:jiashiqing/typing-trainer.git
```

**必须是 `git@` 开头**，不是 `https://`。HTTPS 形式不会用 Deploy Key。

### 4.5 公开仓库就不用折腾这些

仓库设成 Public 的话，`https://` 地址直接能拉，不需要任何密钥。教学内容不涉密的话，这是最省事的做法。

---

## 5. 服务器首次接上远程仓库

分两种情况，看你服务器上有没有旧代码。

### 5.0 全新服务器：直接 clone（最省事）

服务器上还没有代码，就别用 `--init`，克隆下来就是一套完整可跑的：

```bash
mkdir -p /data/web && cd /data/web
git clone git@github.com:jiashiqing/typing-trainer.git typing-trainer
cd typing-trainer
sudo -E APP_DIR="$(pwd)" WEB_PORT=8090 bash deploy/setup.sh
```

要点：

- 私有仓库**必须先做第 4 节的 Deploy Key**，否则 clone 会要账号密码
- 克隆下来没有 `data/` —— 第一次启动会自动建库、自动初始化学校名单，这是正常的
- `deploy/*.sh` 的可执行位在仓库里已经设好（`100755`），clone 后 `bash deploy/setup.sh` 或 `./deploy/setup.sh` 都能跑
- 目录名、systemd 服务名、仓库名统一为 `typing-trainer`，查状态用 `systemctl status typing-trainer`

### 5.1 已有旧代码的老目录（从手工部署转成 git 部署）

你现在的服务器目录 `/data/web/typing-trainer` 里有代码、有数据库，但**还不是 git 仓库**。

> **如果服务器上的目录还叫 `/data/web/dazi-trainer`**（早期部署留下的名字），先改名再往下做，否则文档里的路径全都对不上：
>
> ```bash
> sudo systemctl stop typing-trainer
> sudo mv /data/web/dazi-trainer /data/web/typing-trainer
> sudo sed -i 's#/data/web/dazi-trainer#/data/web/typing-trainer#g' \
>     /etc/systemd/system/typing-trainer.service /etc/nginx/conf.d/*.conf
> sudo systemctl daemon-reload
> sudo nginx -t && sudo systemctl reload nginx
> sudo systemctl start typing-trainer
> systemctl status typing-trainer --no-pager | head -5
> ```
>
> 数据不会丢：`mv` 是同一块盘上的改名，`data/db.sqlite` 跟着目录一起走。改完确认网页能打开再继续。

### 5.2 先把脚本传上去

鸡生蛋问题：脚本本身在 git 里，但服务器还没接上 git。所以先手动传一次：

```powershell
cd D:\工作空间\WorkBuddy工作空间\AI×教师\打字练习系统-联网版
scp deploy\pull-deploy.sh root@43.142.117.18:/data/web/typing-trainer/deploy/
```

### 5.3 执行关联

```bash
cd /data/web/typing-trainer
sudo bash deploy/pull-deploy.sh --init git@github.com:jiashiqing/typing-trainer.git
```

它做这几件事：

1. `git init` + 配好 origin
2. `git fetch` 拉远程
3. **先把远程的 `.gitignore` 落下来** —— 这一步是关键，不先忽略 `data/` 的话，后面的 checkout 会把数据库当垃圾清掉
4. `git checkout --detach origin/main` 把代码切成远程版本

跑完它会告诉你「原有数据库还在，没被动过」。**如果它说 data/ 里没有数据库，立刻停下**，说明路径不对，先去确认库在哪。

### 5.4 init 之后检查一遍

```bash
sudo bash deploy/pull-deploy.sh --status
```

预期：

```
▶ 当前版本
  ce221b1  2026-11-03  初始版本：五种练习模式 + 教师端 + 大屏
▶ 工作区
  ✓ 干净（data/ 已被忽略，不算修改）
▶ 与远程对比
  远程 main：落后 0 个提交，领先 0 个
```

「工作区干净」很重要 —— 如果它说有未提交修改，说明服务器上有和仓库不一样的文件，部署时会丢，要人工比对一下。

---

## 6. 日常部署

改完代码，本地推上去：

```powershell
git add -A
git commit -m "准确率门槛改成 60%"
git tag -a v1.1 -m "门槛调整"
git push origin main --tags
git push gitee main --tags        # 有镜像的话
```

服务器上：

```bash
cd /data/web/typing-trainer
sudo bash deploy/pull-deploy.sh
```

输出会走这几步：

```
▶ 拉取远程
▶ 停止服务
  ✓ 已停止（保证数据库是静止的，备份才一致）
  ✓ 数据库已备份：/data/backup/db-2026-11-03-164512-predeploy.sqlite（2.1M）
▶ 目标版本
  目标  a1b2c3d  准确率门槛改成 60%
  当前  ce221b1  初始版本：五种练习模式 + 教师端 + 大屏
▶ 切换代码
▶ 依赖未变化，跳过安装
▶ 启动服务
  ✓ 服务正常（127.0.0.1:8091/api/ping）
======================================================================
   部署完成
======================================================================
```

### 部署到指定版本

```bash
sudo bash deploy/pull-deploy.sh v1.0          # 某个标签
sudo bash deploy/pull-deploy.sh a1b2c3d       # 某个 commit
sudo bash deploy/pull-deploy.sh feature-x     # 某个分支的最新
```

### 只看不动

```bash
sudo bash deploy/pull-deploy.sh --status      # 和远程差多少
sudo bash deploy/pull-deploy.sh --list        # 最近 20 次部署
```

`--list` 长这样：

```
  时间                 版本      结果       目标
  -------------------- --------- ---------- ----
  2026-11-03T16:45:12  a1b2c3d   成功       a1b2c3d
  2026-11-03T15:20:08  ce221b1   成功       ce221b1
  2026-11-02T09:11:33  93c98a9   失败       v1.0
```

---

## 7. 回滚的三种情况

### 情况一：新版本起不来，脚本自己退回去

不需要你操作。探活连续 15 秒失败，脚本自动：

1. 打印失败日志（`journalctl` 最后 30 行）
2. 切回上一个版本
3. 重装依赖、重启、再探活
4. 探活通过 → 报「已自动回退到 xxx 并恢复正常」
5. 探活还失败 → 报「需要人工介入」

**这是最有价值的一条**：你不用担心半夜部署把系统搞挂。

### 情况二：你发现新版本有逻辑错误，手动回退一个版本

```bash
sudo bash deploy/pull-deploy.sh --rollback
```

它从部署历史里找**上一个和当前不同的版本**，切过去、重启、探活。再执行一次会继续往前退一个，不会来回横跳。

### 情况三：回到某个确定的版本

```bash
sudo bash deploy/pull-deploy.sh --rollback v1.0
sudo bash deploy/pull-deploy.sh --rollback a1b2c3d
```

### 回滚不会回滚数据

`data/` 不在版本库里，切版本对它零影响。学生成绩永远是服务器上那一份。

如果需要连数据一起回到某个时间点，用备份：

```bash
sudo systemctl stop typing-trainer
sudo cp /data/backup/db-2026-11-03-164512-predeploy.sqlite /data/web/typing-trainer/data/db.sqlite
sudo rm -f /data/web/typing-trainer/data/db.sqlite-wal /data/web/typing-trainer/data/db.sqlite-shm
sudo systemctl start typing-trainer
```

**`-wal` 和 `-shm` 必须一起删**，只换主文件会读到残留。

---

## 8. 数据安全说明

这套方案围绕一句话设计：**代码可丢弃，数据不可丢弃。**

| 机制 | 作用 |
|---|---|
| `.gitignore` 里 `data/` | 数据库永远进不了版本库，也永远不会被 git 动 |
| 脚本**从不执行** `git clean` | `git clean -fd` 会删掉所有未跟踪文件，包括数据库。这是最危险的一条命令，脚本里一次都没出现 |
| `checkout -f <sha>` 而非 `reset --hard` | 只影响被跟踪的文件，`data/` 是未跟踪状态，不受影响 |
| 部署前强制停服务再备份 | 运行时 `-wal` 文件是活动的，边写边拷会得到半截数据库 |
| 部署前备份保留 20 份 | `/data/backup/db-*-predeploy.sqlite` |

已用真实 git 仓库验证过：init、切到旧标签、回退，`data/db.sqlite` 内容全程不变。

---

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `git fetch` 卡住或超时 | 拉的是 GitHub，国内线路差 | 换 Gitee 源，或配代理 |
| `Permission denied (publickey)` | Deploy Key 没配对，或 remote 用的还是 https | `git remote -v` 看地址；重配 ssh config |
| `工作区有未提交的本地修改` | 服务器上手动改过文件 | 确认要丢弃加 `--force`；想保留就先 `git diff` 存下来 |
| `服务 xxx 未注册` | 没跑过 setup.sh，或 `SVC` 名字不对 | `systemctl list-units \| grep -i typing` 确认真实名字，用 `SVC=真名` |
| 部署完页面没变 | 浏览器缓存了老 JS | `Ctrl + F5` 强刷 |
| `--rollback` 报「没有可回退的目标」 | 部署历史里只有当前这一个版本 | 用 `--rollback <sha>` 指定 |
| 回滚后还是打不开 | 问题不在代码（Nginx/端口/防火墙） | `journalctl -u 服务名 -n 50`，再按 `MANUAL.md` 的三层验证查 |
| 依赖装不上 | 网络或 npm 源问题 | `cd /data/web/typing-trainer && npm install --omit=dev` 手动看报错 |

---

## 附：从零到上线的完整顺序

```bash
# ① 本地：把代码推上 GitHub（已完成，仓库在 github.com/jiashiqing/typing-trainer）
git add -A && git status                    # 确认没有 data/
git commit -m "初始版本"
git tag -a v1.0 -m "首个线上版本"
git push -u origin main --tags

# ② 全新服务器：先 clone（私有仓库要先配第 4 节的 Deploy Key）
mkdir -p /data/web && cd /data/web
git clone git@github.com:jiashiqing/typing-trainer.git typing-trainer
cd typing-trainer

# ③ 首次部署（装 Node、建账号、写 systemd、配 Nginx、开端口）
#    原地部署：APP_DIR 设为当前目录，不拷贝、不动 data/
sudo -E APP_DIR="$(pwd)" WEB_PORT=8090 bash deploy/setup.sh

# ④ 以后每次更新：本地 push → 服务器拉
#   本地：git push origin main --tags
sudo bash deploy/pull-deploy.sh
```

> 服务器上**已经有旧代码**（不是全新机器）时，跳过 ② 的 clone，改用 5.1—5.4 的 `--init` 流程，避免数据库被覆盖。
