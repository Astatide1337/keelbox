import { createHash } from "node:crypto";
import { z } from "zod";
export const issuer = "https://auth.openai.com";
export type Profile =
  | { kind: "development"; key: "development"; label: string }
  | {
      kind: "chatgpt";
      key: string;
      issuer: string;
      subject: string;
      clientId: string;
      label: string;
    };
export type Principal = { profile: Profile; epoch: string };
export const credentialSchema = z.object({
  issuer: z.literal(issuer),
  client_id: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  email: z.string().max(500),
  label: z.string().max(700),
  access_token: z.string(),
  refresh_token: z.string(),
  id_token: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.number().finite(),
  ext_agent_host_id: z.string().startsWith("urn:uuid:"),
  welcomed: z.boolean().default(false),
});
export type Credential = z.infer<typeof credentialSchema>;
export function profileFor(
  c: Pick<Credential, "issuer" | "client_id" | "subject" | "label">,
): Profile {
  return {
    kind: "chatgpt",
    key: createHash("sha256")
      .update(JSON.stringify([c.issuer, c.subject, c.client_id]))
      .digest("hex"),
    issuer: c.issuer,
    subject: c.subject,
    clientId: c.client_id,
    label: c.label,
  };
}
export const developmentProfile: Profile = {
  kind: "development",
  key: "development",
  label: "Local development",
};
export function aiEnabled() {
  return process.env.PLAYGROUND_AI_ENABLED === "1";
}
export function storageAllowed() {
  return aiEnabled() && process.env.PLAYGROUND_ALLOW_CREDENTIAL_STORAGE === "1";
}
