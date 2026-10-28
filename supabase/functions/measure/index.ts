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
  patio: `The red marker sits ON the hard surface to be measured (a driveway, path, patio or paved yard).
Outline that ONE continuous hard surface as a single closed polygon, and label it (e.g. "Front driveway", "Rear patio").
Follow where the paving physically ends: walls, kerbs, edging, lawn and flower-bed edges, the house wall, the boundary with the pavement or the neighbour's drive.
Include the surface under parked cars. Exclude lawns, beds, buildings, roofs, conservatories, the public pavement and road, and anything belonging to neighbours.
Do not outline other separate areas; the user will measure those separately.`,
  roof: `Outline the ROOF of the TARGET building as one closed polygon following the outer edge of the eaves (the full roof footprint as seen from above).
For a semi-detached or terraced house include ONLY the target property's share of the roof, splitting at the party wall line.
Draw separate polygons for clearly separate roofs on the same property (e.g. "Main roof", "Rear extension", "Garage") and label them. Do not include neighbours' roofs.`,
  gutters: `Trace the GUTTER RUNS of the TARGET building: the eaves edges of each roof slope where a gutter would hang (normally the lower, horizontal edges; not gable verges or ridges).
Draw each continuous gutter run as an open line (type "line") and label it (e.g. "Front eaves", "Rear eaves", "Extension").
For a semi-detached or terraced house include only the target property's share. Do not include neighbours.`,
};

const PROPERTY: Record<string, string> = {
  detached: "The target is a DETACHED house: a building standing on its own. Outline the whole of it.",
  semi: `The target is ONE HALF of a SEMI-DETACHED pair: two houses joined by a shared party wall, usually under what looks like one continuous roof.
Outline ONLY the half containing the red marker. The party wall normally runs front-to-back through the middle of the pair, at right angles to the street, often in line with the chimney stack between the two houses.
Split the roof (and gutters) along that line. The other half belongs to the neighbour and must not be included. As a sanity check, a semi-detached half is usually 35 to 80 m² of roof footprint.`,
  end: `The target is an END-OF-TERRACE house: the last house in a row. Outline ONLY the house containing the red marker, from the free end wall to the first party wall. Do not include the rest of the terrace.`,
  mid: `The target is a MID-TERRACE house: a narrow house with neighbours joined on both sides. Outline ONLY the house containing the red marker, between its two party walls (usually 4 to 6 metres wide along the street). Do not include neighbours.`,
  commercial: "The target is a commercial or non-standard building. Outline the building or area containing the red marker.",
};

function prompt(kind: Kind, mpp: number, property: string) {
  return `You are measuring a property for an exterior cleaning quote in the UK.
The image is a top-down satellite view, ${PX} x ${PX} pixels, north up. Pixel (0,0) is the top-left corner and (${PX},${PX}) the bottom-right.
A small red marker at the centre of the image (pixel ${PX / 2},${PX / 2}) sits on the TARGET property. One pixel is about ${mpp.toFixed(3)} metres.
${PROPERTY[property] ?? ""}

Task:
${TASK[kind]}

Shadows:
- In the UK the sun is to the south, so buildings and trees cast dark shadows towards the north (the top of the image) and slightly east or west.
- A shadow is NOT an edge. Never trace the outline of a shadow. Follow the physical edge of the surface or roof straight through any shadow, using the lines you can see either side of it (walls, kerbs, block borders, gutters, ridge lines) and the shape of the building.
- Dark, shadowed parts of a drive or roof are still part of it.

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

// ---------- photos of a drive or patio (no map; the paving is the ruler) ----------
function photoPrompt(w: number, h: number, hint: string) {
  return `You are helping measure a driveway or patio for an exterior cleaning quote in the UK, from a photo.
The photo is ${w} x ${h} pixels. Pixel (0,0) is the top-left corner. All coordinates you give must be in these pixels.
${hint ? `The user says: "${hint.slice(0, 200)}"\n` : ""}
1. OUTLINE: outline the main driveway / patio / paved area in the photo as one closed polygon, following where the paving physically ends (walls, kerbs, edging, lawn and bed edges, house wall). Include the surface under parked cars. Exclude the public pavement, road, lawns, beds and anything clearly belonging to a neighbour. If part of the drive runs out of shot, follow the photo edge and say so in notes.
2. REFERENCE (the yellow box): mark a rectangle on the ground whose real size you can get by COUNTING blocks or slabs. It sets the scale for the whole photo, so a small box gives big errors: make it as LARGE as you can count reliably, ideally spanning a third or more of the paved area, with its far side reaching well into the area. Never use a single block unless nothing bigger can be counted.
   - Block paving units are 200 x 100 mm. Count along straight lines of joints:
     * stretcher bond / basketweave: count whole blocks along each side.
     * herringbone: the pattern has no long straight joints, so use the straight EDGING course along the drive's border, where blocks are laid in a row. In a soldier course (blocks across the edge) each block shows its 100 mm side along the edge; in a stretcher course (end to end) 200 mm. Put two corners at the ends of a long counted run of edging and the other two the same count of edging blocks along the opposite or adjoining edge, or the depth of a counted run of edging.
   - Slabs: count whole slabs (common sizes 600 x 600, 900 x 600, 450 x 450, 600 x 300 mm), including the joints.
   - Otherwise a manhole or drain cover (usually 450 x 450 or 600 x 450 mm).
   Give the 4 corners IN ORDER around the rectangle, exactly on joints. Report count_12 = how many units along side 1->2 and unit_12_mm = the size of each of those units along that side; likewise count_23 and unit_23_mm for side 2->3; unit_mm = the [length, width] of one block or slab. length_mm = count_12 x unit_12_mm and width_mm = count_23 x unit_23_mm. In "what" say in plain words what you counted, e.g. "14 soldier blocks along the left edge by 8 along the back".
   If no reliable reference is visible, return no reference and say so in notes.
3. COUNT CHECK: separately, estimate the size of the outlined area by counting the blocks, edging blocks or slabs along its edges (how many along the length and across the width, allowing for odd shapes and narrowing). Return count_check with length_m, width_m, area_m2 and "how" (one short sentence, e.g. "about 45 edging blocks (4.5 m) along the left side, about 38 (3.8 m) across the back; tapers at the front"). Do this even if you found a reference; it is used to catch mistakes in the yellow box.
4. Read the surface type, soiling, moss and weeds as best you can, using "unknown" when you cannot tell.
Return your answer only by calling the report_photo tool.`;
}

const PHOTO_TOOL = {
  name: "report_photo",
  description: "Report the outline, the reference rectangle and the condition seen in the photo.",
  input_schema: {
    type: "object",
    properties: {
      label: { type: "string" },
      outline: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
      reference: {
        type: "object",
        properties: {
          corners: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, minItems: 4, maxItems: 4 },
          count_12: { type: "number" },
          unit_12_mm: { type: "number" },
          count_23: { type: "number" },
          unit_23_mm: { type: "number" },
          unit_mm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          length_mm: { type: "number" },
          width_mm: { type: "number" },
          what: { type: "string" },
        },
      },
      count_check: {
        type: "object",
        properties: { length_m: { type: "number" }, width_m: { type: "number" }, area_m2: { type: "number" }, how: { type: "string" } },
      },
      surface: { type: "string", enum: ["block", "concrete", "tarmac", "stone", "imprint", "porcelain", "deck", "gravel", "mixed", "unknown"] },
      soiling: { type: "string", enum: ["light", "normal", "heavy", "unknown"] },
      moss: { type: "string", enum: ["none", "light", "moderate", "heavy", "unknown"] },
      weeds: { type: "string", enum: ["none", "light", "moderate", "heavy", "unknown"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      notes: { type: "string" },
    },
    required: ["outline", "confidence", "notes"],
  },
};

async function askClaude(akey: string, tool: any, content: any[]) {
  const ai = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("PURGO_MEASURE_MODEL") || "claude-sonnet-5-5",
      max_tokens: 3000, tools: [tool], tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!ai.ok) throw new Error(`AI request failed (${ai.status}): ${(await ai.text()).slice(0, 300)}`);
  const out = await ai.json();
  const use = (out.content ?? []).find((c: any) => c.type === "tool_use");
  if (use?.input) return use.input;
  const text = (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

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
    const body = await req.json();
    const { lat, lng, zoom, kind, property } = body;
    if (kind === "photo") {
      const akey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!akey) return reply({ error: "The AI key is not set up yet (ANTHROPIC_API_KEY)." }, 503);
      const { image, mediaType, w, h, hint } = body;
      if (typeof image !== "string" || image.length < 100 || !(w > 0) || !(h > 0)) return reply({ error: "No photo received." }, 400);
      if (image.length > 7_000_000) return reply({ error: "That photo is too large. Try a smaller one." }, 413);
      const r = await askClaude(akey, PHOTO_TOOL, [
        { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
        { type: "text", text: photoPrompt(w, h, String(hint || "")) },
      ]);
      if (!r) return reply({ error: "The AI did not return an outline." }, 502);
      const clip = (p: any) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) ? [Math.min(w, Math.max(0, p[0])), Math.min(h, Math.max(0, p[1]))] : null;
      const outline = (r.outline ?? []).map(clip).filter(Boolean);
      const rf = r.reference || {};
      const num = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
      const L = num(rf.count_12) && num(rf.unit_12_mm) ? rf.count_12 * rf.unit_12_mm : num(rf.length_mm);
      const Wd = num(rf.count_23) && num(rf.unit_23_mm) ? rf.count_23 * rf.unit_23_mm : num(rf.width_mm);
      const ref = Array.isArray(rf.corners) && rf.corners.length === 4 && L > 0 && Wd > 0
        ? { corners: rf.corners.map(clip), length_mm: L, width_mm: Wd, count_12: num(rf.count_12) || null, unit_12_mm: num(rf.unit_12_mm) || null,
            count_23: num(rf.count_23) || null, unit_23_mm: num(rf.unit_23_mm) || null,
            unit_mm: Array.isArray(rf.unit_mm) && rf.unit_mm.length === 2 && rf.unit_mm.every(num) ? rf.unit_mm : null, what: String(rf.what || "") } : null;
      const cc = r.count_check || {};
      const count_check = num(cc.area_m2) ? { area_m2: cc.area_m2, length_m: num(cc.length_m) || null, width_m: num(cc.width_m) || null, how: String(cc.how || "").slice(0, 300) } : null;
      return reply({
        label: String(r.label || "Driveway").slice(0, 60), outline: outline.length >= 3 ? outline : [],
        reference: ref && ref.corners.every(Boolean) ? ref : null, count_check,
        suggestions: { surface: r.surface, soiling: r.soiling, moss: r.moss, weeds: r.weeds },
        confidence: r.confidence, notes: r.notes,
      });
    }
    if (![lat, lng, zoom].every((v) => typeof v === "number" && isFinite(v))) return reply({ error: "Missing map position." }, 400);
    if (!["patio", "roof", "gutters"].includes(kind)) return reply({ error: "Unknown measurement type." }, 400);
    const z = Math.max(17, Math.min(21, Math.round(zoom)));
    const gkey = Deno.env.get("GOOGLE_MAPS_SERVER_KEY"), akey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!gkey || !akey) return reply({ error: "The AI measuring keys are not set up yet (GOOGLE_MAPS_SERVER_KEY and ANTHROPIC_API_KEY)." }, 503);

    const img = await fetch(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${z}&size=${SIZE}x${SIZE}&scale=${SCALE}&maptype=satellite&markers=size:tiny%7Ccolor:red%7C${lat},${lng}&key=${gkey}`);
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
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data } },
          { type: "text", text: prompt(kind as Kind, metresPerPixel(lat, z), String(property || "")) },
        ] }],
      }),
    });
    if (!ai.ok) return reply({ error: `AI request failed (${ai.status}): ${(await ai.text()).slice(0, 300)}` }, 502);
    const out = await ai.json();
    const use = (out.content ?? []).find((c: any) => c.type === "tool_use");
    let r = use?.input;
    if (!r) { // fall back to JSON written as text
      const text = (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      try { r = m ? JSON.parse(m[0]) : null; } catch { r = null; }
    }
    if (!r) return reply({ error: "The AI did not return an outline." }, 502);
    return reply({
      shapes: toShapes(r, lat, lng, z),
      suggestions: { surface: r.surface, soiling: r.soiling, moss: r.moss, roof_covering: r.roof_covering },
      confidence: r.confidence, notes: r.notes, zoom: z,
    });
  } catch (e) {
    return reply({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
