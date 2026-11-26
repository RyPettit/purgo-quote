// Purgō: the customer's online quote (no login). The customer's link carries the quote's secret share_token.
// Turn "Verify JWT" OFF. Only the customer's own quote, as it was sent to them, is ever returned.
//
// POST JSON:
//   {action:"view",     token}                        -> quote for display
//   {action:"accept",   token, name, note, sections?} -> marks it Accepted (optionally only some sections), logs it, alerts the Portal
//   {action:"decline",  token, note}                  -> marks it Declined, same
//   {action:"question", token, name, note}            -> logs the question and alerts the Portal
import { cors, reply, serviceClient, trySend, simpleHtml, cleanEmails } from "../_shared/gmail.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DAYS = 30;
const label = (n: number | null, dev: boolean) => n ? `${dev ? "DEV-" : ""}PQ-${n}` : "your quote";
const gbp = (n: number) => "£" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n: number) => Math.round((+n || 0) * 100) / 100;
const SECTION_RX = /^(Pressure washing|Gutters|Roof cleaning|Windows)/;
type Sec = { name: string; sub: number; pre: number };
type Opt = { sections: Sec[]; fixed: Sec[]; adj: number; min: number; vatRate: number; sub: number; vat: number; total: number };
// the same sums as the Portal's optionsOf / pickPrice (purgo.js)
function optionsOf(q: any, minRes: number): Opt {
  if (q.options?.sections) return q.options;
  const sections: Sec[] = [], fixed: Sec[] = []; let adj = 0;
  for (const g of q.lines || []) {
    if (g.name === "Adjustments") { for (const l of g.lines || []) if (l.label !== "Minimum charge top-up") adj += +l.amt || 0; continue; }
    const sub = r2((g.lines || []).reduce((s: number, l: any) => s + (+l.amt || 0), 0));
    (SECTION_RX.test(g.name) ? sections : fixed).push({ name: g.name, sub, pre: sub });
  }
  const total = +q.total || 0, vat = +q.vat || 0, sub = q.sub != null ? +q.sub : total - vat;
  return { sections, fixed, adj: r2(adj), min: q.job_type === "com" ? 0 : minRes, vatRate: vat > 0 && sub > 0 ? Math.round(vat / sub * 1000) / 10 : 0, sub: r2(sub), vat: r2(vat), total: r2(total) };
}
function pickPrice(o: Opt, names: string[]) {
  const ch = o.sections.filter((s) => names.includes(s.name));
  if (ch.length === o.sections.length) return { sub: o.sub, vat: o.vat, total: o.total, all: true };
  const sum = (a: Sec[], k: "sub" | "pre") => a.reduce((t, x) => t + (+x[k] || 0), 0);
  let sub = sum(ch, "sub") + sum(o.fixed, "sub") + o.adj; const pre = sum(ch, "pre") + sum(o.fixed, "pre") + o.adj;
  if (pre > 0 && pre < o.min) sub += o.min - pre;
  sub = Math.max(0, r2(sub)); const vat = r2(sub * (o.vatRate || 0) / 100);
  return { sub, vat, total: r2(sub + vat), all: false };
}
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Not found" }, 404);
  const db = serviceClient();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "view"), token = String(body.token || "");
    if (!UUID.test(token)) return reply({ error: "This link isn't valid. Please check you copied all of it." }, 404);
    const { data: q } = await db.from("quotes").select("id,quote_no,status,customer,address,postcode,email,total,sub,vat,job_type,lines,options,accepted_sections,accepted_total,customer_html,shared_at,sent_at,viewed_at,accepted_at,accepted_name,declined_at,account_id")
      .eq("share_token", token).maybeSingle();
    if (!q || !q.customer_html) return reply({ error: "We couldn't find this quote. It may have been replaced by a newer one — please call us on 07930 877034." }, 404);

    const dev = !/iixqkqkmdholetujuqin/.test(Deno.env.get("SUPABASE_URL") || "");
    const ref = label(q.quote_no, dev);
    const from = new Date(q.sent_at || q.shared_at || Date.now());
    const validUntil = new Date(from.getTime() + VALID_DAYS * 864e5);
    const expired = Date.now() > validUntil.getTime() + 864e5 && q.status !== "accepted";
    let minRes = 0;
    if (!q.options?.sections && q.job_type !== "com") { const { data: st } = await db.from("settings").select("value").eq("key", "rates").maybeSingle(); minRes = +(st?.value?.minRes) || 0; }
    const opt = optionsOf(q, minRes);
    // only offer a choice when there's more than one service on the quote
    const choice = opt.sections.length > 1 ? { sections: opt.sections, fixed: opt.fixed, adj: opt.adj, min: opt.min, vatRate: opt.vatRate, sub: opt.sub, vat: opt.vat, total: opt.total } : null;
    const view = () => ({ ref, customer: q.customer, address: [q.address, q.postcode].filter(Boolean).join(", "), total: q.total, html: q.customer_html,
      status: q.status, acceptedAt: q.accepted_at, acceptedName: q.accepted_name, declinedAt: q.declined_at, validUntil: validUntil.toISOString(), expired,
      choice, acceptedSections: q.accepted_sections || null, acceptedTotal: q.accepted_total ?? null });

    const log = async (body: string, subject: string) => {
      if (q.account_id) await db.from("account_comms").insert({ account_id: q.account_id, kind: "quote", direction: "in", subject, body, quote_id: q.id, created_by_name: "Customer (online)" });
    };
    const alert = async (kind: string, title: string, text: string) =>
      await db.from("notifications").insert({ kind, title, body: text, quote_id: q.id, account_id: q.account_id });
    // tell the Purgō mailbox, if email is connected (never fails the customer's action)
    const tellPurgo = async (subject: string, lines: string[]) => {
      try { const { data: c } = await db.from("mail_connection").select("address").eq("id", 1).maybeSingle();
        if (c?.address) await trySend(db, { fromName: "Purgō Portal", to: [c.address], subject, html: simpleHtml(lines), text: lines.join("\n\n") }); } catch { /* ignore */ }
    };

    if (action === "view") {
      if (!q.viewed_at) {
        await db.from("quotes").update({ viewed_at: new Date().toISOString() }).eq("id", q.id);
        await log(`Customer opened ${ref} online.`, "Quote opened");
      }
      return reply(view());
    }

    const name = clip(body.name, 120), note = clip(body.note, 2000);

    if (action === "accept") {
      if (q.status === "accepted") return reply(view());
      if (expired) return reply({ error: "This quote has expired. Use 'Ask a question' and we'll update it for you." }, 400);
      if (!name) return reply({ error: "Please type your name to accept." }, 400);
      // which services they want (all of them unless the page sent a choice)
      const valid = opt.sections.map((s) => s.name);
      const picked = Array.isArray(body.sections) ? [...new Set(body.sections.map((x: unknown) => String(x)))].filter((n) => valid.includes(n)) : valid;
      if (!picked.length) return reply({ error: "Please tick at least one service to accept." }, 400);
      const p = pickPrice(opt, picked);
      const part = !p.all, what = part ? picked.join(", ") : "", amt = part ? p.total : q.total;
      const now = new Date().toISOString();
      const { error } = await db.from("quotes").update({ status: "accepted", accepted_at: now, accepted_name: name, response_note: note || null, declined_at: null, follow_up_at: null,
        accepted_sections: part ? picked : null, accepted_total: part ? p.total : null }).eq("id", q.id);
      if (error) throw error;
      const notTaken = part ? valid.filter((n) => !picked.includes(n)).join(", ") : "";
      await log(`Accepted online by ${name}${part ? `: ${what} only (${gbp(amt)} of ${gbp(q.total)}). Not wanted: ${notTaken}` : ""}.${note ? "\n\n" + note : ""}`, `${ref} ${part ? "part " : ""}accepted`);
      await alert("quote_accepted", `${q.customer || "A customer"} ${part ? "part " : ""}accepted ${ref}`, `${part ? what + " · " : ""}${gbp(amt)}${note ? " · " + note.slice(0, 140) : ""}`);
      await tellPurgo(`Quote ${part ? "part " : ""}accepted: ${ref} – ${q.customer || ""}`, [part ? `${name} accepted part of ${ref} online: ${what} (${gbp(amt)} of ${gbp(q.total)}).` : `${name} accepted ${ref} (${gbp(q.total)}) online.`,
        part ? `Not wanted: ${notTaken}` : "", note ? `Their note: ${note}` : "", "Open the Portal to book the work in."].filter(Boolean));
      q.accepted_sections = part ? picked : null; q.accepted_total = part ? p.total : null;
      const to = cleanEmails(q.email || "");
      if (to.length) { try { await trySend(db, { fromName: "Purgō", to, subject: `Thank you – ${ref} accepted`, text: `Hi ${name},\n\nThank you for accepting ${ref}${part ? ` (${what}, ${gbp(amt)})` : ""}. We'll be in touch shortly to arrange a date.\n\nPurgō\n07930 877034`,
        html: simpleHtml([`Hi ${name},`, `Thank you for accepting ${ref}${part ? ` (${what}, ${gbp(amt)})` : ""}. We'll be in touch shortly to arrange a date.`, "If you need anything in the meantime, just reply to this email or call us on 07930 877034."]) }); } catch { /* ignore */ } }
      q.status = "accepted"; q.accepted_at = now; q.accepted_name = name;
      return reply(view());
    }

    if (action === "decline") {
      if (q.status === "accepted") return reply({ error: "This quote has already been accepted. Please call us on 07930 877034 if you'd like to change anything." }, 400);
      const now = new Date().toISOString();
      const { error } = await db.from("quotes").update({ status: "declined", declined_at: now, response_note: note || null, follow_up_at: null }).eq("id", q.id);
      if (error) throw error;
      await log(`Declined online.${note ? "\n\nReason: " + note : ""}`, `${ref} declined`);
      await alert("quote_declined", `${q.customer || "A customer"} declined ${ref}`, note ? note.slice(0, 160) : "No reason given");
      await tellPurgo(`Quote declined: ${ref} – ${q.customer || ""}`, [`${ref} (${gbp(q.total)}) was declined online.`, note ? `Reason: ${note}` : "No reason given."]);
      q.status = "declined"; q.declined_at = now;
      return reply(view());
    }

    if (action === "question") {
      if (!note) return reply({ error: "Please type your question." }, 400);
      await log(`${name ? name + " asked" : "Question"}: ${note}`, `Question about ${ref}`);
      await alert("quote_question", `Question about ${ref} from ${name || q.customer || "a customer"}`, note.slice(0, 160));
      await tellPurgo(`Question about ${ref} – ${q.customer || ""}`, [`${name || "The customer"} asked about ${ref}:`, note, q.email ? `Reply to: ${q.email}` : ""].filter(Boolean));
      return reply({ ...view(), asked: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: "Something went wrong. Please try again, or call us on 07930 877034." , detail: (e as Error).message }, 500);
  }
});
