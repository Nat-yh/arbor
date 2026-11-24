import { existsSync } from "node:fs";
// Vitest 使用 NODE_ENV=test；本地显式数据库验收仍读取用户配置的开发连接。
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: { include: ["tests/postgres.integration.ts"], environment: "node", testTimeout: 20000, hookTimeout: 20000, fileParallelism: false } });
