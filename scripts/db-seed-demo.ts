import { loadEnvConfig } from "@next/env";
async function main() {
  loadEnvConfig(process.cwd());
  const { withWriteLock } = await import("../src/lib/db/state");
  const { seedDemo } = await import("../src/lib/db/seed");
  const { closeDatabase } = await import("../src/lib/db");
  try {
    if (process.env.DEMO_MODE !== "true") throw new Error("仅 DEMO_MODE=true 时允许写入示例数据");
    await withWriteLock((tx) => seedDemo(tx));
    console.log("演示数据已写入（日期相对今天）");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "种子写入失败"); process.exitCode = 1;
  } finally { await closeDatabase(); }
}
main().catch(() => { console.error("演示种子执行失败"); process.exitCode = 1; });
