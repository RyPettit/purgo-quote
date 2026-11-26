// Purgō: scheduled customer messages. Turn "Verify JWT" OFF (the 10-minute run has no Portal login; callers are checked here).
//   {action:"run"}  (x-purgo-key)        -> emails tomorrow's appointment reminders once it's past the send time in Admin → Reminders
//   {action:"test", key, subject, body, phone}  admin -> sends that template, filled with example details, to the signed-in admin
//                                               (by email, or for a text message to the phone number given)
//   {action:"status"}                        -> {sms:{configured, provider}}
//   Also on each run: review requests, "due again" prompts and win-backs (Admin → Reviews & repeat work).
// Customers (no login, by the token in their link, see f.html):
//   {action:"fb_view", token} -> what the page shows · {action:"fb_rate", token, rating, comment} · {action:"fb_google", token}
//   {action:"mk_reply", token, answer:"yes"|"no", note}
// Messages come from public.message_templates and public.business_profile (see supabase/messages.sql).
import { cors, reply, serviceClient, trySend, SIG_HTML, cleanEmails } from "../_shared/gmail.ts";
import { getBusiness, getTemplate, businessVars, fill, firstName, textToHtml, ukNow, longDate, fmtDate, portalUrl } from "../_shared/messages.ts";
import type { Business } from "../_shared/messages.ts";
import { sendSms, smsConfigured, smsProvider, ukMobile } from "../_shared/sms.ts";

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

/* ---------- the day-before appointment reminder (email, text or both, as chosen on the account) ---------- */
async function visitReminders(db: Db) {
  const t = await getTemplate(db, "visit_reminder"), ts = await getTemplate(db, "visit_reminder_sms");
  const emailOn = !!(t && t.enabled), smsOn = !!(ts && ts.enabled && smsConfigured());
  if (!emailOn && !smsOn) return { sent: 0, why: "off" };
  const now = ukNow(), hour = t?.send_hour ?? 16;             // texts go at the same time as the emails
  if (now.hour < hour || now.hour >= 21) return { sent: 0, why: "not time yet" };   // and never late in the evening
  const tomorrow = ukNow(1).day;
  const { data: vs, error } = await db.from("visits")
    .select("id,date,start_time,account_id,jobs(title,service,line,postcode)")
    .eq("date", tomorrow).eq("status", "booked").is("reminder_sent_at", null).limit(500);
  if (error) throw error;
  const byAcc = new Map<string, any[]>();
  for (const v of vs || []) { if (!v.account_id) continue; (byAcc.get(v.account_id) || byAcc.set(v.account_id, []).get(v.account_id)!).push(v); }
  const biz = await getBusiness(db), B = businessVars(biz);
  let emails = 0, texts = 0, skipped = 0;
  for (const [accId, list] of byAcc) {
    const done = () => db.from("visits").update({ reminder_sent_at: new Date().toISOString() }).in("id", list.map(v => v.id));
    const { data: a } = await db.from("accounts").select("id,name,kind,email,phone,no_reminders,remind_by").eq("id", accId).maybeSingle();
    const { data: pc } = await db.from("account_contacts").select("name,email,phone").eq("account_id", accId).eq("is_primary", true).limit(1).maybeSingle();
    const how = !a || a.no_reminders ? "none" : (a.remind_by || "email");
    const to = cleanEmails(a?.email || pc?.email || ""), mob = ukMobile(a?.phone) || ukMobile(pc?.phone);
    const wantEmail = emailOn && (how === "email" || how === "both") && to.length > 0;
    const wantSms = smsOn && (how === "sms" || how === "both") && !!mob;
    if (!wantEmail && !wantSms) { skipped++; await done(); continue; }
    list.sort((x, y) => (x.start_time || "99").localeCompare(y.start_time || "99"));
    const line = (v: any) => { const j = v.jobs || {}; return `• ${SVC[j.service] || j.title || "Your visit"}${j.line ? ` at ${j.line}` : ""}, ${timeText(v.start_time)}`; };
    const first = list[0], j0 = first.jobs || {};
    const svcs = [...new Set(list.map(v => (SVC[(v.jobs || {}).service] || (v.jobs || {}).title || "your visit")))];
    const vars = { ...B, first_name: firstName(a!.name, a!.kind, pc?.name), customer_name: a!.name, date: longDate(tomorrow), time: timeText(first.start_time),
      service: svcs.length > 1 ? svcs.slice(0, -1).join(", ") + " and " + svcs[svcs.length - 1] : svcs[0], address: j0.line || j0.postcode || "",
      visit_list: list.map(line).join("\n") };
    let ok = 0;   // retried on the next run (until 9pm) if nothing went
    if (wantEmail) {
      const subject = fill(t!.subject || "Reminder: your visit tomorrow", vars), body = fill(t!.body, vars);
      try {
        const s = await send(db, to, subject, body);
        await db.from("account_comms").insert({ account_id: accId, kind: "email", direction: "out", subject, body: body.slice(0, 6000), from_addr: s.from, to_addr: to.join(", "),
          message_id: s.id, thread_id: s.threadId, created_by_name: "Auto reminder", meta: { via: "gmail", reminder: "visit", date: tomorrow } });
        emails++; ok++;
      } catch (e) { console.error("visit reminder email", accId, (e as Error).message); }
    }
    if (wantSms) {
      const text = fill(ts!.body, vars);
      try {
        const r = await sendSms(mob, text, biz.sms_sender || biz.trading_name);
        await db.from("account_comms").insert({ account_id: accId, kind: "sms", direction: "out", subject: "Appointment reminder (text)", body: text, to_addr: "+" + mob,
          created_by_name: "Auto reminder", meta: { via: r.provider, id: r.id, reminder: "visit", date: tomorrow } });
        texts++; ok++;
      } catch (e) { console.error("visit reminder text", accId, (e as Error).message); }
    }
    if (ok) await done();
  }
  return { emails, texts, skipped };
}

/* ---------- reviews and repeat work ---------- */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const svcName = (j: any) => (SVC[(j || {}).service] || (j || {}).title || "visit").toLowerCase().replace(/^window cleaning$/, "window clean");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const addMonths = (d: string, m: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
type Acc = { id: string; name: string; kind: string; email: string | null; phone: string | null; no_reminders: boolean; remind_by: string | null };

// send one message to a customer by email and/or text, as their account says; true if anything went
async function reach(db: Db, biz: Business, a: Acc, key: string, vars: Record<string, string>, label: string, meta: Record<string, unknown>) {
  const how = a.no_reminders ? "none" : (a.remind_by || "email");
  const to = cleanEmails(a.email || ""), mob = ukMobile(a.phone);
  const te = (how === "email" || how === "both") && to.length ? await getTemplate(db, key) : null;
  const ts = (how === "sms" || how === "both") && mob && smsConfigured() ? await getTemplate(db, key + "_sms") : null;
  const channels: string[] = [];
  if (te && te.enabled) {
    const subject = fill(te.subject || label, vars), body = fill(te.body, vars);
    try {
      const s = await send(db, to, subject, body);
      await db.from("account_comms").insert({ account_id: a.id, kind: "email", direction: "out", subject, body: body.slice(0, 6000), from_addr: s.from, to_addr: to.join(", "),
        message_id: s.id, thread_id: s.threadId, created_by_name: "Auto", meta: { via: "gmail", ...meta } });
      channels.push("email");
    } catch (e) { console.error(label, "email", a.id, (e as Error).message); }
  }
  if (ts && ts.enabled) {
    const text = fill(ts.body, vars);
    try {
      const r = await sendSms(mob, text, biz.sms_sender || biz.trading_name);
      await db.from("account_comms").insert({ account_id: a.id, kind: "sms", direction: "out", subject: label + " (text)", body: text, to_addr: "+" + mob,
        created_by_name: "Auto", meta: { via: r.provider, id: r.id, ...meta } });
      channels.push("sms");
    } catch (e) { console.error(label, "text", a.id, (e as Error).message); }
  }
  return channels.join("+");
}
const ACC = "id,name,kind,email,phone,no_reminders,remind_by";
const okHours = (now: ReturnType<typeof ukNow>, from = 10) => now.weekday !== "Sun" && now.hour >= from && now.hour < 19;

async function reviewRequests(db: Db, M: any, biz: Business) {
  const now = ukNow();
  if (!M.review_on || !okHours(now, M.review_hour ?? 10)) return 0;
  const since = new Date(Math.max(Date.parse(M.review_since || 0) || 0, Date.now() - 10 * 864e5)).toISOString();
  // jobs done since reviews were switched on, the day after (or later)
  const { data: vs } = await db.from("visits").select("id,date,account_id,done_at,jobs(title,service)").eq("status", "done").gte("done_at", since).lt("date", now.day).order("date", { ascending: false }).limit(300);
  const seen = new Set<string>(); let sent = 0;
  for (const v of vs || []) {
    if (!v.account_id || seen.has(v.account_id) || sent >= 20) continue;
    seen.add(v.account_id);
    const gap = new Date(Date.now() - (M.review_gap_days || 180) * 864e5).toISOString();
    const { data: prev } = await db.from("feedback").select("id").eq("account_id", v.account_id).gte("created_at", gap).limit(1);
    if (prev && prev.length) continue;
    const { data: a } = await db.from("accounts").select(ACC).eq("id", v.account_id).maybeSingle();
    if (!a) continue;
    const { data: fb, error } = await db.from("feedback").insert({ account_id: a.id, visit_id: v.id, service: svcName(v.jobs) }).select("id,token").single();
    if (error || !fb) continue;
    const vars = { ...businessVars(biz), first_name: firstName(a.name, a.kind), customer_name: a.name, service: svcName(v.jobs), date: fmtDate(v.date), link: `${portalUrl(biz)}/f?t=${fb.token}` };
    const ch = await reach(db, biz, a as Acc, "review_request", vars, "How did we do?", { growth: "review" });
    if (ch) { await db.from("feedback").update({ channel: ch, sent_at: new Date().toISOString() }).eq("id", fb.id); sent++; }
    else await db.from("feedback").update({ channel: "none" }).eq("id", fb.id);   // nobody to send to: don't try again for this gap
  }
  return sent;
}

// last done date of each service per account (from done visits), and what's still booked or recurring
async function history(db: Db) {
  const { data: done } = await db.from("visits").select("account_id,date,jobs(service,title)").eq("status", "done").gte("date", addMonths(ukNow().day, -48)).limit(5000);
  const { data: booked } = await db.from("visits").select("account_id,jobs(service)").eq("status", "booked").gte("date", ukNow().day).limit(5000);
  const { data: recur } = await db.from("jobs").select("account_id,service,frequency_weeks,monthly,status").eq("status", "active").limit(5000);
  const last: Record<string, Record<string, string>> = {}, any: Record<string, string> = {};
  for (const v of done || []) {
    const s = (v.jobs as any)?.service || "other";
    (last[v.account_id] = last[v.account_id] || {});
    if (!last[v.account_id][s] || last[v.account_id][s] < v.date) last[v.account_id][s] = v.date;
    if (!any[v.account_id] || any[v.account_id] < v.date) any[v.account_id] = v.date;
  }
  const busy = new Set<string>(), busyAcc = new Set<string>();
  for (const v of booked || []) { busy.add(v.account_id + ":" + ((v.jobs as any)?.service || "other")); busyAcc.add(v.account_id); }
  for (const j of recur || []) { if (j.frequency_weeks || j.monthly) { busy.add(j.account_id + ":" + j.service); busyAcc.add(j.account_id); } }
  return { last, any, busy, busyAcc };
}

async function repeatPrompts(db: Db, M: any, biz: Business, H: Awaited<ReturnType<typeof history>>) {
  const now = ukNow();
  if (!M.repeat_on || !okHours(now)) return 0;
  const months: Record<string, number> = M.repeat_months || {};
  let sent = 0;
  for (const [accId, bySvc] of Object.entries(H.last)) {
    for (const [svc, lastDate] of Object.entries(bySvc)) {
      const m = +months[svc] || 0; if (!m || sent >= 20) continue;
      const due = addMonths(lastDate, m);
      if (due > now.day || daysBetween(due, now.day) > 90) continue;      // due, but not long ago (older ones are win-back territory)
      if (H.busy.has(accId + ":" + svc)) continue;                          // already booked or on a round
      const { data: prev } = await db.from("marketing_sends").select("id").eq("account_id", accId).eq("kind", "repeat").eq("service", svc).gte("created_at", lastDate + "T00:00:00Z").limit(1);
      if (prev && prev.length) continue;
      const { data: a } = await db.from("accounts").select(ACC).eq("id", accId).maybeSingle();
      if (!a) continue;
      const label = (SVC[svc] || svc).toLowerCase().replace(/^window cleaning$/, "window clean");
      const { data: ms, error } = await db.from("marketing_sends").insert({ kind: "repeat", account_id: accId, service: svc, last_date: lastDate }).select("id,token").single();
      if (error || !ms) continue;
      const vars = { ...businessVars(biz), first_name: firstName(a.name, a.kind), customer_name: a.name, service: label, last_date: fmtDate(lastDate), link: `${portalUrl(biz)}/f?t=${ms.token}` };
      const ch = await reach(db, biz, a as Acc, "repeat_prompt", vars, `Time for your ${label} again?`, { growth: "repeat", service: svc });
      await db.from("marketing_sends").update({ channel: ch || "none", sent_at: ch ? new Date().toISOString() : null }).eq("id", ms.id);
      if (ch) sent++;
    }
  }
  return sent;
}

async function winBacks(db: Db, M: any, biz: Business, H: Awaited<ReturnType<typeof history>>) {
  const now = ukNow();
  if (!M.winback_on || !okHours(now)) return 0;
  const cutoff = addMonths(now.day, -(M.winback_months || 6));
  let sent = 0;
  for (const [accId, lastDate] of Object.entries(H.any)) {
    if (sent >= 20 || lastDate > cutoff || H.busyAcc.has(accId)) continue;
    const { data: prev } = await db.from("marketing_sends").select("id,kind,created_at").eq("account_id", accId).gte("created_at", new Date(Date.now() - 365 * 864e5).toISOString()).limit(5);
    if ((prev || []).some(p => p.kind === "winback" || Date.parse(p.created_at) > Date.now() - 60 * 864e5)) continue;
    const { data: a } = await db.from("accounts").select(ACC + ",status").eq("id", accId).maybeSingle();
    if (!a || (a as any).status === "archived") continue;
    const { data: ms, error } = await db.from("marketing_sends").insert({ kind: "winback", account_id: accId, last_date: lastDate }).select("id,token").single();
    if (error || !ms) continue;
    const vars = { ...businessVars(biz), first_name: firstName(a.name, a.kind), customer_name: a.name, last_date: fmtDate(lastDate), link: `${portalUrl(biz)}/f?t=${ms.token}` };
    const ch = await reach(db, biz, a as Acc, "win_back", vars, "We've missed you", { growth: "winback" });
    await db.from("marketing_sends").update({ channel: ch || "none", sent_at: ch ? new Date().toISOString() : null }).eq("id", ms.id);
    if (ch) sent++;
  }
  return sent;
}

// the customer's page (f.html): a review request or a "shall we book you in?"
async function publicAction(db: Db, action: string, body: any) {
  const token = String(body.token || "");
  if (!UUID.test(token)) return reply({ error: "This link isn't complete. Please check you copied all of it." }, 404);
  const biz = await getBusiness(db), { data: M } = await db.from("marketing_settings").select("google_review_url").eq("id", 1).maybeSingle();
  const B = { business: biz.trading_name, phone: biz.phone || "", website: biz.website || "" };
  const { data: fb } = await db.from("feedback").select("id,account_id,service,rating,comment,opened_at,accounts(name,kind)").eq("token", token).maybeSingle();
  if (fb) {
    const name = firstName((fb.accounts as any)?.name || "", (fb.accounts as any)?.kind);
    if (action === "fb_view") {
      if (!fb.opened_at) await db.from("feedback").update({ opened_at: new Date().toISOString() }).eq("id", fb.id);
      return reply({ kind: "review", ...B, name: name === "there" ? "" : name, service: fb.service, rating: fb.rating, google: fb.rating && fb.rating >= 4 ? (M?.google_review_url || "") : "" });
    }
    if (action === "fb_rate") {
      const rating = Math.round(+body.rating);
      if (!(rating >= 1 && rating <= 5)) return reply({ error: "Pick a number of stars." }, 400);
      const comment = String(body.comment || "").trim().slice(0, 2000) || null;
      await db.from("feedback").update({ rating, comment, rated_at: new Date().toISOString() }).eq("id", fb.id);
      const who = (fb.accounts as any)?.name || "A customer";
      await db.from("notifications").insert({ kind: "feedback", title: `${who} rated you ${rating}★`, body: comment ? comment.slice(0, 200) : (rating >= 4 ? "Happy customer" : "Have a look and get in touch"), account_id: fb.account_id });
      await db.from("account_comms").insert({ account_id: fb.account_id, kind: "note", direction: "in", subject: `Feedback: ${rating} out of 5`, body: comment || `${rating} stars, no comment.`, created_by_name: "Customer" });
      return reply({ ok: true, google: rating >= 4 ? (M?.google_review_url || "") : "" });
    }
    if (action === "fb_google") { await db.from("feedback").update({ google_clicked_at: new Date().toISOString() }).eq("id", fb.id); return reply({ url: M?.google_review_url || "" }); }
  }
  const { data: ms } = await db.from("marketing_sends").select("id,kind,account_id,service,response,opened_at,accounts(name,kind)").eq("token", token).maybeSingle();
  if (ms) {
    const name = firstName((ms.accounts as any)?.name || "", (ms.accounts as any)?.kind);
    if (action === "fb_view") {
      if (!ms.opened_at) await db.from("marketing_sends").update({ opened_at: new Date().toISOString() }).eq("id", ms.id);
      return reply({ kind: ms.kind, ...B, name: name === "there" ? "" : name, service: ms.service ? (SVC[ms.service] || ms.service).toLowerCase() : "", response: ms.response });
    }
    if (action === "mk_reply") {
      const answer = body.answer === "no" ? "no" : "yes", note = String(body.note || "").trim().slice(0, 1000) || null;
      await db.from("marketing_sends").update({ response: answer, response_note: note, responded_at: new Date().toISOString() }).eq("id", ms.id);
      const who = (ms.accounts as any)?.name || "A customer", what = ms.kind === "repeat" ? `their ${(SVC[ms.service || ""] || ms.service || "work").toLowerCase()}` : "some work";
      if (answer === "yes") await db.from("notifications").insert({ kind: "repeat_yes", title: `${who} would like ${what} booked`, body: note || "Get in touch to agree a date", account_id: ms.account_id });
      await db.from("account_comms").insert({ account_id: ms.account_id, kind: "note", direction: "in", subject: answer === "yes" ? `Said yes to booking ${what}` : `Said no thanks to booking ${what}`, body: note || "", created_by_name: "Customer" });
      return reply({ ok: true });
    }
  }
  return reply({ error: "We couldn't find this link. It may be old: give us a call instead." }, 404);
}

/* ---------- example details for a test send ---------- */
const SAMPLE: Record<string, string> = {
  first_name: "Sam", customer_name: "Sam Smith", date: "Friday 27 November", time: "around 10:30", service: "Window cleaning", address: "12 Example Road, Hull",
  visit_list: "• Window cleaning at 12 Example Road, around 10:30\n• Gutter clean at 12 Example Road, around 11:00",
  invoice_no: "INV-1000", amount_due: "£45.00", total: "£45.00", work_date: "24 November 2026", due_date: "8 December 2026",
  how_to_pay: "You can pay by card using the button below, or by bank transfer using the details below.",
  pay_link: "https://portal.example.com/i?t=…",
  link: "https://portal.example.com/f?t=…", last_date: "14 November 2025",
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
      const out: Record<string, unknown> = { visits: await visitReminders(db) };
      try {
        const { data: M } = await db.from("marketing_settings").select("*").eq("id", 1).maybeSingle();
        if (M && (M.review_on || M.repeat_on || M.winback_on)) {
          const biz = await getBusiness(db);
          out.reviews = await reviewRequests(db, M, biz);
          if (M.repeat_on || M.winback_on) { const H = await history(db); out.repeat = await repeatPrompts(db, M, biz, H); out.winback = await winBacks(db, M, biz, H); }
        }
      } catch (e) { console.error("growth", (e as Error).message); out.growthError = (e as Error).message; }
      return reply(out);
    }
    if (["fb_view", "fb_rate", "fb_google", "mk_reply"].includes(action)) return await publicAction(db, action, body);
    const me = await who(db, req);
    if (!me) return reply({ error: "Please sign in again." }, 401);
    if (action === "status") return reply({ sms: { configured: smsConfigured(), provider: smsProvider() || null } });
    if (action === "test") {
      if (!me.admin) return reply({ error: "Only the admin can do this." }, 403);
      const t = await getTemplate(db, String(body.key || ""));
      if (!t) return reply({ error: "Unknown message" }, 400);
      const biz = await getBusiness(db), vars = { ...businessVars(biz), ...SAMPLE };
      if ((t as any).channel === "sms" || String(t.key).endsWith("_sms")) {
        const mob = ukMobile(String(body.phone || ""));
        if (!mob) return reply({ error: "Enter a UK mobile number to send the test text to." }, 400);
        await sendSms(mob, fill(body.body ?? t.body, vars), biz.sms_sender || biz.trading_name);
        return reply({ sent: true, to: "+" + mob });
      }
      const to = cleanEmails(me.email);
      if (!to.length) return reply({ error: "Your login has no email address to send the test to." }, 400);
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
