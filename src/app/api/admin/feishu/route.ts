import { requireAccount } from "@/lib/auth";
import { apiError, checkOrigin, json, sessionToken } from "@/lib/http";
import { notificationStatus, testNotification } from "@/lib/notifications/admin";
export async function GET() {
  try { return json(await notificationStatus(await requireAccount(await sessionToken()))); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const outcome = await testNotification(await requireAccount(await sessionToken()));
    return json(outcome, outcome.status === "failed" ? 502 : 200);
  } catch (error) { return apiError(error); }
}
