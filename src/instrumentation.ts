export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.RUN_SCHEDULER === "true" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startScheduler } = await import("./lib/notifications/scheduler");
    startScheduler();
  }
}
