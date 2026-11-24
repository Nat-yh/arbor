import { Suspense } from "react";
import { connection } from "next/server";
import { Logo } from "@/components/Logo";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { localAuthEnabled } from "@/lib/auth-config";
import { demoAccounts, seedDemo } from "@/lib/db/seed";
import { withWriteLock } from "@/lib/db/state";
import { feishuConfigured } from "@/lib/feishu/oauth";
import { demoMode } from "@/lib/server-state";
import LoginForm from "./LoginForm";
import LocalLogin from "./LocalLogin";
import "./login.css";

export default function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-5 py-8">
      <div className="arbor-login-shell relative isolate grid w-full max-w-sm overflow-hidden rounded-2xl md:min-h-[25rem] md:max-w-[51rem] md:grid-cols-[1.05fr_1fr]">
        <div aria-hidden="true" className="arbor-login-watermark pointer-events-none absolute hidden md:block">
          <Logo markOnly className="arbor-login-imprint h-auto w-full" />
          <Logo markOnly className="arbor-login-glint absolute inset-0 h-auto w-full" />
        </div>
        <div className="relative grid place-items-center bg-surface px-8 py-11 md:col-start-2 md:px-10">
          <div className="w-full max-w-[17rem]">
            <header>
              <Logo size={36} />
              <h1 className="mt-5 text-[2.625rem] leading-none font-semibold tracking-[-0.055em]">{APP_NAME}</h1>
              <p className="arbor-login-subtitle mt-2.5 text-sm">{APP_TAGLINE}</p>
            </header>
            <Suspense fallback={<div role="status" aria-label="正在加载登录选项" className="mt-7 h-12 rounded-lg bg-sunken" />}>
              <Login searchParams={searchParams} />
            </Suspense>
          </div>
        </div>
      </div>
    </main>
  );
}
async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await connection();
  const demo = demoMode();
  const local = localAuthEnabled();
  const feishu = feishuConfigured();
  let choices: { id: string; name: string }[] = [];
  let configError = "";
  if (demo) {
    try {
      let rows = await demoAccounts();
      // 容器的独立演示库首次访问时自动初始化。
      if (!rows.length) {
        rows = await withWriteLock(async (tx) => {
          const existing = await demoAccounts(tx);
          if (existing.length) return existing;
          await seedDemo(tx);
          return demoAccounts(tx);
        });
      }
      choices = rows.filter((a) => a.active).map(({ id, name }) => ({ id, name }));
      if (!choices.length) configError = "演示数据写入失败，请查看服务日志。";
    } catch { configError = "演示模式需要已迁移的独立演示数据库，请检查配置。"; }
  }
  if (!local && !demo && !feishu) configError = "请管理员启用本地账号登录或配置飞书登录。";
  const error = (await searchParams).error ?? configError;
  return (
    <>
      <LoginForm demo={demo} configured={feishu} choices={choices} error={error} />
      {local && <LocalLogin afterFeishu={feishu} />}
    </>
  );
}
