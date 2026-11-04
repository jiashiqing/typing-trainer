# 部署到腾讯云轻量应用服务器

这套系统原本是**一间机房一台教师机**的设计：数据不出校、学生端不需要密码。
搬到公网服务器上能用，但有几件事必须先讲清楚，否则会出事。

## 两个脚本，分工不同

| 脚本 | 什么时候用 | 干什么 |
|---|---|---|
| `setup.sh` | **首次**上服务器 | 装 Node、建账号、写 systemd、配 Nginx、开端口 |
| `pull-deploy.sh` | 以后**每次更新** | 从 git 拉代码、装依赖、重启、探活、失败自动回滚 |

用 Git 管理代码、从仓库拉取部署的完整步骤（含 GitHub / Gitee 选择、部署密钥、回滚三种情况）
见 **[README-git.md](README-git.md)**。

---

## 一、先说风险

| 问题 | 后果 | 怎么解决 |
|---|---|---|
| **学生端没有身份验证** | 学校+班级+姓名就是全部凭据。公网上任何人知道名字就能冒充学生交成绩、看他人的榜单 | 整站加一层网页口令（`MODE=basic`），或者只允许学校出口 IP 访问（`ipallow`） |
| **`/screen` 大屏完全公开** | 会显示全校学生**真实姓名 + 班级 + 成绩**，任何人打开链接都能看 | 同上，必须挡在 Nginx 这一层 |
| **默认访问码是 `admin888`** | 公网上几分钟就会被扫到 | 部署后第一件事：登录教师端改掉 |
| **没有 HTTPS 就是明文** | 访问码、学生姓名、成绩在网络上裸传 | 配域名 + Let's Encrypt（脚本自动做） |
| **API 原来允许任意跨域** | 别人做个网页就能读走你的数据 | 已在代码里改掉（默认只允许同源） |

> 学生姓名属于个人信息。真要在公网上跑，建议跟学校/教体局报备一声，把访问范围限在必要的人。

**如果只是想让服务稳定运行、不想被教师机关机打断**，其实有更省事的做法：
把云服务器和教室放在同一个虚拟局域网（ZeroTier / frp），服务只监听内网。
那样等于把机房搬到云上，上面这些风险全都不存在。这套部署包也能跑，只是 `MODE=ipallow` 且白名单写内网段。

---

## 二、选服务器

| 项 | 建议 |
|---|---|
| 镜像 | **Ubuntu 22.04 LTS**（脚本主路径；Rocky/Alma 8+ 也支持） |
| 配置 | **2 核 2 G** 起。1 核 1 G 也能跑，但几百人同时挂实时连接会吃紧 |
| 带宽 | 3 Mbps 起。榜单压缩后约 91 KB，够用 |
| 系统盘 | 40 G 足够（数据库 5000 人 30 万条成绩约 200 MB） |
| 防火墙 | 腾讯云控制台放行 **22 / 80 / 443**（注意：轻量服务器的防火墙是独立的一层，和系统里的 ufw 不是一回事，**两边都要放行**） |

**不要选 CentOS 7**：它的 glibc 太旧（2.17），跑不了 Node 22。脚本会直接拦下来。

---

## 三、上传代码

在 Windows 本地，进入项目的**上一级目录**执行（PowerShell 或 CMD 都行）：

```powershell
tar -czf typing-trainer.tar.gz --exclude="_edgetmp*" --exclude="预览截图" "打字练习系统-联网版"
```

> `_edgetmp*` 是截图探针的浏览器缓存，有 1 GB 多，别传。

传到服务器：

```powershell
scp typing-trainer.tar.gz root@你的公网IP:/tmp/
```

在服务器上解开：

```bash
cd /tmp
tar -xzf typing-trainer.tar.gz
cd 打字练习系统-联网版
```

**要不要带 `data/db.sqlite`？**
- 想保留现在的 6 所学校、26 个班级 → 一起打包传上去，脚本不会覆盖它
- 想从空白开始 → 打包时加 `--exclude="打字练习系统-联网版/data"`

---

## 四、一键部署

### 情况 A：有域名（推荐）

先把这个域名解析到服务器 IP（A 记录），等生效后再执行：

```bash
cd /tmp/打字练习系统-联网版
sudo EMAIL=你的邮箱@qq.com bash deploy/setup.sh 你的域名.com
```

脚本会：装 Node 22 → 建账号 → 拷代码 → 配 Nginx → 起 systemd → 申请 HTTPS 证书 → 切到加固配置。

跑完打开 `https://你的域名.com` 就能用。

### 情况 B：只有 IP

```bash
cd /tmp/打字练习系统-联网版
sudo bash deploy/setup.sh
```

默认走 HTTP + 网页口令，结束时会在屏幕上打印口令（形如 `typing / Kx7pQ2mN9a`）。**把这行记下来**，脚本不存明文。

---

## 五、访问控制怎么选

部署时用 `MODE` 环境变量控制：

```bash
# ① 整站口令（默认，最通用）
sudo MODE=basic WEB_USER=typing WEB_PASS=自己定个密码 bash deploy/setup.sh 你的域名.com
```

学生会先看到一个浏览器弹窗，输一次口令，之后浏览器会记住。机房电脑**每台只需要输一次**。

```bash
# ② 只允许学校出口 IP（最安全，学生完全无感）
sudo MODE=ipallow ALLOW_CIDR="203.0.113.0/24" bash deploy/setup.sh 你的域名.com
```

前提是学校有**固定公网 IP**。如果是拨号宽带、IP 天天变，用不了这个。

```bash
# ③ 不设限（不推荐）
sudo MODE=open bash deploy/setup.sh 你的域名.com
```

---

## 六、验证清单

部署完按顺序过一遍：

```bash
# 1. 服务在跑
systemctl status typing-trainer

# 2. 内部探针通
curl -s http://127.0.0.1:8090/api/ping

# 3. 外部能打开（应该先要口令，再看到登录页）
curl -I https://你的域名.com/

# 4. 端口 8090 没有暴露到公网（应该连接被拒或超时）
curl -m 3 http://你的公网IP:8090/api/ping
```

第 4 步如果通了，说明 `BIND_HOST` 没生效，赶紧检查 systemd 里的环境变量。

再用浏览器过一遍：

- [ ] 学生端能进、能选学校班级、能练、成绩能上榜
- [ ] 教师端访问码能登进去
- [ ] **大屏能实时刷**（这是最容易出问题的一环，见下面排错）
- [ ] 教师端改访问码能保存

---

## 七、日常运维

```bash
# 状态 / 重启 / 日志
systemctl status  typing-trainer
systemctl restart typing-trainer
journalctl -u typing-trainer -f

# 改配置（端口、公网地址等）
sudo systemctl edit --full typing-trainer
sudo systemctl daemon-reload && sudo systemctl restart typing-trainer
```

### 备份

数据全在 `/opt/typing-trainer/data/db.sqlite`。**不要直接 cp**（WAL 模式下可能拷到半个事务），用自带的备份接口：

```bash
sudo ADMIN_CODE=你的超管访问码 bash /opt/typing-trainer/deploy/backup.sh
```

设成每天自动跑：

```bash
sudo crontab -e
# 加一行（每天 19:00，保留 14 天）
0 19 * * * ADMIN_CODE=你的超管访问码 /opt/typing-trainer/deploy/backup.sh >> /var/log/typing-backup.log 2>&1
```

备份落在 `/var/backups/typing-trainer/`。建议再定期下载一份到本地。

### 升级代码

本地改完后重新打包上传，然后：

```bash
cd /tmp && tar -xzf typing-trainer.tar.gz && cd 打字练习系统-联网版
sudo bash deploy/setup.sh 你的域名.com     # 会保留 data/，不会覆盖数据库
```

---

## 八、排错

**大屏不刷新 / 教师端进度墙不动**

99% 是 Nginx 把 SSE 缓冲打开了。检查 `/etc/nginx/conf.d/typing-trainer.conf` 里 `/api/stream` 那段有没有：

```nginx
proxy_buffering off;
proxy_read_timeout 24h;
```

改完 `nginx -t && systemctl reload nginx`。另外腾讯云控制台的安全组不会缓存，不用管。

**`502 Bad Gateway`**

服务没起来或端口对不上：

```bash
systemctl status typing-trainer
journalctl -u typing-trainer -n 50
ss -lntp | grep 8090
```

**登录后一刷新就掉**

检查 HTTPS 是否生效。`sessionStorage` 是按源隔离的，`http` 和 `https` 是两个源。

**学生手机连不上，但教师机可以**

- 域名解析对不对：`nslookup 你的域名.com`
- 腾讯云防火墙 80/443 放行了吗
- 学校网络有没有屏蔽：换 4G 试一次

**证书没申请下来**

```bash
certbot --nginx -d 你的域名.com
```

大多是域名没解析到这台机器，或者 80 端口被挡。申请成功后重新跑一次 `setup.sh` 会把配置切到加固版。

**内存不够（服务被 OOM 杀掉）**

```bash
free -h                                  # 看还剩多少
journalctl -u typing-trainer | grep -i kill
```

每个实时连接约占 40 KB，500 人 ≈ 20 MB，其实很省。真不够就加 swap：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 九、部署包里的文件

```
deploy/
├── setup.sh                 一键部署（安装 + Nginx + systemd + 证书）
├── backup.sh                每日备份（走 /api/backup，运行中也能导出一致副本）
├── typing-trainer.service   systemd 单元模板
├── nginx-http.conf          Nginx 模板（无域名 / 证书申请前）
└── nginx-https.conf         Nginx 模板（有域名，含 HSTS 与安全头）
```

服务端支持的环境变量（都在 systemd 单元里配）：

| 变量 | 作用 |
|---|---|
| `PUBLIC_URL` | 公网地址，决定二维码和提示里显示什么。**不设更安全**：服务端会用访问者实际的 Host 推导；设成内网 IP 会让二维码指向学生连不上的地址 |
| `BIND_HOST` | 监听地址，默认 `0.0.0.0`；公网部署设 `127.0.0.1` |
| `PORT` | 端口，默认 8090 |
| `CORS_ORIGIN` | 留空 = 只允许同源；要跨域才填具体域名 |
| `HIDE_CODES` | `1` = 日志里不打印访问码（公网必须设） |
| `ENABLE_SHUTDOWN` | `0` = 关掉 HTTP 停止接口（公网必须设） |
| `NO_OPEN` | `1` = 启动时不自动开浏览器 |
