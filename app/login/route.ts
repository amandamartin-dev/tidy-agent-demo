import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { tidy } from "@/config/tidy";

// The documented AuthKit sign-in route. The hosted page offers the sign-in methods enabled in the
// WorkOS dashboard (Google only, for this demo); the callback also rejects any other method.
// maxAge forwards OIDC max_age, so a stale sign-in must re-authenticate before minting an agent.
// https://github.com/workos/authkit-nextjs/blob/v4.5.0/README.md#initiate-login-uri
export async function GET() {
  return redirect(await getSignInUrl({ maxAge: tidy.sessionTtlSeconds }));
}
