/*
 * Egypt local time, from the tz database's "Africa/Cairo" zone via Intl.
 * Daylight saving changes come from the runtime's tz data, so there is no
 * hand-written DST rule to maintain.
 */

const cairo = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Local date and time fields as strings: year, month, day, hour, minute, second. */
function parts(ms) {
  const out = {};
  for (const p of cairo.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** Hours ahead of UTC in Egypt at a given instant: 3 in summer, 2 in winter. */
export function egyptOffsetHours(ms) {
  const p = parts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 3600_000);
}

/** Minutes since local midnight, 0-1439. */
export function localMinutes(ms) {
  const p = parts(ms);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "dd/MM/yyyy HH:mm:ss" in Egypt local time, which is what Zoho expects. */
export function zohoStamp(ms) {
  const p = parts(ms);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}
