/*
 * Zoho People: OAuth token from the refresh token, and the check-in call.
 * On zoho.eu, change both hosts below; the wrong one returns 401 with no
 * explanation.
 */

const TOKEN_KEY = "zoho_token";

/** Access token, cached in KV until a minute before it expires (~1 hour). */
async function zohoToken(env) {
  const cached = await env.STATE.get(TOKEN_KEY, "json");
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url =
    "https://accounts.zoho.com/oauth/v2/token" +
    `?refresh_token=${env.ZOHO_REFRESH_TOKEN}` +
    `&client_id=${env.ZOHO_CLIENT_ID}` +
    `&client_secret=${env.ZOHO_CLIENT_SECRET}` +
    "&grant_type=refresh_token";

  const res = await fetch(url, { method: "POST" });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Zoho token failed: ${JSON.stringify(body)}`);

  const token = body.access_token;
  const expiresAt = Date.now() + (body.expires_in || 3600) * 1000;
  await env.STATE.put(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  return token;
}

/** Check one employee in at `stamp` ("dd/MM/yyyy HH:mm:ss", Egypt time). */
export async function postCheckIn(env, empId, stamp) {
  const token = await zohoToken(env);
  const url =
    "https://people.zoho.com/people/api/attendance" +
    "?dateFormat=dd/MM/yyyy%20HH:mm:ss" +
    `&empId=${encodeURIComponent(empId)}` +
    `&checkIn=${encodeURIComponent(stamp)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  return res.json();
}
