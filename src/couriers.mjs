// Public tracking for FAN Courier, Sameday and Cargus (no courier account / API key needed).
// Each tracker returns a normalized result:
//   { ok: true, events: [{ code, text, city, happenedAt (ISO) }] }   newest LAST
//   { ok: true, events: [], notPickedUp: true }                        AWB created, not yet handed to courier
//   { ok: false, retryable: bool, error }                              transient / unknown failure
import { sleep } from "./shopify.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export function detectCourier(company = "", number = "") {
  const c = company.toLowerCase();
  if (c.includes("fan")) return "fan";
  if (c.includes("sameday") || c.includes("same day")) return "sameday";
  if (c.includes("cargus")) return "cargus";
  // Fallback on AWB shape
  if (/^\d{13}$/.test(number) && number.startsWith("7")) return "fan";
  if (/^[0-9A-Z]{4,}[A-Z]{2,}\d{6,}$/i.test(number) && /[A-Z]/i.test(number)) return "sameday";
  if (/^\d{10}$/.test(number)) return "cargus";
  return null;
}

// Romania local time ("2026-11-05 11:48:59") -> ISO with correct EET/EEST offset.
export function roLocalToIso(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se = "00"] = m;
  // Find the offset Europe/Bucharest had at that wall-clock time.
  const guess = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se);
  const offMin = bucharestOffsetMinutes(new Date(guess));
  return new Date(guess - offMin * 60_000).toISOString();
}

function bucharestOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Bucharest", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

const RO_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  ianuarie: 1, februarie: 2, martie: 3, aprilie: 4, mai: 5, iunie: 6, iulie: 7, septembrie: 9, octombrie: 10, noiembrie: 11, decembrie: 12 };

// ---------------- FAN Courier ----------------
export async function trackFan(awb, { fetchImpl = fetch } = {}) {
  const fd = new FormData();
  fd.append("action", "get_awb");
  fd.append("awb", awb);
  fd.append("lang", "ro");
  let res;
  try {
    res = await fetchImpl("https://www.fancourier.ro/limit-tracking.php", {
      method: "POST", body: fd,
      headers: { "User-Agent": UA, Referer: "https://www.fancourier.ro/awb-tracking/", Origin: "https://www.fancourier.ro" },
    });
  } catch (e) {
    return { ok: false, retryable: true, error: `retea: ${e.message}` };
  }
  if (res.status === 429) return { ok: false, retryable: true, rateLimited: true, error: "FAN 429" };
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not json */ }
  if (res.status === 404 && j?.message) {
    // "AWB-ul a fost inregistrat de catre clientul expeditor" = label created, not picked up yet
    return { ok: true, events: [], notPickedUp: true, note: j.message };
  }
  if (!res.ok || !j) return { ok: false, retryable: res.status >= 500, error: `FAN HTTP ${res.status}` };
  const events = (j.events || []).map((e) => ({
    code: e.id, text: e.name, city: e.location || null, happenedAt: roLocalToIso(e.date),
  }));
  return { ok: true, events, raw: { returnAwb: j.returnAwbNumber, redirectionAwb: j.redirectionAwbNumber } };
}

// ---------------- Sameday ----------------
export async function trackSameday(awb, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`https://api.sameday.ro/api/public/awb/${encodeURIComponent(awb)}/awb-history?_locale=ro`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, retryable: true, error: `retea: ${e.message}` };
  }
  if (res.status === 429) return { ok: false, retryable: true, rateLimited: true, error: "Sameday 429" };
  if (res.status === 404) return { ok: true, events: [], notPickedUp: true };
  if (!res.ok) return { ok: false, retryable: res.status >= 500, error: `Sameday HTTP ${res.status}` };
  const j = await res.json().catch(() => null);
  if (!j) return { ok: false, retryable: true, error: "Sameday raspuns invalid" };
  const events = (j.awbHistory || [])
    .map((e) => ({
      code: String(e.statusStateId), subCode: String(e.statusId),
      text: e.statusState, detail: e.status, city: e.county || null,
      happenedAt: e.statusDate ? new Date(e.statusDate).toISOString() : null,
    }))
    .sort((a, b) => String(a.happenedAt).localeCompare(String(b.happenedAt)));
  return { ok: true, events };
}

// ---------------- Cargus ----------------
// Cargus' public page only shows the LATEST status, server-rendered. The page sometimes
// comes back without results (their backend is flaky) -> retryable.
export async function trackCargus(awb, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`https://www.cargus.ro/personal/urmareste-coletul/?tracking_number=${encodeURIComponent(awb)}`, {
      headers: { "User-Agent": UA, "Accept-Language": "ro-RO,ro;q=0.9" },
    });
  } catch (e) {
    return { ok: false, retryable: true, error: `retea: ${e.message}` };
  }
  if (res.status === 429) return { ok: false, retryable: true, rateLimited: true, error: "Cargus 429" };
  if (!res.ok) return { ok: false, retryable: res.status >= 500, error: `Cargus HTTP ${res.status}` };
  return parseCargusHtml(await res.text(), awb);
}

export function parseCargusHtml(html, awb) {
  const i = html.indexOf("Detalii de tracking");
  if (i < 0) return { ok: false, retryable: true, error: "Cargus fara rezultat (pagina goala)" };
  let seg = html.slice(i, i + 5000);
  const bar = seg.match(/width:\s*(\d+)%/);
  seg = seg.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  const text = decodeEntities(seg.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  // "Detalii de tracking pentru AWB 1210649374 30 October 2026, 11:10 Livrat la destinatar (confirmat) Doresti ..."
  const m = text.match(/AWB\s+(\d+)\s+(\d{1,2})\s+([A-Za-zăâîșțĂÂÎȘȚ]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s+(.*?)(?:\s+Dore[sș]ti|\s+Creeaz|$)/i);
  if (!m) return { ok: false, retryable: true, error: "Cargus format necunoscut" };
  const [, num, d, monName, y, hh, mm, status] = m;
  if (awb && num !== String(awb)) return { ok: false, retryable: true, error: `Cargus AWB diferit (${num})` };
  const mon = RO_MONTHS[monName.toLowerCase()];
  const iso = mon ? roLocalToIso(`${y}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")} ${hh.padStart(2, "0")}:${mm}:00`) : null;
  return { ok: true, events: [{ code: null, text: status.trim(), city: null, happenedAt: iso, progress: bar ? +bar[1] : null }] };
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ---------------- Rate-limited dispatcher ----------------
// FAN allows ~8-9 requests/minute per IP (measured); we keep a safe 7.5s gap.
const GAP_MS = { fan: 7500, sameday: 400, cargus: 2500 };
const TRACKERS = { fan: trackFan, sameday: trackSameday, cargus: trackCargus };

export function createTracker({ fetchImpl = fetch, gaps = GAP_MS, log = console } = {}) {
  const last = { fan: 0, sameday: 0, cargus: 0 };
  return async function track(courier, awb) {
    const fn = TRACKERS[courier];
    if (!fn) return { ok: false, retryable: false, error: `curier necunoscut: ${courier}` };
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last[courier] + gaps[courier] - Date.now();
      if (wait > 0) await sleep(wait);
      last[courier] = Date.now();
      result = await fn(awb, { fetchImpl });
      if (result.ok || !result.retryable) return result;
      const backoff = result.rateLimited ? 60_000 : 4000 * (attempt + 1);
      log.warn?.(`  ${courier} ${awb}: ${result.error} -> reincerc in ${backoff / 1000}s`);
      await sleep(backoff);
    }
    return result;
  };
}
