/** The OpenCode Console session for this process only. Tokens are never written to
 *  disk, so no account identity outlives the run that signed in. */

export interface OpencodeOAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** ms epoch — Console access tokens are short-lived and refreshed from refreshToken. */
  expiresAt: number;
  /** Account email from the Console `/api/user` endpoint, shown masked in settings. */
  account?: string;
  /** Active Console organization id, sent as `x-opencode-org-id` on inference. */
  orgId?: string;
  /** Active Console organization display name. */
  orgName?: string;
  /** Console server origin the tokens were issued by (defaults to opencode.ai/console). */
  server?: string;
}

let session: OpencodeOAuthCreds | undefined;
let epoch = 0;

export function opencodeOAuthSession(): OpencodeOAuthCreds | undefined {
  return session;
}

/** Bumped on every store and clear, so work that outlives the session it started
 *  under can tell that it is stale. */
export function opencodeSessionEpoch(): number {
  return epoch;
}

/** Store a session. Pass the epoch a refresh started under: a refresh that settles
 *  after sign-out is dropped instead of resurrecting the cleared session. */
export function rememberOpencodeOAuth(creds: OpencodeOAuthCreds, expectedEpoch?: number): boolean {
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) return false;
  session = creds;
  epoch += 1;
  return true;
}

export function forgetOpencodeOAuth(): void {
  session = undefined;
  epoch += 1;
}
