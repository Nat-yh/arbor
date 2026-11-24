import { apiError, checkOrigin, json, sessionToken } from "@/lib/http";
import { issueMemberInvitation, requireLocalAuth } from "@/lib/local-auth";

export async function POST(request: Request) {
  try {
    requireLocalAuth();
    checkOrigin(request);
    return json(await issueMemberInvitation(await sessionToken()), 201);
  } catch (error) { return apiError(error); }
}
