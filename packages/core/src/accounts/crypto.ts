const encoder = new TextEncoder();

const hmacKey = (pepper: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const message = (purpose: string, value: string) => encoder.encode(`vencloud:${purpose}:${value}`);

const sign = async (pepper: string, purpose: string, value: string): Promise<string> => {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(pepper),
    message(purpose, value),
  );
  return new Uint8Array(signature).toHex();
};

export const storageKey = (
  pepper: string,
  userId: string,
  purpose: "account" | "settings",
): Promise<string> => sign(pepper, purpose, userId);

export const createSecret = (pepper: string, accountId: string): Promise<string> =>
  sign(pepper, "secret", accountId);

export const verifySecret = async (
  pepper: string,
  accountId: string,
  secret: string,
): Promise<boolean> => {
  if (!/^[a-f0-9]{64}$/.test(secret)) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(pepper),
    Uint8Array.fromHex(secret),
    message("secret", accountId),
  );
};

export interface Authorization {
  readonly secret: string;
  readonly userId: string;
}

export const decodeAuthorization = (header: string): Authorization | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
    return undefined;
  }

  try {
    const [secret, userId, extra] = atob(header).split(":");
    if (!secret || !userId || extra !== undefined || !/^\d+$/.test(userId)) return undefined;
    return { secret, userId };
  } catch {
    return undefined;
  }
};
