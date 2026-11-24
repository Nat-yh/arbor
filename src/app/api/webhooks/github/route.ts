import { handleRepoWebhook } from "@/lib/repo-webhook-server";

export function POST(request: Request) {
  return handleRepoWebhook("github", request);
}
