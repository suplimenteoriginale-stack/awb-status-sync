// Courier status -> Shopify FulfillmentEventStatus.
// Returns: a status string, null (= known but intentionally ignored, e.g. "label created"),
// or undefined (= unknown, reported in the run summary so it can be added here).
//
// Built from real AWBs of provitamine.ro (nov 2026). Codes first, keyword fallback second.

const FAN_CODES = {
  // hub / depozit / sortare / tranzit
  H0: "IN_TRANSIT", H1: "IN_TRANSIT", H3: "IN_TRANSIT", H4: "IN_TRANSIT", H10: "IN_TRANSIT",
  H11: "IN_TRANSIT", H12: "IN_TRANSIT", H13: "IN_TRANSIT", H17: "IN_TRANSIT",
  C1: "OUT_FOR_DELIVERY", // Expeditie preluata spre livrare
  S1: "OUT_FOR_DELIVERY", // Expeditie in livrare
  S2: "DELIVERED", // Livrat
  S3: "ATTEMPTED_DELIVERY", // Avizat
  S12: "ATTEMPTED_DELIVERY", // Contactat; livrare ulterioara
  S46: "READY_FOR_PICKUP", // Predat punct livrare (FANbox / Collect Point)
  S6: "FAILURE", // Refuz primire
  S43: "FAILURE", // Retur
  S9: "IN_TRANSIT", // Redirectionat
};

const SAMEDAY_STATES = {
  1: null, // Expedierea a fost inregistrata (AWB creat, inca nepreluat)
  2: "CARRIER_PICKED_UP", // Coletul a intrat in posesia noastra
  3: "IN_TRANSIT", // depozitul local
  7: "IN_TRANSIT", // in tranzit
  9: "IN_TRANSIT", // redirectionat
  17: "IN_TRANSIT", // depozitul central
  4: "OUT_FOR_DELIVERY", // Curierul urmeaza sa efectueze livrarea
  5: "DELIVERED", // Livrat cu succes
  18: "READY_FOR_PICKUP", // Colet incarcat in punctul de livrare (easybox / Sameday Point)
  6: "FAILURE", // Refuzat (inclusiv termen de pastrare easybox expirat)
  8: "FAILURE", // Returnat cu succes
  14: "FAILURE", // In curs de returnare
  20: "DELAYED", // Punctul de livrare este aglomerat
  22: "DELAYED", // Punctul de livrare este nefunctional
};

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Order matters: failure/return words win over "livrat" ("retur livrat la expeditor").
export function byKeywords(text) {
  const t = norm(text);
  if (!t) return undefined;
  if (/retur|refuz|anulat|distrus|pierdut|returnat|expirat/.test(t)) return "FAILURE";
  if (/\blivrat\b|livrat la destinatar|livrat cu succes|livrata/.test(t)) return "DELIVERED";
  if (/avizat|absent|nu raspunde|adresa (gresita|incompleta)|amanat|ulterioar|reprogramat|nu a putut fi livrat/.test(t)) return "ATTEMPTED_DELIVERY";
  if (/se asteapta ridicarea|ridicare de la sediu|punct de livrare|punctul de livrare|fanbox|easybox|ship ?& ?go|collect point|predat punct/.test(t)) return "READY_FOR_PICKUP";
  if (/in livrare|spre destinatar|preluata spre livrare|urmeaza sa efectueze livrarea|ruta curier/.test(t)) return "OUT_FOR_DELIVERY";
  if (/colectat|preluat de la expeditor|intrat in posesia/.test(t)) return "CARRIER_PICKED_UP";
  if (/tranzit|depozit|sortat|hub|descarcat|redirectionat|iesire din/.test(t)) return "IN_TRANSIT";
  if (/inregistrat|awb generat|asteapta predarea/.test(t)) return null;
  return undefined;
}

export function mapEvent(courier, ev) {
  if (courier === "fan") {
    if (ev.code && Object.hasOwn(FAN_CODES, ev.code)) return FAN_CODES[ev.code];
    if (ev.code && /^H\d+$/.test(ev.code)) return "IN_TRANSIT"; // any hub event
    return byKeywords(ev.text);
  }
  if (courier === "sameday") {
    const id = Number(ev.code);
    if (Object.hasOwn(SAMEDAY_STATES, id)) return SAMEDAY_STATES[id];
    return byKeywords(ev.text) ?? byKeywords(ev.detail);
  }
  if (courier === "cargus") {
    return byKeywords(ev.text);
  }
  return undefined;
}
