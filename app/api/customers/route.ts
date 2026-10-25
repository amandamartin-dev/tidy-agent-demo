import { requirePermission } from "@/lib/require-permission";
import { authErrorResponse, AuthError } from "@/lib/auth-error";
import { json } from "@/lib/api";
import { listCustomers } from "@/lib/store";
export async function GET(request: Request) {
  try {
    await requirePermission("customers:read", request);
    const days = Number(new URL(request.url).searchParams.get("inactiveDays") ?? 0);
    if (!Number.isInteger(days) || days < 0 || days > 36500)
      throw new AuthError(400, "inactiveDays must be an integer from 0 to 36500.");
    return json(listCustomers(days));
  } catch (error) {
    return authErrorResponse(error);
  }
}
