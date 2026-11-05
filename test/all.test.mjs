import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapEvent, byKeywords } from "../src/mapping.mjs";
import { parseCargusHtml, roLocalToIso, detectCourier, trackFan, trackSameday } from "../src/couriers.mjs";
import { run } from "../src/sync.mjs";

const fx = (f) => new URL(`./fixtures/${f}`, import.meta.url);
const sample = JSON.parse(readFileSync(fx("sample.json"), "utf8"));

test("every status seen on real AWBs is mapped (no unknowns)", () => {
  const unknown = [];
  for (const r of sample) {
    if (r.c === "FAN") for (const e of r.events) { if (mapEvent("fan", { code: e.id, text: e.name }) === undefined) unknown.push(`FAN ${e.id} ${e.name}`); }
    if (r.c === "SameDay") for (const e of r.awbHistory) { if (mapEvent("sameday", { code: String(e.statusStateId), text: e.statusState, detail: e.status }) === undefined) unknown.push(`SD ${e.statusStateId} ${e.statusState}`); }
    if (r.c === "Cargus" && r.text) {
      const p = parseCargusHtml(`<div>${r.text}</div>`, r.awb);
      assert.ok(p.ok, `cargus parse ${r.awb}: ${r.text}`);
      if (mapEvent("cargus", p.events[0]) === undefined) unknown.push(`CARGUS ${p.events[0].text}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("final statuses of real AWBs", () => {
  const finals = { DELIVERED: 0, FAILURE: 0 };
  for (const r of sample) {
    let st;
    if (r.c === "FAN" && r.events.length) { const e = r.events.at(-1); st = mapEvent("fan", { code: e.id, text: e.name }); }
    if (r.c === "SameDay" && r.awbHistory.length) { const e = r.awbHistory[0]; st = mapEvent("sameday", { code: String(e.statusStateId), text: e.statusState }); }
    if (st in finals) finals[st]++;
  }
  assert.ok(finals.DELIVERED > 50, JSON.stringify(finals));
  assert.ok(finals.FAILURE >= 4, JSON.stringify(finals));
});

test("key mappings", () => {
  assert.equal(mapEvent("fan", { code: "S2", text: "Livrat" }), "DELIVERED");
  assert.equal(mapEvent("fan", { code: "S43", text: "Retur" }), "FAILURE");
  assert.equal(mapEvent("fan", { code: "S6", text: "Refuz primire" }), "FAILURE");
  assert.equal(mapEvent("fan", { code: "S1", text: "Expeditie in livrare" }), "OUT_FOR_DELIVERY");
  assert.equal(mapEvent("fan", { code: "S46", text: "Predat punct livrare" }), "READY_FOR_PICKUP");
  assert.equal(mapEvent("fan", { code: "H99", text: "ceva hub nou" }), "IN_TRANSIT");
  assert.equal(mapEvent("sameday", { code: "5" }), "DELIVERED");
  assert.equal(mapEvent("sameday", { code: "18" }), "READY_FOR_PICKUP");
  assert.equal(mapEvent("sameday", { code: "1" }), null);
  assert.equal(mapEvent("cargus", { text: "Livrat la destinatar (confirmat)" }), "DELIVERED");
  assert.equal(mapEvent("cargus", { text: "Expediere returnata: Solicitare Cargus" }), "FAILURE");
  assert.equal(mapEvent("cargus", { text: "Se asteapta ridicarea coletului de la sediu: Solicitare destinatar" }), "READY_FOR_PICKUP");
  assert.equal(mapEvent("cargus", { text: "Spre destinatar" }), "OUT_FOR_DELIVERY");
  assert.equal(mapEvent("cargus", { text: "Colectata de curier" }), "CARRIER_PICKED_UP");
  assert.equal(byKeywords("Retur livrat la expeditor"), "FAILURE");
  assert.equal(byKeywords("ceva complet nou"), undefined);
});

test("cargus html parsing (real page)", () => {
  const p = parseCargusHtml(readFileSync(fx("cargus-delivered.html"), "utf8"), "1299990001");
  assert.ok(p.ok);
  assert.equal(p.events[0].text, "Livrat la destinatar (confirmat)");
  assert.equal(p.events[0].happenedAt, "2026-10-30T09:10:00.000Z");
  assert.equal(p.events[0].progress, 100);
  assert.equal(parseCargusHtml("<html>Te rugam sa introduci</html>", "1").ok, false);
});

test("Romania local time -> UTC, summer and winter", () => {
  assert.equal(roLocalToIso("2026-11-05 11:48:59"), "2026-11-05T09:48:59.000Z"); // EET +2
  assert.equal(roLocalToIso("2026-07-01 12:00:00"), "2026-07-01T09:00:00.000Z"); // EEST +3
});

test("courier detection", () => {
  assert.equal(detectCourier("FAN RO", "7000123456789"), "fan");
  assert.equal(detectCourier("SameDay", "1TESTXX0000001"), "sameday");
  assert.equal(detectCourier("Cargus RO", "1200000099"), "cargus");
  assert.equal(detectCourier("", "7000123456789"), "fan");
  assert.equal(detectCourier("", "1TESTXX0000001"), "sameday");
  assert.equal(detectCourier("", "1200000099"), "cargus");
});

test("FAN tracker parses API response and 404 'not picked up'", async () => {
  const ok = await trackFan("7000123456789", { fetchImpl: async () => new Response(JSON.stringify({ events: [{ id: "S2", name: "Livrat", location: "Bucuresti", date: "2026-11-05 11:48:59" }] }), { status: 200 }) });
  assert.deepEqual(ok.events[0], { code: "S2", text: "Livrat", city: "Bucuresti", happenedAt: "2026-11-05T09:48:59.000Z" });
  const nf = await trackFan("1", { fetchImpl: async () => new Response(JSON.stringify({ message: "AWB-ul a fost inregistrat de catre clientul expeditor" }), { status: 404 }) });
  assert.equal(nf.notPickedUp, true);
  const rl = await trackFan("1", { fetchImpl: async () => new Response("", { status: 429 }) });
  assert.equal(rl.rateLimited, true);
});

test("Sameday tracker sorts history oldest -> newest", async () => {
  const body = { awbHistory: [
    { statusStateId: 5, statusState: "Coletul a fost livrat cu succes", statusId: 9, status: "x", county: "Brasov", statusDate: "2026-11-04T08:09:01+02:00" },
    { statusStateId: 18, statusState: "Colet incarcat", statusId: 78, status: "y", county: "Brasov", statusDate: "2026-11-03T17:02:20+02:00" },
  ] };
  const r = await trackSameday("A", { fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
  assert.equal(r.events.at(-1).code, "5");
  assert.equal(r.events.at(-1).happenedAt, "2026-11-04T06:09:01.000Z");
});

// ---- end-to-end sync logic with fake Shopify + fake couriers ----
function fakeShopify(orders) {
  const created = [], links = [];
  return {
    created, links,
    async *shippedOrders() { for (const o of orders) yield o; },
    async createEvent(e) { created.push(e); return { id: "x", ...e }; },
    async updateTracking(id, t) { links.push([id, t.url]); },
  };
}
const ful = (id, company, number, events = [], extra = {}) => ({ id, status: "SUCCESS", displayStatus: events[0]?.status || "FULFILLED", createdAt: "2026-11-01T10:00:00Z", trackingInfo: [{ company, number }], events: { nodes: events }, ...extra });
const quiet = { log() {}, warn() {} };

test("sync: creates only changed statuses, skips delivered/not-picked-up/unchanged", async () => {
  const orders = [
    { name: "#A1", fulfillments: [ful("F1", "FAN RO", "7000000000001")] }, // -> DELIVERED
    { name: "#A2", fulfillments: [ful("F2", "SameDay", "1INOLN000000002", [{ status: "OUT_FOR_DELIVERY", happenedAt: "2026-11-04T08:00:00Z" }])] }, // -> READY_FOR_PICKUP
    { name: "#A3", fulfillments: [ful("F3", "Cargus RO", "1200000003", [{ status: "IN_TRANSIT", happenedAt: "2026-11-04T08:00:00Z" }])] }, // unchanged
    { name: "#A4", fulfillments: [ful("F4", "FAN RO", "7000000000004", [{ status: "DELIVERED", happenedAt: "2026-11-03T08:00:00Z" }])] }, // already delivered -> not even tracked
    { name: "#A5", fulfillments: [ful("F5", "FAN RO", "7000000000005")] }, // not picked up
    { name: "#A6", fulfillments: [ful("F6", "FAN RO", "7000000000006", [], { status: "CANCELLED" })] }, // cancelled fulfillment
    { name: "#A7", fulfillments: [ful("F7", "SameDay", "1INOLN000000007")] }, // refused -> FAILURE
  ];
  const tracked = [];
  const track = async (courier, awb) => {
    tracked.push(awb);
    if (awb.endsWith("01")) return { ok: true, events: [{ code: "S1", text: "Expeditie in livrare", happenedAt: "2026-11-05T06:00:00.000Z" }, { code: "S2", text: "Livrat", city: "Bucuresti", happenedAt: "2026-11-05T09:48:59.000Z" }] };
    if (awb.endsWith("02")) return { ok: true, events: [{ code: "18", text: "Colet incarcat in punctul de livrare", detail: "Coletul a ajuns in easybox", city: "Brasov", happenedAt: "2026-11-05T09:25:57.000Z" }] };
    if (awb.endsWith("03")) return { ok: true, events: [{ text: "Iesire din depozit catre tranzit", happenedAt: "2026-11-05T02:00:00.000Z" }] };
    if (awb.endsWith("05")) return { ok: true, events: [], notPickedUp: true };
    if (awb.endsWith("07")) return { ok: true, events: [{ code: "6", text: "Coletul a fost refuzat", happenedAt: "2026-11-05T10:00:00.000Z" }] };
    throw new Error("unexpected " + awb);
  };
  const shopify = fakeShopify(orders);
  const { stats } = await run({ shopify, track, out: quiet, cfg: { lookbackDays: 20, maxRuntimeMin: 5, onlyOrders: [], dryRun: false } });
  assert.deepEqual(tracked.sort(), ["1200000003", "1INOLN000000002", "1INOLN000000007", "7000000000001", "7000000000005"].sort());
  assert.deepEqual(shopify.created.map((e) => [e.fulfillmentId, e.status]).sort(), [["F1", "DELIVERED"], ["F2", "READY_FOR_PICKUP"], ["F7", "FAILURE"]]);
  const f1 = shopify.created.find((e) => e.fulfillmentId === "F1");
  assert.equal(f1.happenedAt, "2026-11-05T09:48:59.000Z");
  assert.equal(f1.city, "Bucuresti");
  assert.match(f1.message, /^FAN Courier: Livrat/);
  assert.equal(stats.notPickedUp, 1);
  assert.equal(stats.unchanged, 1);
});

test("sync: dry run writes nothing", async () => {
  const shopify = fakeShopify([{ name: "#B1", fulfillments: [ful("F1", "FAN RO", "7000000000001")] }]);
  const track = async () => ({ ok: true, events: [{ code: "S2", text: "Livrat", happenedAt: "2026-11-05T09:48:59.000Z" }] });
  const { stats } = await run({ shopify, track, out: quiet, cfg: { lookbackDays: 20, maxRuntimeMin: 5, onlyOrders: [], dryRun: true } });
  assert.equal(shopify.created.length, 0);
  assert.equal(stats.created, 1);
});

test("sync: never goes back in time over a newer Shopify event", async () => {
  const shopify = fakeShopify([{ name: "#C1", fulfillments: [ful("F1", "FAN RO", "7000000000001", [{ status: "OUT_FOR_DELIVERY", happenedAt: "2026-11-05T12:00:00Z" }])] }]);
  const track = async () => ({ ok: true, events: [{ code: "H0", text: "tranzit", happenedAt: "2026-11-04T09:00:00.000Z" }] });
  await run({ shopify, track, out: quiet, cfg: { lookbackDays: 20, maxRuntimeMin: 5, onlyOrders: [], dryRun: false } });
  assert.equal(shopify.created.length, 0);
});

test("sync: stops the whole run on a permission error", async () => {
  const orders = [1, 2, 3].map((i) => ({ name: `#D${i}`, fulfillments: [ful(`F${i}`, "SameDay", `1INOLN00000000${i}`)] }));
  let writes = 0;
  const shopify = { async *shippedOrders() { for (const o of orders) yield o; }, async createEvent() { writes++; throw new Error('Shopify GraphQL: [{"extensions":{"code":"ACCESS_DENIED"}}]'); }, async updateTracking() {} };
  const track = async () => ({ ok: true, events: [{ code: "5", text: "Livrat", happenedAt: "2026-11-05T09:00:00.000Z" }] });
  await assert.rejects(run({ shopify, track, out: quiet, cfg: { lookbackDays: 20, maxRuntimeMin: 5, onlyOrders: [], dryRun: false } }), /permisiuni/);
  assert.equal(writes, 1);
});

test("FAN S8 (ridicare din sediu) and Cargus empty page = not picked up", async () => {
  assert.equal(mapEvent("fan", { code: "S8", text: "Livrare din sediul FAN Courier" }), "READY_FOR_PICKUP");
  const { createTracker } = await import("../src/couriers.mjs");
  const track = createTracker({ gaps: { fan: 0, sameday: 0, cargus: 0 }, log: { warn() {} },
    fetchImpl: async () => new Response("<html>Te rugam sa introduci numarul</html>", { status: 200 }) });
  const orig = global.setTimeout; global.setTimeout = (f) => orig(f, 0);
  try { const r = await track("cargus", "1211507180"); assert.equal(r.ok, true); assert.equal(r.notPickedUp, true); }
  finally { global.setTimeout = orig; }
});

test("sync: replaces orders-tracker.com links with the courier page, leaves correct ones alone", async () => {
  const mk = (id, company, number, url, events = []) => ({ ...ful(id, company, number, events), trackingInfo: [{ company, number, url }] });
  const orders = [
    { name: "#L1", fulfillments: [mk("L1", "FAN RO", "7000179087693", "https://orders-tracker.com/?wb=7000179087693")] },
    { name: "#L2", fulfillments: [mk("L2", "SameDay", "1INOLN551831793", "https://orders-tracker.com/?wb=1INOLN551831793")] },
    { name: "#L3", fulfillments: [mk("L3", "Cargus RO", "1211507079", "https://orders-tracker.com/?wb=1211507079", [{ status: "DELIVERED", happenedAt: "2026-11-03T08:00:00Z" }])] },
    { name: "#L4", fulfillments: [mk("L4", "FAN RO", "7000000000009", "https://www.fancourier.ro/awb-tracking/?tracking=7000000000009")] },
  ];
  const shopify = fakeShopify(orders);
  const track = async () => ({ ok: true, events: [], notPickedUp: true });
  const { stats } = await run({ shopify, track, out: quiet, cfg: { lookbackDays: 20, maxRuntimeMin: 5, onlyOrders: [], dryRun: false } });
  assert.deepEqual(shopify.links, [
    ["L1", "https://www.fancourier.ro/awb-tracking/?tracking=7000179087693"],
    ["L2", "https://sameday.ro/status-colet/?awb=1INOLN551831793"],
    ["L3", "https://www.cargus.ro/personal/urmareste-coletul/?tracking_number=1211507079"], // fixed even when delivered
  ]);
  assert.equal(stats.linksFixed, 3);
});
