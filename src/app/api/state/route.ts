import { connection } from "next/server";
import { requireAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadState } from "@/lib/db/state";
import { apiError, json, sessionToken } from "@/lib/http";
import { clientState } from "@/lib/server-state";

export async function GET() {
  await connection();
  try {
    const token = await sessionToken();
    await requireAccount(token);
    return await db().transaction(async (tx) => {
      const acc = await requireAccount(token, tx);
      return json(clientState(await loadState(tx), acc.id));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch (error) { return apiError(error); }
}
