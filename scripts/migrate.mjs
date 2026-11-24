import nextEnv from "@next/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

nextEnv.loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error("请配置 DATABASE_URL");
const client = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
try {
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log("数据库迁移完成");
} catch (error) {
  console.error("数据库迁移失败：", error instanceof Error ? error.message : "未知错误");
  if (error?.cause?.code) console.error("数据库错误代码：", error.cause.code);
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
