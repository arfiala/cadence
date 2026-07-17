// ZwiftPower configuration, read from env only (ISC-120). Zwift credentials
// never live in git, the DB, or logs, this module reads them from the
// process environment and nowhere else. The single source of truth for
// "is ZwiftPower connected" is isZwiftPowerConfigured(): when it returns
// false the whole feature is dormant (ISC-131), no scheduler, no errors,
// and the UI shows a not-configured panel.

import { dirname } from "node:path";

export type ZwiftPowerConfig = {
  username: string;
  password: string;
  profileId: string;
};

// True only when BOTH Zwift SSO credentials are present and non-empty. The
// profile id is optional at this gate (getConfig enforces it) because the
// dormancy decision hinges on whether the operator connected an account at
// all, which is exactly ZWIFT_USERNAME + ZWIFT_PASSWORD.
export function isZwiftPowerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const user = env.ZWIFT_USERNAME;
  const pass = env.ZWIFT_PASSWORD;
  return (
    typeof user === "string" &&
    user.length > 0 &&
    typeof pass === "string" &&
    pass.length > 0
  );
}

// Resolve the full config or throw a clear, non-secret error. Never logs the
// credential values themselves.
export function getZwiftPowerConfig(env: NodeJS.ProcessEnv = process.env): ZwiftPowerConfig {
  const username = env.ZWIFT_USERNAME ?? "";
  const password = env.ZWIFT_PASSWORD ?? "";
  const profileId = env.ZWIFT_PROFILE_ID ?? "";
  if (username.length === 0 || password.length === 0) {
    throw new Error(
      "ZWIFT_USERNAME / ZWIFT_PASSWORD are not set. ZwiftPower sync is disabled until they are configured in the box .env.",
    );
  }
  if (profileId.length === 0) {
    throw new Error(
      "ZWIFT_PROFILE_ID is not set. Set it to your numeric ZwiftPower profile id (the number in your ZwiftPower profile URL) so results can be fetched.",
    );
  }
  return { username, password, profileId };
}

// Where the persisted ZwiftPower session cookies are written (ISC-130), mode
// 600. A *.json value is treated as the cookie FILE itself; anything else is
// treated as a directory and a session.json is placed inside it. Default keeps
// it beside the Garmin token dir for a consistent on-box layout.
export function zwiftCookiePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZWIFT_COOKIE_PATH ?? "./zwiftpower-tokens/session.json";
}

export function zwiftCookieDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(zwiftCookiePath(env));
}
