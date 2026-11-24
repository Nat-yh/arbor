#!/bin/sh
set -eu

if [ "${SKIP_MIGRATE:-false}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATE=true; database migration skipped."
else
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "[entrypoint] ERROR: DATABASE_URL is required for database migration." >&2
    exit 1
  fi
  if [ ! -f scripts/migrate.mjs ]; then
    echo "[entrypoint] ERROR: scripts/migrate.mjs is missing from the image." >&2
    exit 1
  fi

  attempt=1
  max_attempts=10
  while :; do
    echo "[entrypoint] Waiting for database (${attempt}/${max_attempts})..."
    if node --input-type=module <<'NODE'
import postgres from 'postgres';

// Bound the entire probe, including a stalled connection or query.
const deadline = setTimeout(() => {
  console.error('[entrypoint] Database readiness probe timed out.');
  process.exit(1);
}, 10000);
let sql;
try {
  sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
  await sql`select 1`;
} catch {
  // Do not print the connection URL or credentials in readiness logs.
  console.error('[entrypoint] Database is not ready; check connectivity and credentials.');
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 1 });
  clearTimeout(deadline);
}
NODE
    then
      break
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[entrypoint] ERROR: Database unavailable after ${max_attempts} attempts; server will not start." >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 3
  done

  echo "[entrypoint] Database ready; applying migrations."
  if node scripts/migrate.mjs; then
    echo "[entrypoint] Database migration completed."
  else
    echo "[entrypoint] ERROR: Database migration failed; server will not start. Inspect the migration error above." >&2
    exit 1
  fi
fi

echo "[entrypoint] Starting Arbor."
exec node server.js
