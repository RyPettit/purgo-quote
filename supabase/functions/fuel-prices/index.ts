// Purgō: daily local fuel price from the GOV.UK Fuel Finder API.
// Takes the median diesel (B7) and E10 petrol price at forecourts near base
// (26 Anlaby Park Road South, HU4 7BJ) and saves it as the app's fuel price.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   FUEL_FINDER_CLIENT_ID, FUEL_FINDER_CLIENT_SECRET  from fuel-finder.service.gov.uk
//   PURGO_CRON_KEY                                    any long random string; the daily job sends it
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const API = "https://www.fuel-finder.service.gov.uk";
const BASE = { lat: 53.726587, lng: -0.416505 };
const RADII = [10, 20, 35];        // miles: widen if too few stations report
const MIN_STATIONS = 5;
const MAX_AGE_DAYS = 14;           // ignore prices a forecourt hasn't updated for a fortnight
const DIESEL = ["B7_STANDARD", "B7_Standard", "B7"];
const PETROL = ["E10"];

function miles(lat1: number, lng1: number, lat2: number, lng2: number) {
  const p = Math.PI / 180, R = 3958.8;
  const x = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lng2 - lng1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function token(fetchFn: typeof fetch, id: string, secret: string) {
  const r = await fetchFn(`${API}/api/v1/oauth/generate_access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error(`Fuel Finder login failed (${r.status}). Check the client ID and secret.`);
  const j = await r.json();
  const d = j.data ?? j;
  if (!d.access_token) throw new Error("Fuel Finder login returned no token.");
  return `${d.token_type || "Bearer"} ${d.access_token}`;
}

async function allBatches(fetchFn: typeof fetch, auth: string, path: string) {
  const out: any[] = [];
  for (let batch = 1; batch <= 60; batch++) {
    let r: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await fetchFn(`${API}${path}?batch-number=${batch}`, { headers: { Authorization: auth } }); break; }
      catch (e) { if (attempt === 2) throw e; await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); }
    }
    if (!r || r.status === 404) break;
    if (!r.ok) throw new Error(`Fuel Finder ${path} batch ${batch} failed (${r.status}).`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.data) ? j.data.data : []));
    if (!rows.length) break;
    out.push(...rows);
  }
  return out;
}

export async function localFuelPrices(fetchFn: typeof fetch, id: string, secret: string, now = new Date()) {
  const auth = await token(fetchFn, id, secret);
  const stations = await allBatches(fetchFn, auth, "/api/v1/pfs");
  const dist = new Map<string, number>();
  for (const s of stations) {
    const lat = Number(s?.location?.latitude), lng = Number(s?.location?.longitude);
    if (!s?.node_id || !isFinite(lat) || !isFinite(lng) || s.permanent_closure || s.temporary_closure) continue;
    const d = miles(BASE.lat, BASE.lng, lat, lng);
    if (d <= RADII[RADII.length - 1]) dist.set(s.node_id, d);
  }
  if (!dist.size) throw new Error(`No open forecourts found near base (${stations.length} stations downloaded).`);
  const prices = await allBatches(fetchFn, auth, "/api/v1/pfs/fuel-prices");
  const cutoff = now.getTime() - MAX_AGE_DAYS * 864e5;
  const found: { d: number; fuel: "diesel" | "petrol"; p: number }[] = [];
  for (const s of prices) {
    const d = dist.get(s?.node_id); if (d === undefined) continue;
    for (const f of s.fuel_prices ?? []) {
      const fuel = DIESEL.includes(f.fuel_type) ? "diesel" : PETROL.includes(f.fuel_type) ? "petrol" : null;
      if (!fuel || f.price == null) continue;
      let p = Number(f.price); if (!isFinite(p)) continue;
      if (p < 10) p = p * 100;                     // tolerate £/L
      if (p < 100 || p > 320) continue;            // reject obvious errors (pence per litre)
      const t = Date.parse(f.price_last_updated ?? f.price_change_effective_timestamp ?? "");
      if (isFinite(t) && t < cutoff) continue;
      found.push({ d, fuel, p });
    }
  }
  const pick = (fuel: "diesel" | "petrol") => {
    for (const r of RADII) {
      const xs = found.filter(x => x.fuel === fuel && x.d <= r).map(x => x.p);
      if (xs.length >= MIN_STATIONS || r === RADII[RADII.length - 1]) return xs.length ? { pence: median(xs), n: xs.length, radius: r } : null;
    }
    return null;
  };
  const diesel = pick("diesel"), petrol = pick("petrol");
  if (!diesel) throw new Error("No diesel prices reported near base.");
  return { diesel, petrol, stationsNear: dist.size };
}

function db() {
  const url = Deno.env.get("SUPABASE_URL");
  let svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!svc) { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); svc = Object.values(k)[0] as string ?? ""; } catch { /* ignore */ } }
  if (!url || !svc) throw new Error("Supabase URL or service key missing from the function environment.");
  const headers: Record<string, string> = { apikey: svc, "Content-Type": "application/json" };
  if (svc.startsWith("eyJ")) headers.Authorization = `Bearer ${svc}`;
  return { url, headers };
}
async function getSetting(key: string) {
  const { url, headers } = db();
  const r = await fetch(`${url}/rest/v1/settings?key=eq.${key}&select=value`, { headers });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0]?.value ?? null;
}
async function saveSetting(key: string, value: unknown) {
  const { url, headers: base } = db();
  const headers = { ...base, Prefer: "resolution=merge-duplicates" };
  const r = await fetch(`${url}/rest/v1/settings?on_conflict=key`, {
    method: "POST", headers, body: JSON.stringify({ key, value, updated_at: new Date().toISOString(), updated_by: null }),
  });
  if (!r.ok) throw new Error(`Saving ${key} failed (${r.status}): ${await r.text()}`);
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(async (req) => {
  const want = Deno.env.get("PURGO_CRON_KEY");
  if (!want || req.headers.get("x-purgo-key") !== want) return new Response("Not allowed", { status: 401 });
  const today = new Date().toISOString().slice(0, 10);
  try {
    const id = Deno.env.get("FUEL_FINDER_CLIENT_ID"), secret = Deno.env.get("FUEL_FINDER_CLIENT_SECRET");
    if (!id || !secret) throw new Error("Fuel Finder client ID and secret are not set.");
    const r = await localFuelPrices(fetch, id, secret);
    const value: Record<string, unknown> = {
      diesel: Math.round(r.diesel.pence * 10) / 1000,
      date: today,
      source: `local median, ${r.diesel.n} forecourts within ${r.diesel.radius} miles (GOV.UK Fuel Finder)`,
      auto: true,
    };
    if (r.petrol) value.petrol = Math.round(r.petrol.pence * 10) / 1000;
    else value.petrol = (await getSetting("fuel"))?.petrol ?? 1.741; // keep the last known petrol price
    await saveSetting("fuel", value);
    await saveSetting("fuel_status", { ok: true, at: new Date().toISOString(), message: `Diesel ${value.diesel}, petrol ${value.petrol ?? "unchanged"}` });
    return Response.json({ ok: true, ...value, petrolStations: r.petrol?.n ?? 0 });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    try { await saveSetting("fuel_status", { ok: false, at: new Date().toISOString(), message }); } catch { /* ignore */ }
    return Response.json({ ok: false, message }, { status: 500 });
  }
});
