# awb-status-sync

Actualizează automat în Shopify (provitamine.ro) statusul livrărilor FAN Courier, Sameday și Cargus:
**În tranzit → În curs de livrare → Gata de ridicare (easybox / FANbox) → Livrat**, plus **Eșuat** pentru refuzuri și retururi.

Nu are nevoie de API sau cont la curieri. Citește aceleași date publice pe care le afișează paginile lor de tracking:

| Curier | Sursă | Limită |
|---|---|---|
| FAN Courier | `fancourier.ro/limit-tracking.php` (JSON, istoric complet) | ~8 cereri/min → 1 AWB la 7,5 s |
| Sameday | `api.sameday.ro/api/public/awb/{awb}/awb-history` (JSON, istoric complet) | fără limită observată |
| Cargus | pagina `cargus.ro/personal/urmareste-coletul` (HTML, doar ultimul status) | uneori răspunde gol → reîncearcă |

## Cum funcționează

Rulează din oră în oră prin GitHub Actions (gratuit):
1. ia din Shopify comenzile expediate în ultimele 20 de zile care **nu** sunt încă livrate;
2. verifică AWB-ul la curier (cei trei curieri în paralel, fiecare în ritmul lui);
3. dacă statusul curierului diferă de ultimul status din Shopify, adaugă **un** eveniment de livrare (`fulfillmentEventCreate`) cu data, orașul și textul curierului.

Comenzile livrate ies automat din verificare. O rulare durează de obicei 10–35 de minute, în funcție de câte colete FAN sunt pe drum.

### Statusuri
| Shopify | FAN Courier | Sameday | Cargus |
|---|---|---|---|
| Preluat de curier | – | 2 | „Colectata de curier” |
| În tranzit | H* (hub, depozit, sortare), S9 | 3, 7, 9, 17 | „…tranzit…”, „…depozit…” |
| În curs de livrare | S1, C1 | 4 | „Spre destinatar” |
| Gata de ridicare | S46 (punct livrare / FANbox) | 18 (easybox / Sameday Point) | „Se asteapta ridicarea…” |
| Încercare eșuată | S3 (avizat), S12 | – | „avizat”, „absent” |
| Întârziat | – | 20, 22 (easybox aglomerat / nefuncțional) | – |
| **Livrat** | S2 | 5 | „Livrat la destinatar” |
| **Eșuat** | S6 (refuz), S43 (retur) | 6, 8, 14 (refuz / retur) | „returnat”, „refuz” |

Un status nou, necunoscut, nu este scris. Apare în rezumatul rulării, la „Statusuri necunoscute”, și se adaugă în `src/mapping.mjs`.

> **Emailuri către clienți:** Shopify trimite singur emailurile „În curs de livrare” și „Livrat” (Setări → Notificări → Actualizări de expediere) când primește aceste statusuri. Ele pot fi oprite oricând de acolo, fără nicio modificare în aplicație.

## Instalare (o singură dată)

1. **Aplicație Shopify** – în [Dev Dashboard](https://dev.shopify.com/dashboard), creezi o aplicație „AWB status sync” cu permisiunile:
   `read_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_third_party_fulfillment_orders, write_third_party_fulfillment_orders`.
   Apoi creezi o versiune și o instalezi pe magazinul provitamine.
2. **Secrete GitHub** – în repo, la Settings → Secrets and variables → Actions → *New repository secret*, adaugi:
   - `SHOPIFY_CLIENT_ID` – Client ID-ul aplicației
   - `SHOPIFY_CLIENT_SECRET` – Client secret-ul aplicației
3. **Test** – din tab-ul Actions → „Sincronizare statusuri AWB” → *Run workflow* cu `dry_run` bifat. Rezumatul arată ce s-ar schimba, fără să scrie nimic.
4. După test, rularea automată din oră în oră pornește singură.

Opțional (Settings → Variables): `SHOPIFY_SHOP` (implicit `provitamine`), `LOOKBACK_DAYS` (implicit 20), `DRY_RUN=true` pentru a opri temporar scrierile.

## Local
```bash
SHOPIFY_SHOP=provitamine SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... DRY_RUN=1 node src/sync.mjs
ONLY_ORDERS=PRO21122820 node src/sync.mjs     # doar anumite comenzi
npm test                                       # teste pe 110 AWB-uri reale (fixtures)
```

## Limitări
- Sursele sunt paginile publice ale curierilor. Dacă un curier își schimbă pagina, rularea raportează erori și acel curier trebuie actualizat în `src/couriers.mjs`.
- Pagina Cargus arată doar ultimul status, cu ora rotunjită.
- Comenzile mai vechi de 20 de zile nu mai sunt verificate.
