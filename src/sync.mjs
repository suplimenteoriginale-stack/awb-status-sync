// Sync courier delivery statuses (FAN Courier, Sameday, Cargus) into Shopify fulfillment events.
// Run: node src/sync.mjs            (env vars: see README)
import { appendFileSync } from "node:fs";
import { createShopify } from "./shopify.mjs";
import { createTracker, detectCourier } from "./couriers.mjs";
import { mapEvent } from "./mapping.mjs";

const env = process.env;
const CFG = {
  shop: env.SHOPIFY_SHOP,
  token: env.SHOPIFY_ADMIN_TOKEN,
  clientId: env.SHOPIFY_CLIENT_ID,
  clientSecret: env.SHOPIFY_CLIENT_SECRET,
  dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN || ""),
  lookbackDays: +(env.LOOKBACK_DAYS || 20),
  maxRuntimeMin: +(env.MAX_RUNTIME_MIN || 50),
  onlyOrders: (env.ONLY_ORDERS || "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean),
};

const COURIER_LABEL = { fan: "FAN Courier", sameday: "Sameday", cargus: "Cargus" };
const log = console;
const startedAt = Date.now();
const timeLeft = () => CFG.maxRuntimeMin * 60_000 - (Date.now() - startedAt);

export async function run({ shopify, track, cfg = CFG, out = log } = {}) {
  shopify ||= createShopify({ shop: cfg.shop, token: cfg.token, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
  track ||= createTracker({ log: out });
  const since = new Date(Date.now() - cfg.lookbackDays * 86400_000).toISOString().slice(0, 10);
  const stats = { orders: 0, candidates: 0, checked: 0, created: 0, unchanged: 0, notPickedUp: 0, errors: 0, skippedTime: 0, byStatus: {} };
  const unknown = new Map();
  const changes = [];

  // 1) Collect fulfillments that are shipped but not yet delivered.
  const queues = { fan: [], sameday: [], cargus: [] };
  for await (const order of shopify.shippedOrders(since)) {
    stats.orders++;
    if (cfg.onlyOrders.length && !cfg.onlyOrders.includes(order.name.replace(/^#/, ""))) continue;
    for (const f of order.fulfillments) {
      if (f.status !== "SUCCESS") continue;
      const events = f.events?.nodes || [];
      const latest = events[0] || null; // sorted newest first
      if (f.displayStatus === "DELIVERED" || latest?.status === "DELIVERED") continue;
      const t = (f.trackingInfo || []).find((x) => x.number);
      if (!t) continue;
      const courier = detectCourier(t.company || "", t.number);
      if (!courier) continue;
      queues[courier].push({ order, f, awb: t.number.trim(), courier, latest });
      stats.candidates++;
    }
  }
  // Likely-to-change first: out for delivery / at pickup point, then the oldest shipments.
  const prio = (c) => (["OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "ATTEMPTED_DELIVERY"].includes(c.latest?.status) ? 0 : 1);
  for (const q of Object.values(queues)) q.sort((a, b) => prio(a) - prio(b) || a.f.createdAt.localeCompare(b.f.createdAt));
  out.log(`Comenzi expediate din ultimele ${cfg.lookbackDays} zile: ${stats.orders}. De verificat: FAN ${queues.fan.length}, Sameday ${queues.sameday.length}, Cargus ${queues.cargus.length}.${cfg.dryRun ? " [DRY RUN]" : ""}`);

  // 2) Each courier has its own rate limit, so the three queues run in parallel.
  async function worker(courier) {
    for (const c of queues[courier]) {
      if (timeLeft() < 60_000) { stats.skippedTime++; continue; }
      const res = await track(courier, c.awb);
      stats.checked++;
      if (!res.ok) { stats.errors++; out.warn(`! ${c.order.name} ${courier} ${c.awb}: ${res.error}`); continue; }
      if (res.notPickedUp || !res.events.length) { stats.notPickedUp++; continue; }

      // Latest courier event that maps to a Shopify status.
      let target = null;
      for (let i = res.events.length - 1; i >= 0; i--) {
        const ev = res.events[i];
        const st = mapEvent(courier, ev);
        if (st === undefined) {
          const k = `${courier} | ${ev.code ?? "-"} | ${ev.text}`;
          unknown.set(k, (unknown.get(k) || 0) + 1);
          continue;
        }
        if (st) { target = { ...ev, status: st }; break; }
      }
      if (!target) { stats.unchanged++; continue; }

      const cur = c.latest;
      const curTime = cur ? Date.parse(cur.happenedAt) : 0;
      const tgtTime = target.happenedAt ? Date.parse(target.happenedAt) : Date.now();
      if (cur && cur.status === target.status) { stats.unchanged++; continue; }
      if (cur && tgtTime <= curTime) { stats.unchanged++; continue; } // Shopify already has something newer

      const input = {
        fulfillmentId: c.f.id,
        status: target.status,
        happenedAt: target.happenedAt || new Date().toISOString(),
        message: `${COURIER_LABEL[courier]}: ${target.text}${target.detail && target.detail !== target.text ? ` – ${target.detail}` : ""}`.slice(0, 255),
        country: "Romania",
        ...(target.city ? { city: target.city } : {}),
      };
      const line = `${c.order.name} ${COURIER_LABEL[courier]} ${c.awb}: ${cur?.status || "—"} -> ${target.status} (${target.text})`;
      if (cfg.dryRun) {
        out.log(`[dry] ${line}`);
      } else {
        try {
          await shopify.createEvent(input);
          out.log(`✓ ${line}`);
        } catch (e) {
          stats.errors++; out.warn(`! ${c.order.name}: ${e.message}`); continue;
        }
      }
      stats.created++;
      stats.byStatus[target.status] = (stats.byStatus[target.status] || 0) + 1;
      changes.push(line);
    }
  }
  await Promise.all(["fan", "sameday", "cargus"].map(worker));

  out.log(`\nGata in ${Math.round((Date.now() - startedAt) / 1000)}s. Verificate ${stats.checked}/${stats.candidates}, actualizate ${stats.created}, neschimbate ${stats.unchanged}, nepreluate de curier ${stats.notPickedUp}, erori ${stats.errors}, amanate (timp) ${stats.skippedTime}.`);
  if (Object.keys(stats.byStatus).length) out.log(`Statusuri noi: ${JSON.stringify(stats.byStatus)}`);
  if (unknown.size) {
    out.log(`\nStatusuri necunoscute (ignorate, de adaugat in mapping.mjs):`);
    for (const [k, v] of unknown) out.log(`  ${v}x ${k}`);
  }
  writeSummary(stats, changes, unknown, cfg);
  return { stats, changes, unknown };
}

function writeSummary(stats, changes, unknown, cfg) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## Sincronizare statusuri AWB${cfg.dryRun ? " (DRY RUN)" : ""}`,
    `| Verificate | Actualizate | Neschimbate | Nepreluate | Erori | Amanate |`,
    `|---|---|---|---|---|---|`,
    `| ${stats.checked}/${stats.candidates} | ${stats.created} | ${stats.unchanged} | ${stats.notPickedUp} | ${stats.errors} | ${stats.skippedTime} |`,
    "",
    ...(changes.length ? ["### Modificari", ...changes.slice(0, 300).map((l) => `- ${l}`)] : []),
    ...(unknown.size ? ["", "### Statusuri necunoscute", ...[...unknown].map(([k, v]) => `- ${v}x ${k}`)] : []),
  ];
  appendFileSync(file, lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(({ stats }) => { if (stats.errors > 0 && stats.created === 0 && stats.checked > 0 && stats.errors === stats.checked) process.exit(1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
