#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode="${1:-local}"
case "$mode" in
  local) local_auth=true; demo=false ;;
  demo) local_auth=false; demo=true ;;
  *) printf '%s\n' '用法: sh scripts/setup-compose.sh [local|demo]' >&2; exit 1 ;;
esac
if [ -e .env ] || [ -L .env ]; then
  printf '%s\n' '已存在 .env，请检查现有部署配置。' >&2
  exit 1
fi

port="${APP_PORT:-3000}"
case "$port" in
  ''|*[!0-9]*) printf '%s\n' 'APP_PORT 必须是有效端口号。' >&2; exit 1 ;;
esac
if ! [ "$port" -ge 1 ] || ! [ "$port" -le 65535 ]; then
  printf '%s\n' 'APP_PORT 必须在 1 到 65535 之间。' >&2
  exit 1
fi

db_password="$(openssl rand -hex 32)"
setup_token=
if [ "$local_auth" = true ]; then setup_token="$(openssl rand -hex 32)"; fi
umask 077
draft="$(mktemp .env.arbor.XXXXXXXX)"
trap 'rm -f "$draft"' EXIT
cat > "$draft" <<CONFIG
APP_BIND_HOST=127.0.0.1
APP_PORT=$port
APP_BASE_URL=http://localhost:$port
POSTGRES_DB=arbor
POSTGRES_USER=arbor
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://arbor:$db_password@db:5432/arbor
LOCAL_AUTH_ENABLED=$local_auth
LOCAL_AUTH_SETUP_TOKEN=$setup_token
DEMO_MODE=$demo
RUN_SCHEDULER=false
FEISHU_APP_ID=
FEISHU_APP_SECRET=
GITHUB_WEBHOOK_SECRET=
GITLAB_WEBHOOK_SECRET=
GITEE_WEBHOOK_SECRET=
GITEA_WEBHOOK_SECRET=
CONFIG
ln "$draft" .env
printf '%s\n' "已生成 .env。运行 docker compose up --build -d 后访问 http://localhost:$port"
if [ "$local_auth" = true ]; then
  printf '%s\n' '首位管理员在登录页输入 .env 中的 LOCAL_AUTH_SETUP_TOKEN。'
fi
