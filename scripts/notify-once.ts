import { loadEnvConfig } from "@next/env";
import { closeDatabase, db } from "../src/lib/db";
import { notificationLog } from "../src/lib/db/schema";
import { desc } from "drizzle-orm";
import { runNotifications } from "../src/lib/notifications/runner";
loadEnvConfig(process.cwd());
async function main() {
  // 此入口始终强制演练，即使 .env 已配真实应用凭据也不向任何人发消息。
  try {
    const raw = process.argv.find((s) => s.startsWith("--at="))?.slice(5);
    const now = raw ? new Date(raw) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("--at 需要有效 ISO 时间（带时区）");
    console.log("通知演练", now.toISOString(), await runNotifications({ now, dryRun: true }));
    const rows = await db().select().from(notificationLog).orderBy(desc(notificationLog.createdAt)).limit(50);
    console.table(rows.map((r) => ({ type: r.type, object: r.objectId, recipient: r.recipient, mode: r.mode, status: r.status, window: r.window, attempts: r.attempts })));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await closeDatabase(); }
}
void main();
