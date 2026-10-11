import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingExcludes: {"/*": ["./tests/**/*", "./.git/**/*", "./.env*", "./*.kubeconfig", "./credentials*.json"]},
  logging: { incomingRequests: { ignore: [/^\/auth\//, /connect=/] } },
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ["yaml"],
};
export default config;
