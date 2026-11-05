// Shopify Admin GraphQL client.
// Auth: either a static Admin API token (SHOPIFY_ADMIN_TOKEN) or a Dev Dashboard app
// (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET) exchanged via the client credentials grant.

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

export function createShopify({ shop, token, clientId, clientSecret, fetchImpl = fetch, log = console }) {
  if (!shop) throw new Error("SHOPIFY_SHOP lipseste (ex: provitamine)");
  const host = shop.includes(".") ? shop : `${shop}.myshopify.com`;
  let accessToken = token || null;
  let expiresAt = token ? Infinity : 0;

  async function getToken() {
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    if (!clientId || !clientSecret) throw new Error("Lipsesc SHOPIFY_ADMIN_TOKEN sau SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET");
    const res = await fetchImpl(`https://${host}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) throw new Error(`Token Shopify refuzat: HTTP ${res.status} ${await res.text()}`);
    const j = await res.json();
    accessToken = j.access_token;
    expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    return accessToken;
  }

  async function graphql(query, variables = {}, attempt = 0) {
    const res = await fetchImpl(`https://${host}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      return graphql(query, variables, attempt + 1);
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const throttled = j.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      return graphql(query, variables, attempt + 1);
    }
    if (j.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors)}`);
    return j.data;
  }

  // Shipped orders created after `sinceIso`, with their fulfillments, tracking and latest events.
  async function* shippedOrders(sinceIso) {
    const q = `query($after: String, $q: String!) {
      orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name createdAt
          fulfillments(first: 5) {
            id status displayStatus createdAt deliveredAt
            trackingInfo(first: 3) { company number }
            events(first: 50, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } }
          }
        }
      }
    }`;
    let after = null;
    do {
      const d = await graphql(q, { after, q: `fulfillment_status:shipped AND created_at:>='${sinceIso}'` });
      for (const o of d.orders.nodes) yield o;
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
  }

  async function createEvent(input) {
    const m = `mutation($e: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $e) {
        fulfillmentEvent { id status happenedAt }
        userErrors { field message }
      }
    }`;
    const d = await graphql(m, { e: input });
    const errs = d.fulfillmentEventCreate.userErrors;
    if (errs?.length) throw new Error(`fulfillmentEventCreate: ${JSON.stringify(errs)}`);
    return d.fulfillmentEventCreate.fulfillmentEvent;
  }

  return { graphql, shippedOrders, createEvent };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
