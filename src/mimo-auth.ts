/** Xiaomi MiMo browser authorization — an X25519 + AES-256-GCM API-key
 *  provisioning flow (not OAuth); mirrors XiaomiMiMo/MiMo-Code. */

import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { type Server, createServer } from "node:http";
import { errorPage, successPage } from "./oauth-shared.js";

const MIMO_PLATFORM_DEFAULT = "https://platform.xiaomimimo.com";
/** X25519 SubjectPublicKeyInfo DER prefix (algorithm id + 32-byte key). */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** The app identity the official CLI sends; third-party use needs an approved id. */
const MIMO_APP_KEY_NAME = "mimocode";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export function mimoPlatform(): string {
  const v = process.env.MIMO_PLATFORM_URL?.trim();
  return (v || MIMO_PLATFORM_DEFAULT).replace(/\/+$/, "");
}

export interface MiMoBrowserCredential {
  /** Issued inference API key. */
  apiKey: string;
  /** Account identifier. */
  uid: string;
  /** Optional base URL the flow returns — honor it over the regional default. */
  baseUrl?: string;
}

/** Decrypt the `?u=` callback payload: [32-byte ephemeral pubkey][12-byte
 *  nonce][ciphertext][16-byte GCM tag]. Exposed for tests. */
export function decryptMiMoCredential(
  privateKeyDer: Buffer,
  encoded: string,
): MiMoBrowserCredential {
  const data = Buffer.from(encoded, "base64url");
  if (data.length < 32 + 12 + 16) throw new Error("Invalid MiMo callback payload");
  const peerKeyBytes = data.subarray(0, 32);
  const nonce = data.subarray(32, 44);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(44, data.length - 16);
  const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const peerPublicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, peerKeyBytes]),
    format: "der",
    type: "spki",
  });
  const secret = diffieHellman({ privateKey, publicKey: peerPublicKey });
  const aesKey = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("MiMo callback decryption failed (bad key or tampered payload)");
  }
  let result: { sk?: unknown; uid?: unknown; url?: unknown };
  try {
    result = JSON.parse(plaintext.toString("utf8")) as typeof result;
  } catch {
    throw new Error("MiMo callback payload was not valid JSON");
  }
  if (typeof result.sk !== "string" || !result.sk || typeof result.uid !== "string") {
    throw new Error("MiMo did not return a valid API key");
  }
  return {
    apiKey: result.sk,
    uid: result.uid,
    baseUrl: typeof result.url === "string" && result.url ? result.url : undefined,
  };
}

export interface MiMoLoginFlow {
  /** Authorize URL to open in the system browser. */
  url: string;
  /** Resolves with the issued credential; rejects on error / cancel / timeout. */
  done: Promise<MiMoBrowserCredential>;
  cancel: () => void;
}

/** Start the provisioning flow: an ephemeral X25519 key pair plus a one-shot
 *  localhost callback server, then the platform authorize URL. */
export async function beginMiMoLoginFlow(
  opts: { timeoutMs?: number; keyName?: string; platform?: string } = {},
): Promise<MiMoLoginFlow> {
  const platform = (opts.platform ?? mimoPlatform()).replace(/\/+$/, "");
  const keyPair = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const publicKey = Buffer.from(keyPair.publicKey).toString("base64url");
  const keyName = opts.keyName ?? `reasonix-${randomBytes(8).toString("hex")}`;
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (c: MiMoBrowserCredential) => void = () => {};
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<MiMoBrowserCredential>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
    // Close idle keep-alive sockets only; let any in-flight success page flush.
    server.closeIdleConnections();
    server.close(() => {});
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/") {
      res.writeHead(404).end("Not found");
      return;
    }
    const encrypted = url.searchParams.get("u");
    if (!encrypted) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage("Missing credential in the Xiaomi callback."));
      settle(() => rejectDone(new Error("MiMo callback carried no credential")));
      return;
    }
    try {
      const credential = decryptMiMoCredential(keyPair.privateKey, encrypted);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(successPage("Signed in", "Signed in to Xiaomi MiMo"));
      settle(() => resolveDone(credential));
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage((err as Error).message));
      settle(() => rejectDone(err as Error));
    }
  });
  server.on("error", () => {
    /* surfaced via the listen promise below */
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("MiMo callback server failed to bind");
  const redirectUri = `http://localhost:${addr.port}/`;

  const authorize = new URL("/authorize", platform);
  authorize.searchParams.set("pk", publicKey);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("kn", MIMO_APP_KEY_NAME);
  authorize.searchParams.set("key_name", keyName);

  timer = setTimeout(() => {
    settle(() => rejectDone(new Error("MiMo sign-in timed out — retry from settings")));
  }, timeoutMs);

  return {
    url: authorize.toString(),
    done,
    cancel: () => settle(() => rejectDone(new Error("MiMo sign-in cancelled"))),
  };
}
