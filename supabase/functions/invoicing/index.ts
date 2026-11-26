// Purgō: invoices, card payments (Stripe) and the link to Sage Accounting.
// Turn "Verify JWT" OFF: Sage's sign-in redirect, Stripe's webhook and the customer's invoice link have no Portal login,
// so this function checks every caller itself.
//
// Secrets: SAGE_CLIENT_ID, SAGE_CLIENT_SECRET   (app in developer.sage.com, callback URL = this function's URL)
//          STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (Stripe → Developers; webhook URL = this function's URL, event checkout.session.completed)
// Both are optional: without Sage nothing is copied to the books; without Stripe invoices show bank details only.
//
// Signed-in staff (POST JSON):
//   {action:"status"}                       -> {sage:{configured, connected, business, choices…, lastSync, lastError}, stripe:{configured}}
//   {action:"sage_connect", returnTo} admin -> {url}
//   {action:"sage_disconnect"}        admin -> {ok}
//   {action:"sage_options"}           admin -> {ledgers, banks, taxRates}  lists from Sage to choose from
//   {action:"sage_choose", …ids}      admin -> {ok}
//   {action:"send", invoiceId, to, cc, subject, message} -> {sent, link}   emails the invoice (issues a draft first)
//   {action:"sync"}  (x-purgo-key or staff)  -> copies invoices and payments to Sage, reads back payments, emails queued invoices
// Customer (no login, POST JSON with the invoice's token):
//   {action:"view", token}   -> the invoice
//   {action:"pay", token}    -> {url} Stripe Checkout for what's left to pay
// GET ?code=…&state=…  Sage's redirect after approving.   POST with Stripe-Signature: Stripe's webhook.
import { cors, reply, serviceClient, trySend, escHtml, SIG_HTML, cleanEmails } from "../_shared/gmail.ts";

type Db = ReturnType<typeof serviceClient>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OK_ORIGINS = [/^https:\/\/(portal|quote)\.purgo-clean\.com$/, /^https:\/\/([a-z0-9-]+\.)?purgo-quote\.pages\.dev$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const env = (k: string) => (Deno.env.get(k) ?? "").replace(/\s+/g, "");
const selfUrl = () => Deno.env.get("SUPABASE_URL")! + "/functions/v1/invoicing";
const DEV = () => !/iixqkqkmdholetujuqin/.test(Deno.env.get("SUPABASE_URL") || "");
const PORTAL = () => DEV() ? "https://dev.purgo-quote.pages.dev" : "https://portal.purgo-clean.com";
const invLabel = (n: number) => `${DEV() ? "DEV-" : ""}INV-${n}`;
const r2 = (n: number) => Math.round((+n || 0) * 100) / 100;
const gbp = (n: number) => "£" + r2(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = (d: string | null) => d ? new Date(d + (d.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
const sageConfigured = () => !!(env("SAGE_CLIENT_ID") && env("SAGE_CLIENT_SECRET"));
const stripeConfigured = () => !!env("STRIPE_SECRET_KEY");

async function who(db: Db, req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: p } = await db.from("profiles").select("name,role,active").eq("id", data.user.id).maybeSingle();
  return p && p.active && (p.role === "admin" || p.role === "staff") ? { id: data.user.id, name: p.name as string, admin: p.role === "admin" } : null;
}

/* =================== Sage =================== */
const SAGE_API = "https://api.accounting.sage.com/v3.1/";
type Conn = Record<string, any>;
async function getConn(db: Db): Promise<Conn> {
  const { data } = await db.from("accounting_connection").select("*").eq("id", 1).maybeSingle();
  return data || {};
}
// a fresh 5-minute access token; Sage hands back a new refresh token each time, which is saved straight away
async function sageToken(db: Db, conn: Conn): Promise<string> {
  if (!conn.refresh_token) throw new Error("Sage isn't connected.");
  const r = await fetch("https://oauth.accounting.sage.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: env("SAGE_CLIENT_ID"), client_secret: env("SAGE_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: conn.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Sage sign-in has expired. Reconnect Sage in Admin → Invoicing. (" + (j.error_description || j.error || r.status) + ")");
  const upd: Record<string, unknown> = { refresh_token: j.refresh_token || conn.refresh_token };
  if (j.refresh_token_expires_in) upd.refresh_expires_at = new Date(Date.now() + j.refresh_token_expires_in * 1000).toISOString();
  await db.from("accounting_connection").update(upd).eq("id", 1);
  conn.refresh_token = upd.refresh_token;
  return j.access_token;
}
class SageError extends Error { status = 0; body: any = null; }
async function sage(token: string, conn: Conn, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json" };
  if (conn.business_id) headers["X-Business"] = conn.business_id;
  const r = await fetch(SAGE_API + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = Array.isArray(j) ? j.map((e: any) => e.$message || e.$dataCode).filter(Boolean).join("; ") : (j.$message || j.message || "");
    const e = new SageError("Sage: " + (msg || "error " + r.status)); e.status = r.status; e.body = j; throw e;
  }
  return j;
}
const items = (j: any) => (j && (j.$items || j.items)) || (Array.isArray(j) ? j : []);

// the customer in Sage (made the first time we invoice them)
async function sageContact(db: Db, tok: string, conn: Conn, accountId: string): Promise<string> {
  const { data: a } = await db.from("accounts").select("id,account_no,name,email,phone,billing_line,billing_postcode,sage_contact_id").eq("id", accountId).maybeSingle();
  if (!a) throw new Error("Customer account missing");
  if (a.sage_contact_id) return a.sage_contact_id;
  const ref = `${DEV() ? "D" : ""}AC${a.account_no}`;
  let id: string | null = null;
  try {
    const c = await sage(tok, conn, "contacts", { method: "POST", body: JSON.stringify({ contact: {
      name: a.name, reference: ref, contact_type_ids: ["CUSTOMER"], email: a.email || undefined,
      main_address: (a.billing_line || a.billing_postcode) ? { address_line_1: a.billing_line || "", postal_code: a.billing_postcode || "" } : undefined,
      main_contact_person: a.email || a.phone ? { name: a.name, email: a.email || undefined, telephone: a.phone || undefined, is_main_contact: true } : undefined,
    } }) });
    id = c.id;
  } catch (e) {
    // already in Sage with our reference (e.g. made before a reconnect): use that one
    const found = items(await sage(tok, conn, "contacts?search=" + encodeURIComponent(ref))).find((x: any) => (x.reference || "") === ref || (x.displayed_as || "").includes(`(${ref})`));
    if (!found) throw e;
    id = found.id;
  }
  await db.from("accounts").update({ sage_contact_id: id }).eq("id", a.id);
  return id!;
}

async function pushInvoice(db: Db, tok: string, conn: Conn, inv: any) {
  if (inv.status === "void") {
    if (inv.sage_id) {
      try { await sage(tok, conn, `sales_invoices/${inv.sage_id}?void_reason=${encodeURIComponent(inv.void_reason || "Voided in the Purgō Portal")}`, { method: "DELETE" }); }
      catch (e) { if ((e as SageError).status !== 404) throw e; }
    }
    await db.from("invoices").update({ sage_dirty: false, sage_error: null, sage_synced_at: new Date().toISOString() }).eq("id", inv.id);
    return;
  }
  const { data: lines } = await db.from("invoice_lines").select("*").eq("invoice_id", inv.id).order("sort");
  const contact = await sageContact(db, tok, conn, inv.account_id);
  // Sage needs an invoice address: the one on the invoice, else the account's, split into street and postcode
  const { data: acc } = await db.from("accounts").select("billing_line,billing_postcode").eq("id", inv.account_id).maybeSingle();
  let line1 = "", pc = "";
  const parts = String(inv.bill_address || "").split(",").map((x: string) => x.trim()).filter(Boolean);
  if (parts.length && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(parts[parts.length - 1])) pc = parts.pop()!;
  line1 = parts.join(", ") || acc?.billing_line || "";
  pc = pc || acc?.billing_postcode || "";
  const body = { sales_invoice: {
    contact_id: contact, date: inv.issue_date, due_date: inv.due_date, reference: invLabel(inv.invoice_no),
    main_address: { address_line_1: (line1 || inv.bill_name || "Address not given").slice(0, 100), postal_code: pc || undefined, country_id: "GB" },
    notes: inv.notes || undefined,
    invoice_lines: (lines || []).map((l: any) => {
      const net = r2(l.amount - l.vat);
      return { description: (+l.qty !== 1 ? `${+l.qty} × ` : "") + l.description, ledger_account_id: conn.sales_ledger_id, quantity: 1, unit_price: net,
        tax_rate_id: +l.vat_rate > 0 ? conn.tax_standard_id : conn.tax_none_id, tax_amount: r2(l.vat) };
    }),
  } };
  let sageId = inv.sage_id;
  if (sageId) {
    try { await sage(tok, conn, `sales_invoices/${sageId}`, { method: "PUT", body: JSON.stringify(body) }); }
    catch (e) { if ((e as SageError).status === 404) sageId = null; else throw e; }   // removed in Sage: make it again
  }
  if (!sageId) sageId = (await sage(tok, conn, "sales_invoices", { method: "POST", body: JSON.stringify(body) })).id;
  await db.from("invoices").update({ sage_id: sageId, sage_dirty: false, sage_error: null, sage_synced_at: new Date().toISOString() }).eq("id", inv.id);
}

const PAY_METHOD: Record<string, string> = { card: "CREDIT_DEBIT", bank: "BANK_TRANSFER", cash: "CASH", dd: "BANK_TRANSFER", other: "BANK_TRANSFER" };
async function pushPayment(db: Db, tok: string, conn: Conn, p: any) {
  const { data: inv } = await db.from("invoices").select("id,sage_id,account_id,invoice_no").eq("id", p.invoice_id).maybeSingle();
  if (!inv?.sage_id) return;     // the invoice goes first; the payment follows on the next run
  const bank = p.method === "card" ? (conn.card_account_id || conn.bank_account_id) : conn.bank_account_id;
  if (!bank) throw new Error("Choose which Sage bank account payments go into (Admin → Invoicing).");
  const contact = await sageContact(db, tok, conn, inv.account_id);
  const body = { contact_payment: {
    transaction_type_id: "CUSTOMER_RECEIPT", payment_method_id: PAY_METHOD[p.method] || "BANK_TRANSFER", contact_id: contact, bank_account_id: bank,
    date: p.paid_on, total_amount: r2(p.amount), reference: (p.reference || invLabel(inv.invoice_no)).slice(0, 25),
    allocated_artefacts: [{ artefact_id: inv.sage_id, amount: r2(p.amount) }],
  } };
  if (p.sage_id) {
    try { await sage(tok, conn, `contact_payments/${p.sage_id}`, { method: "DELETE" }); } catch (e) { if ((e as SageError).status !== 404) throw e; }
  }
  const made = await sage(tok, conn, "contact_payments", { method: "POST", body: JSON.stringify(body) });
  await db.from("payments").update({ sage_id: made.id, sage_dirty: false, sage_error: null }).eq("id", p.id);
}

// payments made in Sage (a Tide bank transfer matched to the invoice there) come back to the Portal
async function pullPayments(db: Db, tok: string, conn: Conn) {
  const { data: open } = await db.from("invoices").select("id,account_id,sage_id,total,paid,invoice_no").in("status", ["sent", "part_paid"]).not("sage_id", "is", null).limit(200);
  let found = 0;
  for (const inv of open || []) {
    const { data: pend } = await db.from("payments").select("id").eq("invoice_id", inv.id).eq("sage_dirty", true).limit(1);
    if (pend && pend.length) continue;   // our own payment is still on its way to Sage
    let s;
    try { s = await sage(tok, conn, `sales_invoices/${inv.sage_id}`); } catch { continue; }
    const paidInSage = r2((+s.total_amount || 0) - (+s.outstanding_amount || 0));
    const extra = r2(paidInSage - (+inv.paid || 0));
    if (extra > 0.004) {
      const { error } = await db.from("payments").insert({ invoice_id: inv.id, account_id: inv.account_id, amount: extra, method: "bank", source: "sage",
        paid_on: (s.last_paid ? String(s.last_paid).slice(0, 10) : new Date().toISOString().slice(0, 10)), reference: "Matched in Sage", created_by_name: "Sage" });
      if (!error) { found++; await paidNotice(db, inv.id, extra, "bank transfer"); }
    }
  }
  return found;
}

async function paidNotice(db: Db, invoiceId: string, amount: number, how: string) {
  const { data: i } = await db.from("invoices").select("invoice_no,account_id,bill_name,status").eq("id", invoiceId).maybeSingle();
  if (!i) return;
  const t = `${i.bill_name || "Customer"} paid ${gbp(amount)}`;
  await db.from("notifications").insert({ kind: "invoice_paid", title: t, body: `${invLabel(i.invoice_no)} · ${how}${i.status === "paid" ? " · paid in full" : ""}`, account_id: i.account_id });
  await db.from("account_comms").insert({ account_id: i.account_id, kind: "invoice", direction: "in", subject: `Payment received: ${invLabel(i.invoice_no)}`, body: `${gbp(amount)} by ${how}.`, invoice_id: invoiceId, created_by_name: how === "card" ? "Stripe" : "Sage" });
}

async function sageSync(db: Db) {
  const conn = await getConn(db);
  if (!sageConfigured() || !conn.refresh_token) return { connected: false };
  if (!conn.sales_ledger_id || !conn.tax_none_id) return { connected: true, waiting: "Choose the Sage accounts in Admin → Invoicing." };
  const tok = await sageToken(db, conn);
  if (!conn.card_account_id) { try { await ensureCardAccount(db, tok, conn); } catch (e) { console.error("card account", (e as Error).message); } }
  let invoices = 0, payments = 0, failed = 0;
  const { data: dirty } = await db.from("invoices").select("*").eq("sage_dirty", true).neq("status", "draft").order("invoice_no").limit(100);
  for (const inv of dirty || []) {
    if (inv.status === "void" && !inv.sage_id) { await db.from("invoices").update({ sage_dirty: false }).eq("id", inv.id); continue; }
    try { await pushInvoice(db, tok, conn, inv); invoices++; }
    catch (e) { failed++; await db.from("invoices").update({ sage_error: String((e as Error).message).slice(0, 500) }).eq("id", inv.id); }
  }
  const { data: pays } = await db.from("payments").select("*").eq("sage_dirty", true).order("created_at").limit(100);
  for (const p of pays || []) {
    try { await pushPayment(db, tok, conn, p); payments++; }
    catch (e) { failed++; await db.from("payments").update({ sage_error: String((e as Error).message).slice(0, 500) }).eq("id", p.id); }
  }
  const received = await pullPayments(db, tok, conn);
  await db.from("accounting_connection").update({ last_sync: new Date().toISOString(), last_error: failed ? `${failed} item${failed > 1 ? "s" : ""} couldn't be copied to Sage: see the invoice for why.` : null }).eq("id", 1);
  return { connected: true, invoices, payments, received, failed };
}

// card payments (Stripe) go into their own Sage bank account, "Stripe": Stripe pays out to Tide in batches, less its fees
async function ensureCardAccount(db: Db, tok: string, conn: Conn) {
  const list = items(await sage(tok, conn, "bank_accounts?items_per_page=100"));
  let acc = list.find((x: any) => /stripe/i.test(x.displayed_as || ""));
  if (!acc) {
    let lastErr: unknown = null;
    for (const code of [1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 1259]) {
      try {
        acc = await sage(tok, conn, "bank_accounts", { method: "POST", body: JSON.stringify({ bank_account: {
          bank_account_type_id: "CHECKING", nominal_code: code, balance: 0,
          bank_account_details: { account_name: "Stripe" } } }) });
        break;
      } catch (e) { lastErr = e; }
    }
    if (!acc) throw lastErr || new Error("Couldn't make the Stripe bank account in Sage.");
  }
  const name = acc.displayed_as || "Stripe";
  await db.from("accounting_connection").update({ card_account_id: acc.id, card_account_name: name }).eq("id", 1);
  conn.card_account_id = acc.id; conn.card_account_name = name;
}

/* =================== Stripe =================== */
async function stripe(path: string, params: Record<string, string>) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Card payments: " + (j.error?.message || r.status));
  return j;
}
async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function stripeWebhook(db: Db, req: Request) {
  const raw = await req.text();
  const header = req.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")).filter(p => p.length === 2)) as Record<string, string>;
  const v1s = header.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret || !parts.t || !v1s.length) return new Response("bad signature", { status: 400 });
  if (Math.abs(Date.now() / 1000 - +parts.t) > 600) return new Response("too old", { status: 400 });
  const want = await hmacHex(secret, `${parts.t}.${raw}`);
  if (!v1s.includes(want)) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(raw);
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    const s = ev.data.object;
    const invoiceId = s.metadata?.invoice_id;
    if (s.payment_status === "paid" && UUID.test(invoiceId || "")) {
      const { data: inv } = await db.from("invoices").select("id,account_id").eq("id", invoiceId).maybeSingle();
      if (inv) {
        const amount = r2((s.amount_total || 0) / 100);
        const { error } = await db.from("payments").insert({ invoice_id: inv.id, account_id: inv.account_id, amount, method: "card", source: "stripe",
          stripe_ref: s.payment_intent || s.id, reference: "Card (Stripe)", created_by_name: "Stripe" });
        if (!error) await paidNotice(db, inv.id, amount, "card");   // a repeat of the same event is ignored (stripe_ref is unique)
      }
    }
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
}

/* =================== The invoice (email and online) =================== */
async function loadInvoice(db: Db, where: { id?: string; token?: string }) {
  let q = db.from("invoices").select("*");
  q = where.id ? q.eq("id", where.id) : q.eq("share_token", where.token!);
  const { data: inv } = await q.maybeSingle();
  if (!inv) return null;
  const [{ data: lines }, { data: pays }, { data: s }] = await Promise.all([
    db.from("invoice_lines").select("description,qty,unit_price,amount,vat,vat_rate,service_date").eq("invoice_id", inv.id).order("sort"),
    db.from("payments").select("amount,method,paid_on").eq("invoice_id", inv.id).order("paid_on"),
    db.from("invoice_settings").select("*").eq("id", 1).maybeSingle(),
  ]);
  return { inv, lines: lines || [], pays: pays || [], s: s || {} };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadInvoice>>>;
function bankBlock(s: any, ref: string) {
  if (!s.bank_account_no || !s.bank_sort_code) return "";
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin-top:6px">
    ${[["Account name", s.bank_account_name || "Purgō Clean Ltd"], ["Sort code", s.bank_sort_code], ["Account number", s.bank_account_no], ["Reference", ref]].map(([k, v]) =>
      `<tr><td style="padding:3px 14px 3px 0;color:#53708a">${escHtml(k)}</td><td style="padding:3px 0;font-weight:700">${escHtml(v)}</td></tr>`).join("")}</table>`;
}
// the invoice as a table (used in the email and on the online page)
export function invoiceTable(L: Loaded) {
  const { inv, lines, s } = L;
  const td = "padding:9px 10px;border-bottom:1px solid #d4e4ee;vertical-align:top;", num = "text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;";
  const vatOn = lines.some((l: any) => +l.vat_rate > 0);
  const due = r2(inv.total - inv.paid);
  let h = `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#132f47;font-size:14px">
    <tr><td style="padding:0 0 12px" colspan="2"><div style="font-size:20px;font-weight:800">Invoice ${escHtml(invLabel(inv.invoice_no))}</div>
      <div style="color:#53708a">Date ${escHtml(fmtD(inv.issue_date))} · Due ${escHtml(fmtD(inv.due_date))}</div>
      <div style="margin-top:8px"><b>${escHtml(inv.bill_name || "")}</b>${inv.bill_address ? `<br>${escHtml(inv.bill_address)}` : ""}</div></td></tr>
    <tr><th style="${td}text-align:left;background:#eef5f9">Description</th><th style="${td}${num}background:#eef5f9">Amount</th></tr>`;
  for (const l of lines) h += `<tr><td style="${td}">${+l.qty !== 1 ? `${+l.qty} × ` : ""}${escHtml(l.description)}${+l.qty !== 1 ? ` <span style="color:#53708a">(${gbp(l.unit_price)} each)</span>` : ""}</td><td style="${td}${num}">${gbp(l.amount)}</td></tr>`;
  if (vatOn) {
    h += `<tr><td style="${td}text-align:right">Price ex VAT</td><td style="${td}${num}">${gbp(inv.sub)}</td></tr>`;
    h += `<tr><td style="${td}text-align:right">VAT</td><td style="${td}${num}">${gbp(inv.vat)}</td></tr>`;
  }
  h += `<tr><td style="padding:10px;text-align:right;font-weight:800;background:#132f47;color:#fff">Total${vatOn ? "" : (s.vat_registered ? "" : " (no VAT)")}</td><td style="padding:10px;${num}font-weight:800;font-size:16px;background:#132f47;color:#fff">${gbp(inv.total)}</td></tr>`;
  if (+inv.paid > 0) {
    h += `<tr><td style="${td}text-align:right">Paid</td><td style="${td}${num}">−${gbp(inv.paid)}</td></tr>`;
    h += `<tr><td style="${td}text-align:right;font-weight:800">${due > 0 ? "Left to pay" : "Paid in full"}</td><td style="${td}${num}font-weight:800">${gbp(Math.max(0, due))}</td></tr>`;
  }
  h += `</table>`;
  if (inv.notes) h += `<p style="margin:12px 0 0;font-size:14px">${escHtml(inv.notes).replace(/\n/g, "<br>")}</p>`;
  return h;
}
function invoiceText(L: Loaded) {
  const { inv, lines, s } = L;
  const ref = invLabel(inv.invoice_no);
  let t = `Invoice ${ref}\nDate ${fmtD(inv.issue_date)} · Due ${fmtD(inv.due_date)}\n\n`;
  for (const l of lines) t += `${+l.qty !== 1 ? `${+l.qty} × ` : ""}${l.description}: ${gbp(l.amount)}\n`;
  t += `\nTotal: ${gbp(inv.total)}${+inv.vat > 0 ? ` (inc VAT ${gbp(inv.vat)})` : ""}\n`;
  if (+inv.paid > 0) t += `Paid: ${gbp(inv.paid)} · Left to pay: ${gbp(Math.max(0, inv.total - inv.paid))}\n`;
  if (s.bank_account_no && s.bank_sort_code) t += `\nPay by bank transfer:\n${s.bank_account_name || "Purgō Clean Ltd"}\nSort code ${s.bank_sort_code}\nAccount ${s.bank_account_no}\nReference ${ref}\n`;
  return t;
}
const P = (s: string) => `<p style="margin:0 0 12px">${escHtml(s).replace(/\n/g, "<br>")}</p>`;
function emailHtml(L: Loaded, message: string, link: string) {
  const F = "font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;";
  const ref = invLabel(L.inv.invoice_no), due = r2(L.inv.total - L.inv.paid);
  const bank = bankBlock(L.s, ref);
  return `<div style="${F}color:#132f47;font-size:15px;line-height:1.5;max-width:640px">` +
    message.split(/\n{2,}/).map(P).join("") +
    (due > 0 ? `<p style="margin:16px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#132f47;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${stripeConfigured() ? `View and pay ${gbp(due)}` : "View your invoice"}</a></p>` : "") +
    (due > 0 && bank ? `<p style="margin:14px 0 0"><b>Or pay by bank transfer</b></p>${bank}` : "") +
    SIG_HTML +
    `<div style="margin-top:24px;border:1px solid #d4e4ee;border-radius:10px;padding:14px">${invoiceTable(L)}</div>` +
    (L.s.footer ? `<p style="margin:12px 0 0;color:#53708a;font-size:13px">${escHtml(L.s.footer)}</p>` : "") + `</div>`;
}
const firstName = (s: string) => { const n = String(s || "").trim(); if (!n || /\b(ltd|limited|plc|llp|management|properties|lettings|services|group|council|school|church)\b/i.test(n)) return ""; return n.split(/\s+/)[0]; };
export function defaultMessage(L: Loaded, sender = "Purgō") {
  const n = firstName(L.inv.bill_name), due = r2(L.inv.total - L.inv.paid);
  return `${n ? `Hi ${n},` : "Hello,"}\n\nThank you for choosing Purgō. Your invoice ${invLabel(L.inv.invoice_no)} for ${gbp(L.inv.total)} is below${due > 0 ? `, due by ${fmtD(L.inv.due_date)}` : ""}.\n\n${due > 0 ? (stripeConfigured() ? "You can pay online by card using the button, or by bank transfer using the details below." : "You can pay by bank transfer using the details below.") + "\n\n" : ""}If you have any questions, give us a call on 07930 877034.\n\nKind regards,\n${sender}`;
}

// email an invoice from the Purgō mailbox and log it on the account
async function sendInvoice(db: Db, invoiceId: string, o: { to?: string[]; cc?: string[]; subject?: string; message?: string; by?: { id: string | null; name: string } }) {
  const L = await loadInvoice(db, { id: invoiceId });
  if (!L) throw new Error("Invoice not found");
  if (L.inv.status === "void") throw new Error("This invoice is void.");
  if (L.inv.status === "draft") {
    await db.from("invoices").update({ status: "sent", issue_date: new Date().toISOString().slice(0, 10), due_date: null }).eq("id", invoiceId);
    await db.rpc("invoice_refresh", { p_invoice: invoiceId }).then(() => {}, () => {});
    Object.assign(L, await loadInvoice(db, { id: invoiceId }));
  }
  const to = o.to && o.to.length ? o.to : cleanEmails(L.inv.email || "");
  if (!to.length) throw new Error("There's no email address for this customer.");
  const link = `${PORTAL()}/i?t=${L.inv.share_token}`;
  const ref = invLabel(L.inv.invoice_no);
  const message = (o.message || defaultMessage(L, o.by?.name)).trim();
  const subject = o.subject || `Your Purgō invoice ${ref}`;
  const sent = await trySend(db, { fromName: "Purgō", to, cc: o.cc || [], subject, html: emailHtml(L, message, link),
    text: `${message}\n\nView${stripeConfigured() ? " and pay" : ""} online: ${link}\n\n${invoiceText(L)}` });
  if (!sent) throw new Error("Email isn't connected to the Portal yet (Admin → Email).");
  await db.from("invoices").update({ sent_at: new Date().toISOString(), send_requested: false, email: to[0] }).eq("id", invoiceId);
  await db.from("account_comms").insert({ account_id: L.inv.account_id, kind: "email", direction: "out", subject, body: `${message}\n\n(Invoice ${ref} for ${gbp(L.inv.total)} included, with the link to view${stripeConfigured() ? " and pay" : ""} online.)`.slice(0, 6000),
    from_addr: sent.from, to_addr: [...to, ...(o.cc || [])].join(", "), message_id: sent.id, thread_id: sent.threadId, invoice_id: invoiceId,
    created_by: o.by?.id || null, created_by_name: o.by?.name || "Auto", meta: { via: "gmail", invoice: ref } });
  return { sent: true, link, to };
}

// invoices made automatically when a visit is done (Admin → Invoicing: "make and email")
async function sendQueued(db: Db) {
  const { data } = await db.from("invoices").select("id").eq("send_requested", true).neq("status", "void").limit(30);
  let sent = 0;
  for (const r of data || []) { try { await sendInvoice(db, r.id, {}); sent++; } catch (e) { console.error("auto-send", r.id, (e as Error).message); await db.from("invoices").update({ send_requested: false, sage_error: "Not emailed: " + (e as Error).message }).eq("id", r.id); } }
  return sent;
}

/* =================== The customer's invoice page =================== */
async function publicView(db: Db, token: string) {
  const L = await loadInvoice(db, { token });
  if (!L || L.inv.status === "draft") return reply({ error: "We couldn't find this invoice. Please call us on 07930 877034." }, 404);
  if (!L.inv.viewed_at && L.inv.status !== "void") await db.from("invoices").update({ viewed_at: new Date().toISOString() }).eq("id", L.inv.id);
  const due = r2(L.inv.total - L.inv.paid);
  return reply({ ref: invLabel(L.inv.invoice_no), status: L.inv.status, total: L.inv.total, paid: L.inv.paid, due: Math.max(0, due),
    issueDate: L.inv.issue_date, dueDate: L.inv.due_date, overdue: due > 0 && L.inv.due_date < new Date().toISOString().slice(0, 10),
    html: invoiceTable(L), bank: L.inv.status === "void" ? "" : bankBlock(L.s, invLabel(L.inv.invoice_no)), footer: L.s.footer || "",
    canPayCard: stripeConfigured() && due > 0 && L.inv.status !== "void",
    klarna: stripeConfigured() && +(L.s.klarna_min || 0) > 0 && due >= +(L.s.klarna_min || 0) });
}
async function publicPay(db: Db, token: string) {
  if (!stripeConfigured()) return reply({ error: "Card payments aren't set up yet. Please pay by bank transfer." }, 400);
  const L = await loadInvoice(db, { token });
  if (!L || L.inv.status === "draft" || L.inv.status === "void") return reply({ error: "This invoice can't be paid online." }, 400);
  const due = r2(L.inv.total - L.inv.paid);
  if (due <= 0) return reply({ error: "This invoice has already been paid. Thank you!" }, 400);
  const ref = invLabel(L.inv.invoice_no), back = `${PORTAL()}/i?t=${token}`;
  // card (with Apple Pay / Google Pay) always; Klarna only from the amount set in Admin → Invoicing
  const kMin = +(L.s.klarna_min || 0);
  const methods: Record<string, string> = { "payment_method_types[0]": "card" };
  if (kMin > 0 && due >= kMin) methods["payment_method_types[1]"] = "klarna";
  const s = await stripe("checkout/sessions", {
    ...methods, mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "gbp",
    "line_items[0][price_data][unit_amount]": String(Math.round(due * 100)),
    "line_items[0][price_data][product_data][name]": `Purgō invoice ${ref}`,
    ...(L.inv.email ? { customer_email: L.inv.email } : {}),
    "metadata[invoice_id]": L.inv.id, "metadata[invoice]": ref,
    "payment_intent_data[metadata][invoice_id]": L.inv.id, "payment_intent_data[description]": `Purgō invoice ${ref}`,
    success_url: back + "&paid=1", cancel_url: back,
  });
  return reply({ url: s.url });
}

/* =================== Entry =================== */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = serviceClient();
  try {
    /* ---------- Stripe's webhook ---------- */
    if (req.method === "POST" && req.headers.get("stripe-signature")) return await stripeWebhook(db, req);

    /* ---------- Sage's redirect back after approving ---------- */
    if (req.method === "GET") {
      const u = new URL(req.url);
      const code = u.searchParams.get("code"), state = u.searchParams.get("state"), err = u.searchParams.get("error");
      const conn = await getConn(db);
      const back = conn.oauth_return || PORTAL();
      const go = (q: string) => new Response(null, { status: 302, headers: { Location: `${back}/?sage=${q}#admin` } });
      if (err) return go("cancelled");
      if (!code || !state || conn.oauth_state !== state || Date.now() - new Date(conn.oauth_state_at).getTime() > 15 * 60e3) return go("expired");
      const t = await fetch("https://oauth.accounting.sage.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: env("SAGE_CLIENT_ID"), client_secret: env("SAGE_CLIENT_SECRET"), code, grant_type: "authorization_code", redirect_uri: selfUrl() }) });
      const tj = await t.json().catch(() => ({}));
      if (!t.ok || !tj.refresh_token) {
        await db.from("accounting_connection").update({ last_error: "Connecting failed: " + (tj.error_description || tj.error || t.status), oauth_state: null }).eq("id", 1);
        return go("failed");
      }
      // which business: the lead one (Purgō will only have one)
      let biz: any = null;
      try { const b = await fetch(SAGE_API + "businesses", { headers: { Authorization: "Bearer " + tj.access_token, Accept: "application/json" } }).then(r => r.json()); biz = items(b).find((x: any) => x.is_lead) || items(b)[0] || null; } catch { /* lead business is used */ }
      await db.from("accounting_connection").update({ refresh_token: tj.refresh_token, refresh_expires_at: tj.refresh_token_expires_in ? new Date(Date.now() + tj.refresh_token_expires_in * 1000).toISOString() : null,
        business_id: biz?.id || null, business_name: biz?.name || biz?.displayed_as || null, connected_at: new Date().toISOString(), oauth_state: null, oauth_state_at: null, last_error: null }).eq("id", 1);
      // sensible first choices (the admin can change them)
      try { await autoChoose(db); } catch (e) { console.error("auto choose", (e as Error).message); }
      return go("connected");
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    /* ---------- customer, by link ---------- */
    if (action === "view" || action === "pay") {
      const token = String(body.token || "");
      if (!UUID.test(token)) return reply({ error: "This link isn't valid. Please check you copied all of it." }, 404);
      return action === "view" ? await publicView(db, token) : await publicPay(db, token);
    }

    /* ---------- scheduled run ---------- */
    if (action === "sync") {
      const conn = await getConn(db);
      const sentKey = req.headers.get("x-purgo-key");
      const ok = (conn.cron_key && sentKey && sentKey === conn.cron_key) || await who(db, req);
      if (!ok) return reply({ error: "Not allowed" }, 401);
      let emailed = 0, sageRes: any = null;
      try { emailed = await sendQueued(db); } catch (e) { console.error("send queued", (e as Error).message); }
      try { sageRes = await sageSync(db); }
      catch (e) { await db.from("accounting_connection").update({ last_error: String((e as Error).message).slice(0, 500), last_sync: new Date().toISOString() }).eq("id", 1); return reply({ emailed, error: (e as Error).message }, 500); }
      return reply({ emailed, sage: sageRes });
    }

    const me = await who(db, req);
    if (!me) return reply({ error: "Please sign in again." }, 401);

    if (action === "status") {
      const c = await getConn(db);
      return reply({
        stripe: { configured: stripeConfigured(), test: env("STRIPE_SECRET_KEY").startsWith("sk_test_") },
        sage: { configured: sageConfigured(), connected: !!(sageConfigured() && c.refresh_token), business: c.business_name || null,
          ledger: c.sales_ledger_name || null, bank: c.bank_account_name || null, card: c.card_account_name || null,
          ready: !!(c.refresh_token && c.sales_ledger_id && c.tax_none_id && c.bank_account_id),
          lastSync: c.last_sync || null, lastError: me.admin ? (c.last_error || null) : null, expires: c.refresh_expires_at || null,
          callback: me.admin ? selfUrl() : undefined },
      });
    }

    if (action === "sage_connect") {
      if (!me.admin) return reply({ error: "Only the admin can connect Sage." }, 403);
      if (!sageConfigured()) return reply({ error: "The Sage app details haven't been added to the Portal yet." }, 400);
      const ret = String(body.returnTo || "");
      if (!OK_ORIGINS.some(r => r.test(ret))) return reply({ error: "Unknown Portal address." }, 400);
      const state = crypto.randomUUID();
      await db.from("accounting_connection").update({ oauth_state: state, oauth_state_at: new Date().toISOString(), oauth_return: ret, connected_by_name: me.name }).eq("id", 1);
      const q = new URLSearchParams({ filter: "apiv3.1", response_type: "code", client_id: env("SAGE_CLIENT_ID"), redirect_uri: selfUrl(), scope: "full_access", state, country: "gb", locale: "en-GB" });
      return reply({ url: "https://www.sageone.com/oauth2/auth/central?" + q });
    }

    if (action === "sage_disconnect") {
      if (!me.admin) return reply({ error: "Only the admin can disconnect Sage." }, 403);
      const c = await getConn(db);
      if (c.refresh_token) await fetch("https://oauth.accounting.sage.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env("SAGE_CLIENT_ID"), client_secret: env("SAGE_CLIENT_SECRET"), token: c.refresh_token }) }).catch(() => {});
      await db.from("accounting_connection").update({ refresh_token: null, refresh_expires_at: null }).eq("id", 1);
      return reply({ ok: true });
    }

    if (action === "sage_options") {
      if (!me.admin) return reply({ error: "Only the admin can change this." }, 403);
      const c = await getConn(db); const tok = await sageToken(db, c);
      const [led, banks, tax] = await Promise.all([
        sage(tok, c, "ledger_accounts?visible_in=sales&items_per_page=200&attributes=nominal_code"),
        sage(tok, c, "bank_accounts?items_per_page=100"),
        sage(tok, c, "tax_rates?items_per_page=100"),
      ]);
      return reply({
        ledgers: items(led).map((x: any) => ({ id: x.id, name: x.displayed_as })),
        banks: items(banks).map((x: any) => ({ id: x.id, name: x.displayed_as })),
        taxRates: items(tax).map((x: any) => ({ id: x.id, name: x.displayed_as })),
        chosen: { ledger: c.sales_ledger_id, bank: c.bank_account_id, card: c.card_account_id, taxStandard: c.tax_standard_id, taxNone: c.tax_none_id },
      });
    }

    if (action === "sage_choose") {
      if (!me.admin) return reply({ error: "Only the admin can change this." }, 403);
      const pick = (k: string) => (body[k] && typeof body[k] === "object" && body[k].id) ? body[k] : null;
      const upd: Record<string, unknown> = {};
      const l = pick("ledger"), b = pick("bank"), cd = pick("card"), ts = pick("taxStandard"), tn = pick("taxNone");
      if (l) Object.assign(upd, { sales_ledger_id: String(l.id), sales_ledger_name: String(l.name || "") });
      if (b) Object.assign(upd, { bank_account_id: String(b.id), bank_account_name: String(b.name || "") });
      if (cd) Object.assign(upd, { card_account_id: String(cd.id), card_account_name: String(cd.name || "") });
      if (ts) upd.tax_standard_id = String(ts.id);
      if (tn) upd.tax_none_id = String(tn.id);
      await db.from("accounting_connection").update(upd).eq("id", 1);
      return reply({ ok: true });
    }

    if (action === "send") {
      const id = String(body.invoiceId || "");
      if (!UUID.test(id)) return reply({ error: "Unknown invoice" }, 400);
      const r = await sendInvoice(db, id, { to: cleanEmails(body.to), cc: cleanEmails(body.cc), subject: body.subject ? String(body.subject).slice(0, 300) : undefined,
        message: body.message ? String(body.message).slice(0, 6000) : undefined, by: { id: me.id, name: me.name } });
      // copy to Sage straight away rather than waiting for the next run
      sageSync(db).catch(e => console.error("sage after send", (e as Error).message));
      return reply(r);
    }

    if (action === "preview") {   // the default email text for the send dialog
      const id = String(body.invoiceId || "");
      const L = UUID.test(id) ? await loadInvoice(db, { id }) : null;
      if (!L) return reply({ error: "Unknown invoice" }, 400);
      return reply({ message: defaultMessage(L, me.name), subject: `Your Purgō invoice ${invLabel(L.inv.invoice_no)}`, link: `${PORTAL()}/i?t=${L.inv.share_token}`, cardPay: stripeConfigured() });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: (e as Error).message || String(e) }, 500);
  }
});

// first choices after connecting: Sales (4000), the Tide account if there is one, standard and no-VAT rates
async function autoChoose(db: Db) {
  const c = await getConn(db); const tok = await sageToken(db, c);
  const upd: Record<string, unknown> = {};
  if (!c.sales_ledger_id) {
    const l = items(await sage(tok, c, "ledger_accounts?visible_in=sales&items_per_page=200"));
    const s = l.find((x: any) => /\(4000\)/.test(x.displayed_as)) || l.find((x: any) => /sales/i.test(x.displayed_as)) || l[0];
    if (s) Object.assign(upd, { sales_ledger_id: s.id, sales_ledger_name: s.displayed_as });
  }
  if (!c.bank_account_id) {
    const b = items(await sage(tok, c, "bank_accounts?items_per_page=100"));
    const t = b.find((x: any) => /tide/i.test(x.displayed_as)) || b.find((x: any) => /current/i.test(x.displayed_as)) || b[0];
    if (t) Object.assign(upd, { bank_account_id: t.id, bank_account_name: t.displayed_as });
    const st = b.find((x: any) => /stripe/i.test(x.displayed_as));
    if (st && !c.card_account_id) Object.assign(upd, { card_account_id: st.id, card_account_name: st.displayed_as });
  }
  if (!c.tax_none_id || !c.tax_standard_id) {
    const t = items(await sage(tok, c, "tax_rates?items_per_page=100"));
    const std = t.find((x: any) => x.id === "GB_STANDARD") || t.find((x: any) => /standard/i.test(x.displayed_as));
    const none = t.find((x: any) => x.id === "GB_NO_TAX") || t.find((x: any) => /no vat|not applicable|no tax/i.test(x.displayed_as)) || t.find((x: any) => x.id === "GB_ZERO");
    if (std) upd.tax_standard_id = std.id;
    if (none) upd.tax_none_id = none.id;
  }
  if (Object.keys(upd).length) await db.from("accounting_connection").update(upd).eq("id", 1);
}
