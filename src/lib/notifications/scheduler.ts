import { readFile } from "node:fs/promises";
import { runNotifications } from "./runner";

const directInterval = 30_000;
const reminderInterval = 300_000;
const runtime = globalThis as unknown as { arborScheduler?: { timer?: NodeJS.Timeout; running: boolean } };
export function startScheduler() {
  if (runtime.arborScheduler || process.env.RUN_SCHEDULER !== "true") return;
  const gate = process.env.ARBOR_SCHEDULER_GATE;
  const token = process.env.ARBOR_SCHEDULER_TOKEN;
  const state = runtime.arborScheduler = { running: false } as { timer?: NodeJS.Timeout; running: boolean };
  let nextReminder = 0;
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    let waitingForActivation = false;
    try {
      if (gate) {
        const active = await readFile(gate, "utf8").catch(() => "");
        if (!token || active.trim() !== token) {
          waitingForActivation = true;
          return;
        }
      }
      const now = Date.now();
      if (now >= nextReminder) {
        nextReminder = now + reminderInterval - now % reminderInterval;
        await runNotifications();
      } else {
        await runNotifications({ directOnly: true });
      }
    }
    catch (error) { console.error("Arbor 调度检查失败，下轮重试", error instanceof Error ? error.message : "未知错误"); }
    finally {
      state.running = false;
      state.timer = setTimeout(tick, waitingForActivation ? 1000 : directInterval - Date.now() % directInterval);
      state.timer.unref();
    }
  };
  // register 不等待数据库或外部网络；错误不阻断 HTTP 服务启动。
  state.timer = setTimeout(tick, 0);
  state.timer.unref();
}
