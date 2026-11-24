# Arbor Docker 部署

## 适用条件

服务器使用 Linux x64（amd64）或 arm64，安装 Docker 24+、Docker Compose v2 及 Buildx。建议至少 1 核 CPU、2 GB 内存；构建时可能需要更多内存，可在独立构建机生成镜像。为数据库、镜像和备份预留磁盘空间。跨架构构建需要 Buildx 节点原生支持目标架构，或配置 QEMU 模拟。

Dockerfile 按 deps、builder、runner 分阶段构建，各阶段均使用目标平台的 `node:22-alpine`，不复制宿主机 node_modules。runner 额外执行 `npm ci --omit=dev --ignore-scripts`，安装 lockfile 锁定的完整生产依赖，确保迁移模块不受 standalone 文件追踪遗漏影响。安装脚本在 runner 中禁用，Next 构建所需的原生产物由 builder 的 standalone 输出提供；新增依赖若要求安装脚本，须重新检查此策略。运行用户为 UID 1001，`.next` 可写，系统安装 tzdata。

## 首次部署

在已有的 Arbor 仓库目录运行，先切换到你要部署的版本。

```sh
sh scripts/setup-compose.sh local
```

编辑生成的 `.env`，按部署需要调整以下参数。保留脚本生成的数据库密码和首次管理员初始化码。正式环境 `DEMO_MODE` 必须为 `false`。飞书和仓库集成按需配置。

```dotenv
APP_IMAGE=arbor:2026.11.06-1
APP_BIND_HOST=127.0.0.1
APP_PORT=3000
APP_BASE_URL=https://arbor.example.com
APP_TIMEZONE=Asia/Shanghai
TZ=Asia/Shanghai
DEMO_MODE=false
RUN_SCHEDULER=false
POSTGRES_DB=arbor
POSTGRES_USER=arbor
# POSTGRES_PASSWORD 和 DATABASE_URL 保留脚本生成的值。
LOCAL_AUTH_ENABLED=true
# LOCAL_AUTH_SETUP_TOKEN 保留脚本生成的值，管理员初始化成功后可移除。
FEISHU_APP_ID=
FEISHU_APP_SECRET=
GITHUB_WEBHOOK_SECRET=
GITLAB_WEBHOOK_SECRET=
GITEE_WEBHOOK_SECRET=
GITEA_WEBHOOK_SECRET=
```

`DATABASE_URL` 中的用户名、密码须与 db 配置相同，密码含 URL 特殊字符时须百分号编码。容器内数据库主机名为 `db`，不能写 `localhost`。Compose 的 `.env` 读取会插值 `$`，包含字面量 `$` 的值请按 Compose 规则使用单引号，并在部署前校验配置。不要把 `.env` 放入镜像或提交仓库。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
curl --fail http://127.0.0.1:3000/api/health
```

配置反向代理后访问 `APP_BASE_URL`。app 默认只绑定服务器回环地址，可经 Nginx 或 SSH 隧道访问。如需直接从内网访问，把 `APP_BIND_HOST` 设为服务器内网 IP，并同步调整防火墙；端口由 `APP_PORT` 控制。db 不映射宿主机端口，数据保存在 Compose 管理的 `postgres_data` 命名卷中。保持部署目录和 Compose 项目名稳定，否则可能创建另一个空数据库卷。

国内构建可在 `.env` 中补充 `NPM_REGISTRY=https://registry.npmmirror.com`，或执行 `docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com app` 后运行 `docker compose up -d`。此参数只改变 npm 源，Docker 基础镜像及 Alpine 软件包源另行由服务器配置。

本地账号部署用 `openssl rand -hex 32` 生成 `LOCAL_AUTH_SETUP_TOKEN`，填写到 `.env` 后启动应用。管理员在登录页输入初始化码创建账号，随后从成员设置生成邀请。只使用飞书的部署将 `LOCAL_AUTH_ENABLED` 设为 `false`，填写飞书凭证，并让指定管理员先登录。

### 启动与环境变量

| 变量 | 用途与约束 |
| --- | --- |
| `DATABASE_URL` | 必填 PostgreSQL 连接串；迁移和业务使用同一数据库 |
| `APP_BASE_URL` | 必填，对外访问的完整 HTTPS 地址；与飞书回调一致 |
| `APP_TIMEZONE` | 业务时区，默认 `Asia/Shanghai` |
| `TZ` | 容器系统时区，默认 `Asia/Shanghai`；建议与业务时区一致 |
| `DEMO_MODE` | 正式环境必须为 `false` |
| `LOCAL_AUTH_ENABLED`、`LOCAL_AUTH_SETUP_TOKEN` | 启用本地账号，初始化码仅供空账号库创建首位管理员 |
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 飞书自建应用凭据 |
| `GITHUB_WEBHOOK_SECRET`、`GITLAB_WEBHOOK_SECRET`、`GITEE_WEBHOOK_SECRET`、`GITEA_WEBHOOK_SECRET` | 按所用平台填写独立的 Webhook 凭证 |
| `RUN_SCHEDULER` | 默认关闭，只有精确 `true` 才启动。同库多实例使用 PostgreSQL advisory lock 互斥 |
| `SKIP_MIGRATE` | 默认 `false`；仅在已单独成功执行同版本迁移时设为 `true` |

启动时先做 `select 1` 就绪探测，最多 10 次，每次上限 10 秒，间隔 3 秒。数据库可用后执行一次 `node scripts/migrate.mjs`，成功才 `exec node server.js`。就绪超限或迁移失败，当前进程退出。Compose 的 `unless-stopped` 会重启退出的容器，因此迁移持续失败时应先 `docker compose stop app`，排查后再启动，不要让其长期循环失败。迁移本身的事务、幂等和锁策略由业务脚本负责。

本配置只部署一个 app。扩容前先设计数据库迁移串行执行方案；通知调度已使用数据库 advisory lock 串行运行，多个实例可开启 `RUN_SCHEDULER=true`，但迁移仍须独立串行执行；还需核对 Next 多实例缓存、Server Actions 密钥与版本一致性。不能直接复制当前 app 来扩容。

### 外部数据库

编辑服务器上的 Compose 配置，移除 `app.depends_on` 和 `db` 服务，保留 app 的 `env_file`，把 `.env` 中 `DATABASE_URL` 改成外部 PostgreSQL 地址并按服务商要求配置 TLS、网络与账号权限。此时可删除未使用的 `postgres_data` 声明，`POSTGRES_*` 条目也不再使用。入口脚本仍会等待数据库并迁移。切换前先备份、验证目标库和数据迁入结果；下方 db 容器备份命令需换成外部数据库客户端或服务商备份方案。

## 在本地构建并交付镜像

本节命令由负责人在业务合并并验收后执行。

### 多平台镜像仓库

使用不可覆盖的版本 tag。先登录私有镜像仓库，再构建 amd64 与 arm64：

```sh
docker login registry.example.com
docker buildx create --name arbor-builder --driver docker-container --use
docker buildx inspect --bootstrap
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t registry.example.com/team/arbor:2026.11.06-1 --push .
```

已有可用 builder 时可直接使用。服务器仍需部署 `docker-compose.yml` 和 `.env`，将 `APP_IMAGE` 设为对应完整镜像 tag，然后：

```sh
docker compose pull app db
docker compose up -d --no-build
```

Docker 会按服务器架构选择镜像。较旧的本地镜像存储不能直接加载多平台镜像，仓库方式使用 `--push`。参见 [Docker 多平台构建说明](https://docs.docker.com/build/building/multi-platform/)。

### 离线传输

按目标服务器选择单一平台，下面以 x64 为例（arm64 改为 `linux/arm64` 并更换 tag/文件名）：

```sh
docker buildx build --platform linux/amd64 --load -t arbor:2026.11.06-1-amd64 .
docker pull --platform linux/amd64 postgres:16-alpine
docker save -o arbor-2026.11.06-1-amd64.tar arbor:2026.11.06-1-amd64 postgres:16-alpine
scp arbor-2026.11.06-1-amd64.tar ops@example.com:~/arbor/
```

服务器准备好 Compose 文件及 `.env`，设置 `APP_IMAGE=arbor:2026.11.06-1-amd64`：

```sh
cd ~/arbor
docker load -i arbor-2026.11.06-1-amd64.tar
docker compose up -d --no-build --pull never
```

离线包包含 db 镜像，避免服务器启动时再联网拉取。不要使用 `--load` 假定一次导入两个平台，离线交付分别制作目标平台镜像包。`docker save` 只保存镜像，不包含数据库卷；数据库须单独备份。参见 [Docker 镜像导出说明](https://docs.docker.com/reference/cli/docker/image/save/)。

## Nginx 与 HTTPS

以下示例在宿主机运行 Nginx，以 `arbor.example.com` 为域名，替换证书路径和允许访问的真实内网/VPN 网段。80 端口仅重定向到 HTTPS；443 的站点页面只允许内网，四个平台的 Webhook 路径向公网开放。若 Nginx 也在容器内，把 upstream 改为同一 Docker 网络内的 `app:3000`，不要使用其自身的回环地址。

```nginx
upstream arbor_app {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name arbor.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name arbor.example.com;
    ssl_certificate /etc/nginx/certs/arbor.fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/arbor.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 20m;
    proxy_connect_timeout 10s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_set_header Connection "";
    # 保留 Next cacheComponents / partial rendering 所需的流式响应。
    proxy_buffering off;

    location ~ ^/api/webhooks/(gitea|github|gitlab|gitee)$ {
        allow all;
        limit_except POST { deny all; }
        proxy_pass http://arbor_app;
    }

    location / {
        allow 127.0.0.1;
        allow 198.51.100.0/24; # 示例网段，替换为允许访问的网段
        deny all;
        proxy_pass http://arbor_app;
    }
}
```

请求体和自定义 WebHook 签名 header 默认继续传给上游，不重写请求体，不记录密钥。示例未启用代理缓存，登录页面和 API 不应统一做公共缓存。缓冲设置与转发 header 参见 [Nginx proxy 模块说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。配置证书及规则后，执行 `nginx -t`，通过再 reload。

防火墙需允许公网请求到达 443，由 Nginx 区分路径；不能只允许内网访问 443 却期望公网 WebHook 可达。业务用户需接入内网/VPN，浏览器才能完成登录回调。若前面还有 CDN、负载均衡或其他代理，须按其可信出口配置真实 IP，避免把代理 IP 当成所有用户的来源，也不要直接信任任意传入的转发 header。

## 飞书与代码仓库配置

在飞书开放平台创建企业自建应用，将 App ID、App Secret 写入 `.env`，配置应用可用范围并发布。网页授权重定向地址须精确填写 `${APP_BASE_URL}/api/auth/feishu/callback`，例如 `https://arbor.example.com/api/auth/feishu/callback`，协议、域名、端口及路径须与实际访问一致。

按实际登录流程申请所需的身份认证和用户信息权限；若业务版本需要访问其他飞书资源，再申请对应权限。具体权限名称、审批和发布要求以飞书开放平台当前配置页及业务接口清单为准。若启用服务端出口 IP 白名单，应填写服务器或 NAT 的固定公网出口 IP，并为更换出口预留更新流程；不要把 Docker 内网 IP 填入公网出口白名单。先用指定管理员验证授权、回调和管理员身份，再扩大可用范围。

### 代码仓库

在「系统设置 → 代码仓库」选择平台并复制 Webhook 地址，部署时配好所用平台的凭证：

| 平台 | 路径 | 环境变量与凭证 | 可同步事件 |
| --- | --- | --- | --- |
| GitHub | `/api/webhooks/github` | `GITHUB_WEBHOOK_SECRET`，Webhook Secret | Pull Request、评审、评论、提交状态和 Check Run |
| GitLab | `/api/webhooks/gitlab` | `GITLAB_WEBHOOK_SECRET`，Signing token（`whsec_`）或旧版 Secret token | Merge Request、评论和 Pipeline |
| Gitee | `/api/webhooks/gitee` | `GITEE_WEBHOOK_SECRET`，Webhook 密码 | Pull Request 和评论 |
| Gitea | `/api/webhooks/gitea` | `GITEA_WEBHOOK_SECRET`，Webhook Secret | Pull Request、评审、评论和提交状态 |

为每个平台使用不同的凭证，并启用 HTTPS 证书校验。项目绑定时先选平台，再填仓库地址或命名空间与仓库名。GitLab 支持嵌套命名空间。

在 Gitea 仓库进入「设置 → Webhooks → 添加 Webhook」，选择 **Gitea** 类型，目标地址填写 `${APP_BASE_URL}/api/webhooks/gitea`，内容类型选 `application/json`，Secret 与 Arbor 的 `GITEA_WEBHOOK_SECRET` 相同。订阅 Pull Request、Pull Request Review（approved/rejected/comment）、Issue Comment、Commit Status。使用独立随机密钥，启用 HTTPS 证书校验，保存后测试投递。

自托管 Gitea 若禁止访问内网地址，在其出站请求设置中允许 Arbor 接收地址。Gitea 与 Arbor 在同一网络时，可以只向 Gitea 开放该 Webhook 路径。

签名按原始请求体计算 HMAC-SHA256，接受 `X-Gitea-Signature` 或 `X-Hub-Signature-256`；缺少密钥或签名会拒绝请求。事件事务落库，优先按 `X-Gitea-Delivery` 去重，没有投递编号时按事件头和原始请求体去重。载荷字段依据 [Gitea 官方文档](https://docs.gitea.com/usage/repository/webhooks/) 编写，需通过保存的原始载荷核对团队 Gitea 版本，尤其是审查事件头、`review.type` 和提交状态字段。

## 升级与回滚

升级前备份数据库、保留旧镜像 tag 及配置，在隔离 PostgreSQL 16 环境验证完整迁移链、重复执行和失败恢复，再验收启动、健康接口、登录与受影响业务。不要用演示库代替生产升级验证。

源码构建方式先检出已验收版本，将 `.env` 的 `APP_IMAGE` 改为新 tag 后执行：

```sh
docker compose stop app
docker compose build app
docker compose up -d --no-deps app
docker compose ps
docker compose logs --tail=100 app
curl --fail http://127.0.0.1:3000/api/health
```

镜像仓库交付方式先更新 `APP_IMAGE` 并 `docker compose pull app`，再停止旧 app，执行 `docker compose up -d --no-build --no-deps app`；离线方式先 `docker load`。保持 db 运行，停止旧 app 可避免两个调度器重叠执行。升级会有短暂停机，应安排窗口。健康接口通过后还须验证登录及业务数据，不能只凭容器启动判断升级成功。

回滚应用时，将 `APP_IMAGE` 改回保留的旧 tag：

```sh
docker compose stop app
docker compose up -d --no-build --no-deps app
```

回滚镜像不会回滚数据库。先确认旧代码和旧迁移脚本可兼容已升级结构；不兼容时，选择向前修复，或在停机并明确接受备份后数据损失的条件下恢复升级前备份。不要自动执行破坏性 downgrade，也不要通过 `SKIP_MIGRATE=true` 掩盖迁移失败。

## 备份与恢复

在部署目录操作。下面使用 PostgreSQL custom 格式，备份文件落在宿主机，不依赖容器生命周期：

```sh
mkdir -p backups
chmod 700 backups
backup_file="backups/arbor-$(date +%Y%m%d-%H%M%S).dump"
(umask 077; docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_file")
```

确认命令退出码为 0、文件非空，再复制到独立存储。失败产生的空文件或不完整文件不能当作可恢复备份。建议每天定时备份，结合可接受数据损失窗口调整频率；配置保留周期、加密异地副本和失败告警，并定期实际演练恢复。定时任务使用部署目录绝对路径执行上面的命令，不在命令行明文写数据库密码。

优先恢复到一个新建的空数据库（确保有足够磁盘空间），先停止 app 避免写入：

```sh
docker compose stop app
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" arbor_restore'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d arbor_restore --no-owner --no-privileges --exit-on-error' < backups/arbor-YYYYMMDD-HHMMSS.dump
```

确认恢复成功后，将 `.env` 中 `DATABASE_URL` 的库名改为 `arbor_restore`，同时设置 `POSTGRES_DB=arbor_restore` 让后续健康检查与备份指向该库，再执行 `docker compose up -d --no-build` 使 app 和 db 的环境配置生效。此时 `POSTGRES_DB` 不会自动迁移已有卷，目标库已由 `createdb` 创建。启动前确认所选镜像与备份结构兼容，验收登录及数据。若目标库名已存在，换一个新名字；不要直接删除旧库。

`.env` 和外部凭据另行安全备份。命名卷不是备份；`docker compose down` 通常保留卷，`docker compose down -v` 会删除数据库卷，日常维护不要使用。

## 日志与常见问题

```sh
docker compose ps
docker compose logs -f --tail=200 app db
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q app)"
docker compose exec app sh -c 'id; date; wget -S -O /dev/null http://127.0.0.1:3000/api/health'
```

- 时区不一致：检查 `APP_TIMEZONE` 和 `TZ`，默认均为 `Asia/Shanghai`；另核对数据库字段的时间存储语义与页面显示，不靠修改已有数据补偿时差。
- 迁移失败：先停止 app，保存日志，核对 `DATABASE_URL`、账号 DDL 权限、迁移链及失败后的部分执行状态。修复并在隔离环境验证后再启动。出现模块找不到时确认两个数据库包在生产 dependencies 中，且迁移脚本没有引用 devDependencies 或未复制的源码。
- 数据库长期未就绪：查看 db 日志及磁盘空间；已初始化卷不会因为修改 `POSTGRES_PASSWORD` 自动修改数据库密码，须按数据库账号变更流程处理。
- 健康检查失败：先看是否仍在迁移，再检查 3000 监听和无登录的 `/api/health`。镜像探测使用 wget，启动宽限 180 秒；长迁移按实测调整。Docker 标记 unhealthy 本身不会触发 `unless-stopped` 重启，进程退出才会触发。
- 飞书回调地址不一致：核对 `APP_BASE_URL`、开放平台重定向地址、用户访问地址以及 Nginx 转发的 Host/Proto；内网站点还需确认用户 VPN 能访问回调域名。
- Gitea 投递 403/超时：核对精确路径的公网例外规则、防火墙、DNS、TLS 和业务签名校验；不要为排障关闭密钥校验。
- 页面内容延迟整块出现：检查 Nginx 以及前置代理是否关闭响应缓冲，并保留 Next 的缓存与响应 header。

## 部署后检查

部署后检查健康接口和实际登录方式。本地账号部署应完成首次管理员初始化，并用邀请链接注册一个成员。接入飞书或代码仓库后，分别用自己的应用和仓库验证登录或 Webhook 投递。启用调度时检查发送记录，并在独立环境验证备份恢复。

## 自动提醒与演练

升级到第 2 阶段前备份数据库并执行完整迁移链，新增 `notification_log` 表；项目群 ID 保存在 `work_items.data.feishuChatId`，原 `feishuGroup` 继续作显示名，不回填、不覆盖原数据。迁移失败会阻断 Docker 应用启动。该表和 JSON 字段为增量新增，代码回退可保留数据。

启用应用机器人，授权 `im:message:send_as_bot`，发布应用并配置可用范围。用户需首次飞书登录取得当前应用的 open_id；项目负责人或管理员在项目详情绑定 `oc_` 开头的 chat_id，机器人必须在群内。管理员可在系统设置的「飞书接入」查看绑定及最近 50 条记录，测试按钮仅向当前管理员本人发送。未配置任一应用凭证时自动进入演练模式，只写记录、不请求飞书；APP_BASE_URL 仍须配置以生成卡片链接。演练与正式记录分开去重。

`RUN_SCHEDULER=true` 通过 Node.js instrumentation 启动检查，启动时执行一轮，此后对齐每 5 分钟。按 APP_TIMEZONE 计算 20:00 至次日 09:00 免打扰、周末仅 urgent；urgent 也遵守夜间免打扰。事件规则、阈值、渠道和开关从 rules 表读取。同规则、事项、接收人成功发送后滚动 24 小时去重，同轮同接收人合并。延迟事件落库并在发送前重新核对规则和事项，已解决或规则关闭则取消；未绑定 open_id 的正式通知记失败，绑定后后续轮次重试。

工作日 09:30 个人待办摘要、周五 17:00 项目群周报，短暂故障可在当天目标时刻后至 20:00 前补发，不补发往日摘要/周报。失败按 5 分钟重试；批次保存卡片和 uuid，未变化的批次复用 uuid。飞书侧 uuid 去重时效需在真实应用核对；跨远端成功与本地落库的网络故障无法提供严格 exactly-once 保证。重复失败可在发送日志查看，不阻断其他接收人或 HTTP 服务。

手动执行始终为演练，不受真实凭证影响，不要求 RUN_SCHEDULER 开启：

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/arbor npm run db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/arbor npm run notify:once
# 指定业务时间可验证触发窗口，不改变数据库已有工作项和规则：
DATABASE_URL=postgres://postgres:postgres@localhost:5432/arbor npm run notify:once -- --at=2026-11-06T17:00:00+08:00
```

生产使用长期运行的 Node/Docker 进程。Serverless 休眠、进程全部退出时不执行定时任务；需保持至少一个实例存活。notification_log 不自动清理，部署方应按审计要求制定保留策略；删除近期成功或待发送记录会影响去重/补发。卡片仅提供跳转链接，未实现直接修改事项的回调。

接口和卡片依据：[tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[按钮](https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interactive-components/button)。需在真实环境核验权限、可用范围、群成员资格、卡片展示及深链接登录。
