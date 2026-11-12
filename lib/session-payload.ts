import { decrypt } from "@/lib/crypto";
import { driveFileScope } from "@/ai/google-auth";
import type { UserDoc } from "@/lib/models";

/** What the browser is told about the signed-in user. Never includes tokens. */
export type Session =
  | { authenticated: false }
  | {
      authenticated: true;
      user: { name: string; email: string; picture: string | null };
      sheet: { url: string; title: string; generated: boolean } | null;
      /** True once Excela has created a planner for this user. It can then only be reset, never created again. */
      hasGeneratedPlanner: boolean;
      googleAccess: boolean;
      hasApiKey: boolean;
      telegram?: {
        connected: boolean;
        username?: string;
        firstName?: string;
        linkedAt?: string;
      };
    };

export function sessionPayload(user: UserDoc): Session {
  return {
    authenticated: true,
    user: { name: user.name, email: user.email, picture: user.picture },
    sheet: user.sheetId && user.sheetUrl
      ? { url: user.sheetUrl, title: user.sheetTitle ?? "Planner", generated: user.generatedSheetId === user.sheetId }
      : null,
    hasGeneratedPlanner: Boolean(user.generatedSheetId),
    hasApiKey: true,
    googleAccess: Boolean(user.googleScopes?.includes(driveFileScope) && user.refreshToken && decrypt(user.refreshToken)),
    telegram: user.telegram
      ? {
          connected: true,
          username: user.telegram.username,
          firstName: user.telegram.firstName,
          linkedAt: user.telegram.linkedAt ? new Date(user.telegram.linkedAt).toISOString() : undefined,
        }
      : { connected: false },
  };
}
