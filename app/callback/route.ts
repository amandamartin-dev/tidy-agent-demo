import { handleAuth, refreshSession } from "@workos-inc/authkit-nextjs";
import { requiredEnv } from "@/lib/workos";

// Must match the sign-in methods enabled in the WorkOS dashboard. The hosted AuthKit page shows
// only those; this rejects anything else on the server too.
const allowedMethods = ["GoogleOAuth"];

export const GET = handleAuth({
  returnPathname: "/",
  onSuccess: async ({ authenticationMethod, organizationId }) => {
    if (!authenticationMethod || !allowedMethods.includes(authenticationMethod))
      throw new Error("Use Google to sign in to this demo.");
    // Social login authenticates the user. WorkOS separately verifies their
    // membership when selecting the demo workspace; never invent org claims.
    if (organizationId !== requiredEnv("WORKOS_ORGANIZATION_ID")) {
      try {
        await refreshSession({ organizationId: requiredEnv("WORKOS_ORGANIZATION_ID") });
      } catch {
        throw new Error("This account does not have access to the demo workspace.");
      }
    }
  },
  // A plain Response, not Response.redirect(): AuthKit adds cache headers to what onError
  // returns, and Response.redirect() headers are immutable.
  onError: () =>
    new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/?authError=signin", requiredEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI")).href,
      },
    }),
});
