import { z } from "zod";
import { CommandError } from "../commands";

// 飞书官方文档：获取授权码 / 换取 user_access_token / 获取登录用户信息。
// https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3
// https://open.feishu.cn/document/common-capabilities/sso/api/get-user-info
export const FEISHU_ENDPOINTS = {
  authorize: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  token: "https://accounts.feishu.cn/oauth/v3/token",
  userInfo: "https://open.feishu.cn/open-apis/authen/v1/user_info",
} as const;
export const feishuConfigured = () => !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.APP_BASE_URL);
export function feishuConfig() {
  if (!feishuConfigured()) throw new CommandError("请配置 FEISHU_APP_ID、FEISHU_APP_SECRET 和 APP_BASE_URL", 503);
  return { appId: process.env.FEISHU_APP_ID!, secret: process.env.FEISHU_APP_SECRET!, redirectUri: new URL("/api/auth/feishu/callback", process.env.APP_BASE_URL!).href };
}
export function authorizationUrl(state: string) {
  const config = feishuConfig();
  const url = new URL(FEISHU_ENDPOINTS.authorize);
  url.search = new URLSearchParams({ client_id: config.appId, redirect_uri: config.redirectUri, response_type: "code", state }).toString();
  return url.href;
}
const identitySchema = z.object({ open_id: z.string().min(1), union_id: z.string().min(1).optional(), name: z.string().min(1), avatar_url: z.string().optional() });
export type FeishuIdentity = z.infer<typeof identitySchema>;

export async function exchangeCode(code: string): Promise<FeishuIdentity> {
  const config = feishuConfig();
  const res = await fetch(FEISHU_ENDPOINTS.token, {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ grant_type: "authorization_code", client_id: config.appId, client_secret: config.secret, code, redirect_uri: config.redirectUri }),
  });
  const token = await res.json();
  if (!res.ok || token.code !== 0 || typeof token.access_token !== "string") throw new CommandError("飞书授权码换取凭证失败，请重新登录", 502);
  const user = await fetch(FEISHU_ENDPOINTS.userInfo, { headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  const profile = await user.json();
  const identity = identitySchema.safeParse(profile.data);
  if (!user.ok || profile.code !== 0 || !identity.success) throw new CommandError("获取飞书用户信息失败，请检查应用授权范围", 502);
  return identity.data;
}
