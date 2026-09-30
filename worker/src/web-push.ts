export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const encoder = new TextEncoder();

const bytesFromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const base64UrlFromBytes = (value: Uint8Array): string => btoa(String.fromCharCode(...value))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const join = (...values: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  values.forEach(value => { output.set(value, offset); offset += value.length; });
  return output;
};

const hmac = async (key: Uint8Array, value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.sign(
  "HMAC",
  await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  value,
));

const hkdf = async (input: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> => {
  const prk = await hmac(salt, input);
  const blocks: Uint8Array[] = [];
  let previous = new Uint8Array(0);
  for (let counter = 1; join(...blocks).length < length; counter += 1) {
    previous = await hmac(prk, join(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
  }
  return join(...blocks).slice(0, length);
};

const vapidAuthorization = async (endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<string> => {
  const publicBytes = bytesFromBase64Url(publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error("The VAPID public key is invalid.");
  const origin = new URL(endpoint).origin;
  const header = base64UrlFromBytes(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64UrlFromBytes(encoder.encode(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: privateKey,
    x: base64UrlFromBytes(publicBytes.slice(1, 33)), y: base64UrlFromBytes(publicBytes.slice(33)),
    ext: true,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput)));
  return `vapid t=${signingInput}.${base64UrlFromBytes(signature)}, k=${publicKey}`;
};

const encrypt = async (subscription: PushSubscriptionRecord, message: PushMessage): Promise<Uint8Array> => {
  const clientPublic = bytesFromBase64Url(subscription.p256dh);
  const authSecret = bytesFromBase64Url(subscription.auth);
  if (clientPublic.length !== 65 || clientPublic[0] !== 4 || authSecret.length !== 16) throw new Error("The stored push subscription is invalid.");
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const serverPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverPair.publicKey) as ArrayBuffer);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey } as never,
    serverPair.privateKey,
    256,
  ));
  const ikm = await hkdf(shared, authSecret, join(encoder.encode("WebPush: info\0"), clientPublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plaintext = join(encoder.encode(JSON.stringify(message)), Uint8Array.of(2));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), plaintext));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return join(salt, recordSize, Uint8Array.of(serverPublic.length), serverPublic, encrypted);
};

export const sendWebPush = async (
  subscription: PushSubscriptionRecord,
  message: PushMessage,
  vapid: { publicKey: string; privateKey: string; subject: string },
): Promise<{ ok: boolean; expired: boolean; error: string }> => {
  const body = await encrypt(subscription, message);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "300",
      Urgency: "normal",
    },
    body,
  });
  return { ok: response.ok, expired: response.status === 404 || response.status === 410, error: response.ok ? "" : `Push service returned ${response.status}.` };
};