import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  logging: { incomingRequests: { ignore: [/^\/auth\//, /connect=/] } },
  agentRules: false,
  devIndicators: false,
  serverExternalPackages: ["yaml"],
};
export default config;
