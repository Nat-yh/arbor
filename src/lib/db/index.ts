import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// 延迟连接：构建镜像时不要求数据库可用；连接池跨开发热更新复用。
const globalDb = globalThis as unknown as { arborDb?: ReturnType<typeof connect> };
function connect() {
  if (!process.env.DATABASE_URL) throw new Error("未配置 DATABASE_URL");
  const client = postgres(process.env.DATABASE_URL, { max: 5, idle_timeout: 20, connect_timeout: 5, prepare: false });
  return drizzle(client, { schema });
}
export function db() { return globalDb.arborDb ??= connect(); }
export async function closeDatabase() {
  if (globalDb.arborDb) await globalDb.arborDb.$client.end({ timeout: 5 });
  globalDb.arborDb = undefined;
}
export type Database = ReturnType<typeof db>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
