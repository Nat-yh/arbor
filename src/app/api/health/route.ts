import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export async function GET() {
  await connection();
  try {
    await db().execute(sql`select 1`);
    return json({ ok: true, database: "connected" });
  } catch { return json({ ok: false, database: "unavailable" }, 503); }
}
