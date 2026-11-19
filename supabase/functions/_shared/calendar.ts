// Purgō: the work calendars in Google Calendar (one each for Jamie, Ryan and Benna).
// The calendars live in the connected Purgō mailbox's Google account; each person's is shared with them.
// Visits booked in the Portal are copied across as events; the Portal is the master copy.
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Europe/London";
export const CAL_SCOPE = "https://www.googleapis.com/auth/calendar";
export const hasCalendar = (scopes: string | null | undefined) => (scopes || "").split(/\s+/).includes(CAL_SCOPE);
export const isDev = () => !/iixqkqkmdholetujuqin/.test(Deno.env.get("SUPABASE_URL") || "");
const portalUrl = () => isDev() ? "https://dev.purgo-quote.pages.dev" : "https://portal.purgo-clean.com";
const SVC: Record<string, string> = { windows: "Window cleaning", gutters: "Gutter clean", roof: "Roof clean", pressure: "Pressure washing", other: "Job" };

async function gcal(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ("Google Calendar error " + r.status)) as Error & { status?: number }; e.status = r.status; throw e; }
  return j;
}
const gone = (e: unknown) => [404, 410].includes((e as { status?: number }).status || 0);

type Cal = { id: string; key: string; name: string; share_with: string | null; gcal_id: string | null; colour: string | null; is_default: boolean };

// make (or find again) each person's calendar, colour it, and share it with them
export async function setupCalendars(db: SupabaseClient, token: string) {
  const { data: cals, error } = await db.from("staff_calendars").select("id,key,name,share_with,gcal_id,colour,is_default").eq("active", true).order("sort");
  if (error) throw error;
  const out: { name: string; gcal_id: string; shared: string | null; made: boolean }[] = [];
  for (const c of (cals || []) as Cal[]) {
    let id = c.gcal_id, made = false;
    if (id) { try { await gcal(token, `/calendars/${encodeURIComponent(id)}`); } catch (e) { if (gone(e)) id = null; else throw e; } }
    if (!id) {
      const cal = await gcal(token, "/calendars", { method: "POST", body: JSON.stringify({ summary: `${isDev() ? "DEV " : ""}Purgō – ${c.name}`, description: "Work booked in the Purgō Portal. Change bookings in the Portal so they stay in step.", timeZone: TZ }) });
      id = cal.id as string; made = true;
      await db.from("staff_calendars").update({ gcal_id: id }).eq("id", c.id);
      // a new calendar: every booking for this person needs sending to it
      await db.from("visits").update({ gcal_dirty: true }).eq("calendar_id", c.id).neq("status", "cancelled");
      await db.from("round_dates").update({ gcal_dirty: true }).eq("calendar_id", c.id).neq("status", "cancelled");
    }
    try { await gcal(token, `/users/me/calendarList/${encodeURIComponent(id!)}?colorRgbFormat=true`, { method: "PATCH", body: JSON.stringify({ backgroundColor: c.colour || "#4a86e8", foregroundColor: "#ffffff", selected: true }) }); } catch { /* colour is cosmetic */ }
    if (c.share_with) await gcal(token, `/calendars/${encodeURIComponent(id!)}/acl?sendNotifications=true`, { method: "POST", body: JSON.stringify({ role: "writer", scope: { type: "user", value: c.share_with } }) });
    out.push({ name: c.name, gcal_id: id!, shared: c.share_with, made });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
function addMinutes(date: string, time: string, mins: number) {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + mins * 60e3);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}
const nextDay = (date: string) => addMinutes(date, "00:00", 1440).slice(0, 10);
const gbp = (n: number) => "£" + (Math.round((+n || 0) * 100) / 100).toFixed(2);

type V = { id: string; round_date_id: string | null; detached: boolean; date: string; start_time: string | null; duration_min: number; calendar_id: string | null; status: string; price: number | null; notes: string | null;
  gcal_event_id: string | null; gcal_calendar: string | null;
  jobs: { job_no: number; service: string; title: string | null; line: string | null; postcode: string | null; notes: string | null; price: number } | null;
  accounts: { name: string; phone: string | null; account_no: number } | null };

function eventFor(v: V) {
  const j = v.jobs, a = v.accounts;
  const tag = v.status === "done" ? "✓ " : v.status === "skipped" ? "Skipped: " : "";
  const where = [j?.line, j?.postcode].filter(Boolean).join(", ");
  const desc = [
    j?.title || null,
    `Price: ${gbp(v.price ?? j?.price ?? 0)}`,
    a?.phone ? `Phone: ${a.phone}` : null,
    j?.notes ? `Access: ${j.notes}` : null,
    v.notes ? `Note: ${v.notes}` : null,
    `${a ? `AC-${a.account_no} · ` : ""}JB-${j?.job_no ?? ""}`,
    `Open in the Portal: ${portalUrl()}/#jobs`,
  ].filter(Boolean).join("\n");
  const ev: Record<string, unknown> = {
    summary: `${tag}${SVC[j?.service || "other"] || "Job"} – ${a?.name || "Customer"}`,
    location: where || undefined,
    description: desc,
    extendedProperties: { private: { purgoVisit: v.id } },
    colorId: v.status === "done" ? "2" : v.status === "skipped" ? "8" : undefined,
    reminders: { useDefault: false, overrides: [] },
  };
  if (v.start_time) {
    const st = v.start_time.slice(0, 5);
    ev.start = { dateTime: `${v.date}T${st}:00`, timeZone: TZ };
    ev.end = { dateTime: addMinutes(v.date, st, v.duration_min || 30), timeZone: TZ };
  } else { ev.start = { date: v.date }; ev.end = { date: nextDay(v.date) }; }
  return ev;
}

// send every changed visit to Google Calendar; remove events for deleted or cancelled visits
export async function syncVisits(db: SupabaseClient, token: string, limit = 150): Promise<{ sent: number; removed: number; failed: number }> {
  let sent = 0, removed = 0, failed = 0;
  const { data: trash } = await db.from("gcal_trash").select("*").order("id").limit(200);
  for (const t of trash || []) {
    try { await gcal(token, `/calendars/${encodeURIComponent(t.gcal_calendar)}/events/${encodeURIComponent(t.gcal_event_id)}`, { method: "DELETE" }); removed++; }
    catch (e) { if (!gone(e)) { failed++; continue; } }
    await db.from("gcal_trash").delete().eq("id", t.id);
  }
  const { data: cals } = await db.from("staff_calendars").select("id,gcal_id,is_default").eq("active", true);
  const byId = new Map((cals || []).map(c => [c.id, c.gcal_id as string | null]));
  const def = (cals || []).find(c => c.is_default)?.gcal_id || null;
  const { data: vs, error } = await db.from("visits")
    .select("id,round_date_id,detached,date,start_time,duration_min,calendar_id,status,price,notes,gcal_event_id,gcal_calendar,jobs(job_no,service,title,line,postcode,notes,price),accounts(name,phone,account_no)")
    .eq("gcal_dirty", true).order("date").limit(limit);
  if (error) throw error;
  for (const v of (vs || []) as unknown as V[]) {
    const target = (v.calendar_id && byId.get(v.calendar_id)) || def;
    try {
      const del = async () => { if (v.gcal_event_id && v.gcal_calendar) { try { await gcal(token, `/calendars/${encodeURIComponent(v.gcal_calendar)}/events/${encodeURIComponent(v.gcal_event_id)}`, { method: "DELETE" }); } catch (e) { if (!gone(e)) throw e; } } };
      // cancelled, no calendar yet, or part of a round (the round date has one event for everyone)
      if (v.status === "cancelled" || !target || (v.round_date_id && !v.detached)) {
        await del(); if (v.gcal_event_id) removed++;
        await db.from("visits").update({ gcal_event_id: null, gcal_calendar: null, gcal_dirty: false, gcal_error: target || (v.round_date_id && !v.detached) ? null : "Calendars not set up yet", gcal_synced_at: new Date().toISOString() }).eq("id", v.id);
        continue;
      }
      const ev = eventFor(v);
      let eid: string | null = null;
      if (v.gcal_event_id && v.gcal_calendar === target) {
        try { const r = await gcal(token, `/calendars/${encodeURIComponent(target)}/events/${encodeURIComponent(v.gcal_event_id)}`, { method: "PUT", body: JSON.stringify(ev) }); eid = r.id; }
        catch (e) { if (!gone(e)) throw e; }
      } else await del();   // moved to someone else's calendar
      if (!eid) { const r = await gcal(token, `/calendars/${encodeURIComponent(target)}/events`, { method: "POST", body: JSON.stringify(ev) }); eid = r.id; }
      await db.from("visits").update({ gcal_event_id: eid, gcal_calendar: target, gcal_dirty: false, gcal_error: null, gcal_synced_at: new Date().toISOString() }).eq("id", v.id);
      sent++;
    } catch (e) {
      failed++;
      await db.from("visits").update({ gcal_error: String((e as Error).message).slice(0, 300) }).eq("id", v.id);
    }
  }
  const r = await syncRoundDates(db, token, byId, def);
  return { sent: sent + r.sent, removed: removed + r.removed, failed: failed + r.failed };
}

const hhmm = (t: string | null) => (t || "").slice(0, 5);
const mins = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

// one event per window round date, listing the customers in driving order
async function syncRoundDates(db: SupabaseClient, token: string, byId: Map<string, string | null>, def: string | null) {
  let sent = 0, removed = 0, failed = 0;
  const { data: rds, error } = await db.from("round_dates")
    .select("id,date,start_time,calendar_id,status,notes,gcal_event_id,gcal_calendar,rounds(name)")
    .eq("gcal_dirty", true).order("date").limit(100);
  if (error) throw error;
  for (const rd of (rds || []) as unknown as { id: string; date: string; start_time: string; calendar_id: string | null; status: string; notes: string | null; gcal_event_id: string | null; gcal_calendar: string | null; rounds: { name: string } | null }[]) {
    const target = (rd.calendar_id && byId.get(rd.calendar_id)) || def;
    const del = async () => { if (rd.gcal_event_id && rd.gcal_calendar) { try { await gcal(token, `/calendars/${encodeURIComponent(rd.gcal_calendar)}/events/${encodeURIComponent(rd.gcal_event_id)}`, { method: "DELETE" }); } catch (e) { if (!gone(e)) throw e; } } };
    try {
      if (rd.status === "cancelled" || !target) {
        await del(); if (rd.gcal_event_id) removed++;
        await db.from("round_dates").update({ gcal_event_id: null, gcal_calendar: null, gcal_dirty: false, gcal_error: null, gcal_synced_at: new Date().toISOString() }).eq("id", rd.id);
        continue;
      }
      const { data: vs } = await db.from("visits").select("start_time,duration_min,status,price,jobs(line,postcode,title,price),accounts(name)")
        .eq("round_date_id", rd.id).eq("detached", false).neq("status", "cancelled").order("start_time", { nullsFirst: false });
      const list = (vs || []) as unknown as { start_time: string | null; duration_min: number; status: string; price: number | null; jobs: { line: string | null; postcode: string | null; title: string | null; price: number } | null; accounts: { name: string } | null }[];
      const st = hhmm(rd.start_time) || "08:30";
      let end = mins(st) + 120;
      for (const v of list) if (v.start_time) end = Math.max(end, mins(hhmm(v.start_time)) + (v.duration_min || 30));
      const total = list.filter(v => v.status !== "skipped").reduce((a, v) => a + (+(v.price ?? v.jobs?.price ?? 0) || 0), 0);
      const name = rd.rounds?.name || "Round";
      const lines = list.map((v, i) => `${i + 1}. ${hhmm(v.start_time)} ${v.accounts?.name || ""} – ${[v.jobs?.line, v.jobs?.postcode].filter(Boolean).join(", ")} – ${gbp(+(v.price ?? v.jobs?.price ?? 0))}${v.status === "done" ? " ✓" : v.status === "skipped" ? " (skipped)" : ""}`);
      const ev = {
        summary: `Window round – ${name}${list.length ? ` (${list.length})` : ""}`,
        description: [list.length ? lines.join("\n") : "No customers on this round yet – add them in the Portal.", list.length ? `\nTotal: ${gbp(total)}` : null, rd.notes ? `Note: ${rd.notes}` : null, `Open in the Portal: ${portalUrl()}/#jobs`].filter(Boolean).join("\n"),
        start: { dateTime: `${rd.date}T${st}:00`, timeZone: TZ },
        end: { dateTime: addMinutes(rd.date, "00:00", Math.min(end, 23 * 60 + 59)), timeZone: TZ },
        extendedProperties: { private: { purgoRoundDate: rd.id } },
        reminders: { useDefault: false, overrides: [] },
      };
      let eid: string | null = null;
      if (rd.gcal_event_id && rd.gcal_calendar === target) {
        try { const r = await gcal(token, `/calendars/${encodeURIComponent(target)}/events/${encodeURIComponent(rd.gcal_event_id)}`, { method: "PUT", body: JSON.stringify(ev) }); eid = r.id; }
        catch (e) { if (!gone(e)) throw e; }
      } else await del();
      if (!eid) { const r = await gcal(token, `/calendars/${encodeURIComponent(target)}/events`, { method: "POST", body: JSON.stringify(ev) }); eid = r.id; }
      await db.from("round_dates").update({ gcal_event_id: eid, gcal_calendar: target, gcal_dirty: false, gcal_error: null, gcal_synced_at: new Date().toISOString() }).eq("id", rd.id);
      sent++;
    } catch (e) {
      failed++;
      await db.from("round_dates").update({ gcal_error: String((e as Error).message).slice(0, 300) }).eq("id", rd.id);
    }
  }
  return { sent, removed, failed };
}
