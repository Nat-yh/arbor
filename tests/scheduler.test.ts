import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn() }));
vi.mock("node:fs/promises", async (load) => ({
  ...await load<typeof import("node:fs/promises")>(),
  readFile: fake.read,
}));
vi.mock("../src/lib/notifications/runner", () => ({ runNotifications: fake.run }));
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules();
  delete (globalThis as { arborScheduler?: unknown }).arborScheduler;
});
it("register 仅nodejs和开关启用时启动，热更新不重复启动，失败后下一轮继续", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-06T01:29:00Z"));
  fake.run.mockReset().mockRejectedValueOnce(new Error("数据库暂不可用")).mockResolvedValue({});
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { register } = await import("../src/instrumentation");
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("RUN_SCHEDULER", "false");
  await register(); await vi.advanceTimersByTimeAsync(0); expect(fake.run).not.toHaveBeenCalled();
  vi.stubEnv("RUN_SCHEDULER", "true"); vi.stubEnv("NEXT_RUNTIME", "edge");
  await register(); await vi.advanceTimersByTimeAsync(0); expect(fake.run).not.toHaveBeenCalled();
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NEXT_PHASE", "phase-production-build");
  await register(); await vi.advanceTimersByTimeAsync(0); expect(fake.run).not.toHaveBeenCalled();
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  await register(); await register(); await vi.advanceTimersByTimeAsync(0);
  expect(fake.run).toHaveBeenCalledTimes(1); expect(logged).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fake.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.run.mock.calls).toEqual([[], [{ directOnly: true }]]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fake.run.mock.calls.filter((args) => !args.length)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(fake.run.mock.calls.filter((args) => !args.length)).toHaveLength(3);
});


it("候选镜像等待自己的启用令牌，旧令牌不能触发通知", async () => {
  fake.read.mockResolvedValue("previous-image\n");
  fake.run.mockReset().mockResolvedValue({});
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.stubEnv("RUN_SCHEDULER", "true");
  vi.stubEnv("ARBOR_SCHEDULER_GATE", "/run/arbor-activation/active");
  vi.stubEnv("ARBOR_SCHEDULER_TOKEN", "candidate-image");
  vi.useFakeTimers();
  const { register } = await import("../src/instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(1500);
  expect(fake.run).not.toHaveBeenCalled();
  fake.read.mockResolvedValue("candidate-image\n");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.run).toHaveBeenCalledTimes(1);
});
