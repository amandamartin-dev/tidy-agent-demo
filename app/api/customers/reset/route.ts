import { requirePermission } from "@/lib/require-permission";
import { authErrorResponse, AuthError } from "@/lib/auth-error";
import { json, mutationOrigin } from "@/lib/api";
import { assertNoRunningAgent } from "@/lib/demo-sessions";
import { resetCustomers } from "@/lib/store";
export async function POST(request: Request) {
  try {
    mutationOrigin(request);
    const actor = await requirePermission("customers:delete", request);
    if (actor.kind !== "human")
      throw new AuthError(403, "Only the human Customer Data Manager can reset demo data.");
    assertNoRunningAgent();
    return json(resetCustomers());
  } catch (error) {
    return authErrorResponse(error);
  }
}
