// Purgō: scheduled customer messages. Turn "Verify JWT" OFF (the 10-minute run has no Portal login; callers are checked here).
//   {action:"run"}  (x-purgo-key)        -> emails tomorrow's appointment reminders once it's past the send time in Admin → Reminders
//   {action:"test", key, subject, body}  admin -> sends that template, filled with example details, to the signed-in admin
// Messages come from public.message_templates and public.business_profile (see supabase/messages.sql).
import { cors, reply, serviceClient, trySend, SIG_HTML, cleanEmails } from "../_shared/gmail.ts";
import { getBusiness, getTemplate, businessVars, fill, firstName, textToHtml, ukNow, longDate } from "../_shared/messages.ts";

type Db = ReturnType<typeof serviceClient>;
const SVC: Record<string, string> = { windows: "Window cleaning", gutters: "Gutter clean", roof: "Roof clean", pressure: "Pressure washing" };
const hm = (t: string | null) => t ? t.slice(0, 5) : "";
const timeText = (t: string | null) => t ? `around ${hm(t)}` : "during the day";

async function who(db: Db, req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: p } = await db.from("profiles").select("name,role,active").eq("id", data.user.id).maybeSingle();
  return p && p.active && (p.role === "admin" || p.role === "staff") ? { id: data.user.id, email: data.user.email || "", name: p.name as string, admin: p.role === "admin" } : null;
}

async function send(db: Db, to: string[], subject: string, text: string) {
  const sent = await trySend(db, { fromName: (await getBusiness(db)).trading_name, to, subject,
    html: `<div style="font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;color:#132f47;font-size:15px;line-height:1.5;max-width:600px">${textToHtml(text)}${SIG_HTML}</div>`, text });
  if (!sent) throw new Error("Email isn't connected to the Portal yet (Admin → Email).");
  return sent;
}

/* ---------- the day-before appointment reminder ---------- */
async function visitReminders(db: Db) {
  const t = await getTemplate(db, "visit_reminder");
  if (!t || !t.enabled) return { sent: 0, why: "off" };
  const now = ukNow(), hour = t.send_hour ?? 16;
  if (now.hour < hour || now.hour >= 21) return { sent: 0, why: "not time yet" };   // and never late in the evening
  const tomorrow = ukNow(1).day;
  const { data: vs, error } = await db.from("visits")
    .select("id,date,start_time,account_id,jobs(title,service,line,postcode)")
    .eq("date", tomorrow).eq("status", "booked").is("reminder_sent_at", null).limit(500);
  if (error) throw error;
  const byAcc = new Map<string, any[]>();
  for (const v of vs || []) { if (!v.account_id) continue; (byAcc.get(v.account_id) || byAcc.set(v.account_id, []).get(v.account_id)!).push(v); }
  const B = businessVars(await getBusiness(db));
  let sent = 0, skipped = 0;
  for (const [accId, list] of byAcc) {
    const { data: a } = await db.from("accounts").select("id,name,kind,email,no_reminders,status").eq("id", accId).maybeSingle();
    const { data: pc } = await db.from("account_contacts").select("name,email").eq("account_id", accId).eq("is_primary", true).limit(1).maybeSingle();
    const to = cleanEmails(a?.email || pc?.email || "");
    if (!a || a.no_reminders || !to.length) { skipped++; await db.from("visits").update({ reminder_sent_at: new Date().toISOString() }).in("id", list.map(v => v.id)); continue; }
    list.sort((x, y) => (x.start_time || "99").localeCompare(y.start_time || "99"));
    const line = (v: any) => { const j = v.jobs || {}; return `• ${SVC[j.service] || j.title || "Your visit"}${j.line ? ` at ${j.line}` : ""}, ${timeText(v.start_time)}`; };
    const first = list[0], j0 = first.jobs || {};
    const vars = { ...B, first_name: firstName(a.name, a.kind, pc?.name), customer_name: a.name, date: longDate(tomorrow), time: timeText(first.start_time),
      service: SVC[j0.service] || j0.title || "your visit", address: [j0.line, j0.postcode].filter(Boolean).join(", "), visit_list: list.map(line).join("\n") };
    const subject = fill(t.subject || "Reminder: your visit tomorrow", vars), body = fill(t.body, vars);
    try {
      const s = await send(db, to, subject, body);
      await db.from("visits").update({ reminder_sent_at: new Date().toISOString() }).in("id", list.map(v => v.id));
      await db.from("account_comms").insert({ account_id: accId, kind: "email", direction: "out", subject, body: body.slice(0, 6000), from_addr: s.from, to_addr: to.join(", "),
        message_id: s.id, thread_id: s.threadId, created_by_name: "Auto reminder", meta: { via: "gmail", reminder: "visit", date: tomorrow } });
      sent++;
    } catch (e) { console.error("visit reminder", accId, (e as Error).message); }
  }
  return { sent, skipped };
}

/* ---------- example details for a test send ---------- */
const SAMPLE: Record<string, string> = {
  first_name: "Sam", customer_name: "Sam Smith", date: "Friday 27 November", time: "around 10:30", service: "Window cleaning", address: "12 Example Road, Hull",
  visit_list: "• Window cleaning at 12 Example Road, around 10:30\n• Gutter clean at 12 Example Road, around 11:00",
  invoice_no: "INV-1000", amount_due: "£45.00", total: "£45.00", work_date: "24 November 2026", due_date: "8 December 2026",
  how_to_pay: "You can pay by card using the button below, or by bank transfer using the details below.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = serviceClient();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "run") {
      const { data: c } = await db.from("accounting_connection").select("cron_key").eq("id", 1).maybeSingle();
      const key = req.headers.get("x-purgo-key");
      if (!(c?.cron_key && key && key === c.cron_key) && !(await who(db, req))) return reply({ error: "Not allowed" }, 401);
      return reply({ visits: await visitReminders(db) });
    }
    const me = await who(db, req);
    if (!me) return reply({ error: "Please sign in again." }, 401);
    if (action === "test") {
      if (!me.admin) return reply({ error: "Only the admin can do this." }, 403);
      const t = await getTemplate(db, String(body.key || ""));
      if (!t) return reply({ error: "Unknown message" }, 400);
      const to = cleanEmails(me.email);
      if (!to.length) return reply({ error: "Your login has no email address to send the test to." }, 400);
      const vars = { ...businessVars(await getBusiness(db)), ...SAMPLE };
      const subject = "[Test] " + fill(body.subject ?? t.subject ?? "", vars), text = fill(body.body ?? t.body, vars);
      await send(db, to, subject, text);
      return reply({ sent: true, to: to[0] });
    }
    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: (e as Error).message || String(e) }, 500);
  }
});
