import { authkitProxy } from "@workos-inc/authkit-nextjs";

// AuthKit manages the human session. Customer permissions belong in requirePermission.
export default authkitProxy();

export const config = {
  matcher: ["/", "/login", "/callback", "/api/:path*"],
};
