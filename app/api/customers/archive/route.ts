import { requirePermission } from "@/lib/require-permission";
import { authErrorResponse, AuthError } from "@/lib/auth-error";
import { body, customerIds, json, mutationOrigin } from "@/lib/api";
import { changeCustomers } from "@/lib/store";
export async function POST(request: Request) {
  try {
    mutationOrigin(request);
    const actor = await requirePermission("customers:archive", request);
    const result = changeCustomers(customerIds(await body(request)), "archive", actor);
    if (!result) throw new AuthError(400, "Unknown customer ID. No rows changed.");
    return json(result);
  } catch (error) {
    return authErrorResponse(error);
  }
}
