/** MiMo browser-authorization adapter: crypto + localhost-callback flow. The
 *  "encrypt" helper stands in for Xiaomi's X25519 + AES-256-GCM provisioning. */

import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { beginMiMoLoginFlow, decryptMiMoCredential } from "../src/mimo-auth.js";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Encrypt a credential for the flow identified by its base64url SPKI public key. */
function encryptForFlow(pkBase64url: string, credential: object): string {
  const spki = Buffer.from(pkBase64url, "base64url");
  const flowPublicRaw = spki.subarray(spki.length - 32); // trailing 32 bytes = raw key
  const flowPublic = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, flowPublicRaw]),
    format: "der",
    type: "spki",
  });
  const ephemeral = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const privateKey = createPrivateKey({
    key: ephemeral.privateKey,
    format: "der",
    type: "pkcs8",
  });
  const secret = diffieHellman({ privateKey, publicKey: flowPublic });
  const aesKey = createHash("sha256").update(secret).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const ephemeralPublic = Buffer.from(ephemeral.publicKey);
  const ephemeralPublicRaw = ephemeralPublic.subarray(ephemeralPublic.length - 32);
  return Buffer.concat([ephemeralPublicRaw, nonce, ciphertext, tag]).toString("base64url");
}

function flowKeyPair() {
  return generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
}

describe("decryptMiMoCredential", () => {
  it("round-trips a credential through X25519 + AES-256-GCM", () => {
    const flow = flowKeyPair();
    const pk = Buffer.from(flow.publicKey).toString("base64url");
    const encoded = encryptForFlow(pk, {
      sk: "sk-mimo-123",
      uid: "user-1",
      url: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
    expect(decryptMiMoCredential(flow.privateKey, encoded)).toEqual({
      apiKey: "sk-mimo-123",
      uid: "user-1",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
  });

  it("omits baseUrl when the flow does not return one", () => {
    const flow = flowKeyPair();
    const pk = Buffer.from(flow.publicKey).toString("base64url");
    const encoded = encryptForFlow(pk, { sk: "sk-x", uid: "u" });
    expect(decryptMiMoCredential(flow.privateKey, encoded)).toEqual({ apiKey: "sk-x", uid: "u" });
  });

  it("rejects a malformed (short) payload", () => {
    const flow = flowKeyPair();
    expect(() => decryptMiMoCredential(flow.privateKey, "AAAA")).toThrow(
      /Invalid MiMo callback payload/,
    );
  });

  it("rejects a payload that decrypts but carries no key", () => {
    const flow = flowKeyPair();
    const pk = Buffer.from(flow.publicKey).toString("base64url");
    const encoded = encryptForFlow(pk, { uid: "u" });
    expect(() => decryptMiMoCredential(flow.privateKey, encoded)).toThrow(
      /did not return a valid API key/,
    );
  });
});

describe("beginMiMoLoginFlow", () => {
  it("builds the documented authorize URL and resolves the key from the callback", async () => {
    const flow = await beginMiMoLoginFlow({
      platform: "https://platform.xiaomimimo.com",
      keyName: "reasonix-test",
    });
    try {
      const url = new URL(flow.url);
      expect(url.origin).toBe("https://platform.xiaomimimo.com");
      expect(url.pathname).toBe("/authorize");
      expect(url.searchParams.get("kn")).toBe("mimocode");
      expect(url.searchParams.get("key_name")).toBe("reasonix-test");
      const pk = url.searchParams.get("pk");
      const redirectUri = url.searchParams.get("redirect_uri");
      expect(pk).toBeTruthy();
      expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/$/);

      const encoded = encryptForFlow(pk as string, { sk: "sk-issued", uid: "acct-9" });
      const cb = await fetch(`${redirectUri}?u=${encodeURIComponent(encoded)}`);
      expect(cb.status).toBe(200);
      const cred = await flow.done;
      expect(cred.apiKey).toBe("sk-issued");
      expect(cred.uid).toBe("acct-9");
    } finally {
      flow.cancel();
    }
  });

  it("rejects on cancel", async () => {
    const flow = await beginMiMoLoginFlow({ platform: "https://platform.xiaomimimo.com" });
    flow.cancel();
    await expect(flow.done).rejects.toThrow(/cancelled/);
  });
});
