// Purgō: AI outline of a patio/drive, roof or gutter run on a satellite image.
// The app sends the map centre and zoom; this function fetches the same satellite
// view from Google, asks Claude to outline the target, converts the outline from
// image pixels to map coordinates and returns it for the user to adjust.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY        from console.anthropic.com
//   GOOGLE_MAPS_SERVER_KEY   Google key restricted to the Maps Static API
// Optional:
//   PURGO_MEASURE_MODEL      defaults to claude-sonnet-5-5
//
// Turn "Verify JWT" OFF for this function. It checks the caller itself: the request must
// carry a signed-in Purgō user whose staff account is switched on.

const SIZE = 640;   // Static Maps logical size (max 640)
const SCALE = 2;    // returns a 1280 x 1280 image
const PX = SIZE * SCALE;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Kind = "patio" | "roof" | "gutters";

// image pixel (0..PX) -> [lat, lng] for a Static Maps image centred on (clat, clng)
export function pxToLatLng(px: number, py: number, clat: number, clng: number, zoom: number, size = SIZE, scale = SCALE): [number, number] {
  const world = 256 * 2 ** zoom;
  const cx = (clng + 180) / 360 * world;
  const s = Math.sin(clat * Math.PI / 180);
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  const wx = cx + (px / scale - size / 2);
  const wy = cy + (py / scale - size / 2);
  const lng = wx / world * 360 - 180;
  const n = Math.PI - 2 * Math.PI * wy / world;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lng];
}

export function metresPerPixel(lat: number, zoom: number, scale = SCALE) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom / scale;
}

const TASK: Record<Kind, string> = {
  patio: `Outline the hard-standing surfaces belonging to the TARGET property: driveway, paths, patios and paved yards (block paving, concrete, tarmac, stone, gravel).
Draw one closed polygon per separate area (e.g. "Front driveway", "Rear patio", "Side path").
Include the surface under parked cars. Exclude lawns, flower beds, buildings, roofs, conservatories, the public pavement and road, and anything belonging to neighbours.`,
  roof: `Outline the ROOF of the TARGET building as one closed polygon following the outer edge of the eaves (the full roof footprint as seen from above).
For a semi-detached or terraced house include ONLY the target property's share of the roof, splitting at the party wall line.
Draw separate polygons for clearly separate roofs on the same property (e.g. "Main roof", "Rear extension", "Garage") and label them. Do not include neighbours' roofs.`,
  gutters: `Trace the GUTTER RUNS of the TARGET building: the eaves edges of each roof slope where a gutter would hang (normally the lower, horizontal edges; not gable verges or ridges).
Draw each continuous gutter run as an open line (type "line") and label it (e.g. "Front eaves", "Rear eaves", "Extension").
For a semi-detached or terraced house include only the target property's share. Do not include neighbours.`,
};

function prompt(kind: Kind, mpp: number) {
  return `You are measuring a property for an exterior cleaning quote in the UK.
The image is a top-down satellite view, ${PX} x ${PX} pixels, north up. Pixel (0,0) is the top-left corner and (${PX},${PX}) the bottom-right.
The TARGET property is the one at or nearest the centre of the image (pixel ${PX / 2},${PX / 2}). One pixel is about ${mpp.toFixed(3)} metres.

Task:
${TASK[kind]}

Rules:
- Give corner points in pixel coordinates, in order around the shape. Use as few points as describe the shape accurately (usually 4 to 12). Put points exactly on the visible edges.
- If something is hidden by trees or shadow, follow the most likely edge and say so in notes.
- If you cannot find the target at all, return no shapes and explain in notes.
- Also give your best read of the surface type, soiling level, moss level and roof covering where visible, using "unknown" when you cannot tell.
Return your answer only by calling the report_outline tool.`;
}

const TOOL = {
  name: "report_outline",
  description: "Report the outline(s) found in the satellite image.",
  input_schema: {
    type: "object",
    properties: {
      shapes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            type: { type: "string", enum: ["area", "line"] },
            points: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, minItems: 2 },
          },
          required: ["label", "type", "points"],
        },
      },
      surface: { type: "string", enum: ["block", "concrete", "tarmac", "stone", "imprint", "porcelain", "deck", "gravel", "mixed", "unknown"] },
      soiling: { type: "string", enum: ["light", "normal", "heavy", "unknown"] },
      moss: { type: "string", enum: ["light", "moderate", "heavy", "unknown"] },
      roof_covering: { type: "string", enum: ["concrete", "clay", "slate", "flat", "other", "unknown"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      notes: { type: "string" },
    },
    required: ["shapes", "confidence", "notes"],
  },
};

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function toShapes(input: any, lat: number, lng: number, zoom: number) {
  const out: { label: string; type: "area" | "line"; points: [number, number][] }[] = [];
  for (const s of input?.shapes ?? []) {
    const pts = (s.points ?? []).filter((p: any) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
      .map((p: number[]) => [Math.min(PX, Math.max(0, p[0])), Math.min(PX, Math.max(0, p[1]))]);
    const type = s.type === "line" ? "line" : "area";
    if (pts.length < (type === "line" ? 2 : 3)) continue;
    out.push({ label: String(s.label || (type === "line" ? "Gutter run" : "Area")).slice(0, 60), type, points: pts.map((p: number[]) => pxToLatLng(p[0], p[1], lat, lng, zoom)) });
  }
  return out;
}

// Only active Purgō staff may use this (it spends money on Google and the AI).
async function checkUser(req: Request): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const auth = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !auth.toLowerCase().startsWith("bearer ")) return "Please sign in again.";
  const u = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!u.ok) return "Please sign in again.";
  const user = await u.json();
  // read the caller's own profile with their own token; the database rules do the rest
  const p = await fetch(`${url}/rest/v1/profiles?id=eq.${user.id}&select=active`, { headers: { Authorization: auth, apikey } });
  const rows = p.ok ? await p.json() : [];
  if (!rows?.[0]?.active) return "Your account is not active.";
  return null;
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const denied = await checkUser(req);
    if (denied) return reply({ error: denied }, 401);
    const { lat, lng, zoom, kind } = await req.json();
    if (![lat, lng, zoom].every((v) => typeof v === "number" && isFinite(v))) return reply({ error: "Missing map position." }, 400);
    if (!["patio", "roof", "gutters"].includes(kind)) return reply({ error: "Unknown measurement type." }, 400);
    const z = Math.max(17, Math.min(21, Math.round(zoom)));
    const gkey = Deno.env.get("GOOGLE_MAPS_SERVER_KEY"), akey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!gkey || !akey) return reply({ error: "The AI measuring keys are not set up yet (GOOGLE_MAPS_SERVER_KEY and ANTHROPIC_API_KEY)." }, 503);

    const img = await fetch(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${z}&size=${SIZE}x${SIZE}&scale=${SCALE}&maptype=satellite&key=${gkey}`);
    if (!img.ok) return reply({ error: `Satellite image failed (${img.status}). Check the Google key allows the Maps Static API.` }, 502);
    const mediaType = (img.headers.get("content-type") || "image/png").split(";")[0];
    const data = toBase64(await img.arrayBuffer());

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("PURGO_MEASURE_MODEL") || "claude-sonnet-5-5",
        max_tokens: 2000,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "report_outline" },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: prompt(kind as Kind, metresPerPixel(lat, z)) },
        ] }],
      }),
    });
    if (!ai.ok) return reply({ error: `AI request failed (${ai.status}): ${(await ai.text()).slice(0, 300)}` }, 502);
    const out = await ai.json();
    const use = (out.content ?? []).find((c: any) => c.type === "tool_use");
    if (!use) return reply({ error: "The AI did not return an outline." }, 502);
    const r = use.input;
    return reply({
      shapes: toShapes(r, lat, lng, z),
      suggestions: { surface: r.surface, soiling: r.soiling, moss: r.moss, roof_covering: r.roof_covering },
      confidence: r.confidence, notes: r.notes, zoom: z,
    });
  } catch (e) {
    return reply({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
