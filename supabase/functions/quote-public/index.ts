// Purgō: the customer's online quote (no login). The customer's link carries the quote's secret share_token.
// Turn "Verify JWT" OFF. Only the customer's own quote, as it was sent to them, is ever returned.
//
// POST JSON:
//   {action:"view",     token}                        -> quote for display
//   {action:"accept",   token, name, note}            -> marks it Accepted, logs it on the account, alerts the Portal
//   {action:"decline",  token, note}                  -> marks it Declined, same
//   {action:"question", token, name, note}            -> logs the question and alerts the Portal
import { cors, reply, serviceClient, trySend, simpleHtml, cleanEmails } from "../_shared/gmail.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DAYS = 30;
const label = (n: number | null, dev: boolean) => n ? `${dev ? "DEV-" : ""}PQ-${n}` : "your quote";
const gbp = (n: number) => "£" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Not found" }, 404);
  const db = serviceClient();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "view"), token = String(body.token || "");
    if (!UUID.test(token)) return reply({ error: "This link isn't valid. Please check you copied all of it." }, 404);
    const { data: q } = await db.from("quotes").select("id,quote_no,status,customer,address,postcode,email,total,customer_html,shared_at,sent_at,viewed_at,accepted_at,accepted_name,declined_at,account_id")
      .eq("share_token", token).maybeSingle();
    if (!q || !q.customer_html) return reply({ error: "We couldn't find this quote. It may have been replaced by a newer one — please call us on 07930 877034." }, 404);

    const dev = !/iixqkqkmdholetujuqin/.test(Deno.env.get("SUPABASE_URL") || "");
    const ref = label(q.quote_no, dev);
    const from = new Date(q.sent_at || q.shared_at || Date.now());
    const validUntil = new Date(from.getTime() + VALID_DAYS * 864e5);
    const expired = Date.now() > validUntil.getTime() + 864e5 && q.status !== "accepted";
    const view = () => ({ ref, customer: q.customer, address: [q.address, q.postcode].filter(Boolean).join(", "), total: q.total, html: q.customer_html,
      status: q.status, acceptedAt: q.accepted_at, acceptedName: q.accepted_name, declinedAt: q.declined_at, validUntil: validUntil.toISOString(), expired });

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
      const now = new Date().toISOString();
      const { error } = await db.from("quotes").update({ status: "accepted", accepted_at: now, accepted_name: name, response_note: note || null, declined_at: null, follow_up_at: null }).eq("id", q.id);
      if (error) throw error;
      await log(`Accepted online by ${name}.${note ? "\n\n" + note : ""}`, `${ref} accepted`);
      await alert("quote_accepted", `${q.customer || "A customer"} accepted ${ref}`, `${gbp(q.total)}${note ? " · " + note.slice(0, 140) : ""}`);
      await tellPurgo(`Quote accepted: ${ref} – ${q.customer || ""}`, [`${name} accepted ${ref} (${gbp(q.total)}) online.`, note ? `Their note: ${note}` : "", "Open the Portal to book the work in."].filter(Boolean));
      const to = cleanEmails(q.email || "");
      if (to.length) { try { await trySend(db, { fromName: "Purgō", to, subject: `Thank you – ${ref} accepted`, text: `Hi ${name},\n\nThank you for accepting ${ref}. We'll be in touch shortly to arrange a date.\n\nPurgō\n07930 877034`,
        html: simpleHtml([`Hi ${name},`, `Thank you for accepting ${ref}. We'll be in touch shortly to arrange a date.`, "If you need anything in the meantime, just reply to this email or call us on 07930 877034."]) }); } catch { /* ignore */ } }
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
