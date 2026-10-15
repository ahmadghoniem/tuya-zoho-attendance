/*
 * Tuya Cloud: request signing, the access token, and the unlock log.
 * Read-only. Nothing here writes to a lock.
 */

const TUYA_BASE = "https://openapi.tuyaeu.com";
const CODES = "unlock_card,unlock_face,unlock_fingerprint,unlock_password";
const TOKEN_KEY = "tuya_token";
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Pages of 100 events read per lock per run.
const MAX_PAGES = 5;

const enc = new TextEncoder();

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Tuya requires query parameters sorted alphabetically inside the signed string. */
function signedPath(basePath, params) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return query ? `${basePath}?${query}` : basePath;
}

/** Signed GET. Pass token "" for the token request itself. */
async function tuyaGet(env, token, basePath, params = {}) {
  const path = signedPath(basePath, params);
  const t = Date.now().toString();
  const stringToSign = `GET\n${EMPTY_BODY_SHA256}\n\n${path}`;
  const sign = await hmacSha256Hex(
    env.TUYA_ACCESS_SECRET,
    env.TUYA_ACCESS_ID + token + t + stringToSign
  );

  const headers = {
    client_id: env.TUYA_ACCESS_ID,
    sign,
    t,
    sign_method: "HMAC-SHA256",
  };
  if (token) headers.access_token = token;

  const res = await fetch(TUYA_BASE + path, { headers });
  return res.json();
}

/** Access token, cached in KV until a minute before it expires (~2 hours). */
export async function tuyaToken(env) {
  const cached = await env.STATE.get(TOKEN_KEY, "json");
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = await tuyaGet(env, "", "/v1.0/token", { grant_type: 1 });
  if (!body.success) throw new Error(`Tuya token failed: ${JSON.stringify(body)}`);

  const token = body.result.access_token;
  const expiresAt = Date.now() + (body.result.expire_time || 7200) * 1000;
  await env.STATE.put(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  return token;
}

/**
 * Unlock events on one lock between two timestamps, oldest first.
 * `complete` is false when there were more than MAX_PAGES pages.
 */
export async function fetchUnlocks(env, token, lockId, startMs, endMs) {
  const events = [];
  let lastRowKey = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      codes: CODES,
      end_time: endMs,
      size: 100,
      start_time: startMs,
    };
    if (lastRowKey) params.last_row_key = lastRowKey;

    const body = await tuyaGet(env, token, `/v2.0/cloud/thing/${lockId}/report-logs`, params);
    if (!body.success) throw new Error(`Tuya log fetch failed: ${JSON.stringify(body)}`);

    events.push(...(body.result.logs || []));
    lastRowKey = body.result.last_row_key;
    if (!body.result.has_more || !lastRowKey) {
      complete = true;
      break;
    }
  }

  events.sort((a, b) => Number(a.event_time) - Number(b.event_time));
  return { events, complete };
}
