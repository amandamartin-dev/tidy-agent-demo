import type { Metadata } from "next";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { demo } from "@/demo.config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${demo.productName} · Agent Auth demo`,
  description: demo.audience,
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Seed the provider from the server so it skips its on-mount server action. The access token
  // stays on the server. https://github.com/workos/authkit-nextjs#optimizing-with-server-side-auth-data
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omitted on purpose, per the AuthKit README
  const { accessToken, ...initialAuth } = await withAuth();
  return (
    <html lang="en">
      <body>
        <AuthKitProvider initialAuth={initialAuth}>{children}</AuthKitProvider>
      </body>
    </html>
  );
}
