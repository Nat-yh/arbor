#!/usr/bin/env bash
set -euo pipefail
api_base="${1:-http://localhost:3001}"
verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' EXIT
member_cookie="$verify_dir/member.cookies"
guest_cookie="$verify_dir/guest.cookies"
response="$verify_dir/response.json"

call() {
  local expected="$1" method="$2" route="$3" cookie="$4" body="${5-}" status
  if [ -z "$body" ]; then body='{}'; fi
  if [ "$method" = GET ]; then
    status="$(curl -sS --max-time 15 -b "$cookie" -c "$cookie" -o "$response" -w '%{http_code}' "$api_base$route")"
  else
    status="$(curl -sS --max-time 15 -b "$cookie" -c "$cookie" -H 'Content-Type: application/json' -d "$body" -o "$response" -w '%{http_code}' "$api_base$route")"
  fi
  if [ "$status" != "$expected" ]; then
    echo "FAIL $method $route: expected $expected, got $status" >&2
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("reason",d.get("error","无错误摘要")))' "$response" >&2
    exit 1
  fi
  echo "PASS $method $route -> $status"
}

call 401 GET /api/state "$member_cookie"
call 401 POST /api/commands "$member_cookie" '{"type":"postUpdate","id":"T2b","text":"unauthenticated"}'
call 200 GET /api/health "$member_cookie"
call 200 POST /api/auth/demo "$member_cookie" '{"id":"zhouhang"}'
call 200 GET /api/state "$member_cookie"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["me"]=="zhouhang"; assert any(x["id"]=="T2b" for x in d["items"])' "$response"
verification_text="接口验收 $(date -u +%Y%m%dT%H%M%SZ)"
command_body="$(python3 -c 'import json,sys; print(json.dumps({"type":"postUpdate","id":"T2b","text":sys.argv[1]}))' "$verification_text")"
call 200 POST /api/commands "$member_cookie" "$command_body"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["result"]["ok"]' "$response"
call 200 GET /api/state "$member_cookie"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); x=next(x for x in d["items"] if x["id"]=="T2b"); assert any(u["text"]==sys.argv[2] for u in x["updates"])' "$response" "$verification_text"
echo 'PASS 命令写入后重新读取，留言仍存在'
call 200 POST /api/auth/demo "$guest_cookie" '{"id":"guest"}'
call 403 POST /api/commands "$guest_cookie" '{"type":"addItem","item":{"parentId":null,"kind":"project","title":"forbidden","owner":"guest","due":"2099-12-31"}}'
call 403 POST /api/commands "$guest_cookie" '{"type":"setStatus","id":"T2b","status":"doing"}'
call 403 POST /api/commands "$guest_cookie" '{"type":"setRule","id":"stale","patch":{"n":1}}'
call 200 POST /api/auth/logout "$member_cookie" '{}'
call 401 GET /api/state "$member_cookie"
call 200 POST /api/auth/logout "$guest_cookie" '{}'
echo '接口冒烟通过'
