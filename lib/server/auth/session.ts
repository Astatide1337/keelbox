import { randomUUID } from "node:crypto";
import {
  aiEnabled,
  developmentProfile,
  type Profile,
  type Principal,
} from "./identity";
const global = globalThis as typeof globalThis & {
  waypointProfile?: {
    profile: Profile | null;
    epoch: string;
    listeners: Set<() => void>;
  };
};
const state = (global.waypointProfile ??= {
  profile: null,
  epoch: randomUUID(),
  listeners: new Set(),
});
export function profileState() {
  return {
    profile: aiEnabled() ? state.profile : developmentProfile,
    epoch: aiEnabled() ? state.epoch : "development",
  };
}
export function activateProfile(profile: Profile | null) {
  state.profile = profile;
  state.epoch = randomUUID();
  for (const cancel of state.listeners) cancel();
  return profileState();
}
export function requirePrincipal(request: Request): Principal {
  const s = profileState();
  if (!s.profile)
    throw Error("Continue with ChatGPT before saving account-owned projects.");
  if (
    aiEnabled() &&
    (request.headers.get("x-waypoint-profile") !== s.profile.key ||
      request.headers.get("x-waypoint-epoch") !== s.epoch)
  )
    throw Error(
      "Account changed. Reconnect this view; your draft has been retained.",
    );
  return { profile: s.profile, epoch: s.epoch };
}
export function assertPrincipal(p: Principal) {
  const s = profileState();
  if (s.profile?.key !== p.profile.key || s.epoch !== p.epoch)
    throw Error(
      "Account changed. This operation was not committed to the new profile.",
    );
}
export function onProfileChange(cancel: () => void) {
  state.listeners.add(cancel);
  return () => {
    state.listeners.delete(cancel);
  };
}
