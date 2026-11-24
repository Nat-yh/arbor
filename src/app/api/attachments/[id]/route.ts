import { eq } from "drizzle-orm";
import { requireAccount } from "@/lib/auth";
import { attachmentHeaders, canAccessAttachment } from "@/lib/attachments";
import { CommandError } from "@/lib/commands";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { loadState } from "@/lib/db/state";
import { apiError, sessionToken } from "@/lib/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const token = await sessionToken();
    await requireAccount(token);
    const { id } = await context.params;
    return await db().transaction(async (tx) => {
      const acc = await requireAccount(token, tx);
      const state = await loadState(tx);
      const meta = state.attachments?.find((a) => a.id === id);
      if (!meta || !canAccessAttachment(state.items, meta, acc)) throw new CommandError("附件不存在或无访问权限", 404);
      const [file] = await tx.select().from(attachments).where(eq(attachments.id, id));
      if (!file) throw new CommandError("附件不存在或无访问权限", 404);
      return new Response(new Uint8Array(file.content), { headers: attachmentHeaders(file) });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch (error) { return apiError(error); }
}
