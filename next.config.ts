import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  // Load the Gemini SDK from node_modules at runtime instead of bundling it (server-only, Node APIs).
  serverExternalPackages: ["@google/genai"],
};

export default nextConfig;
