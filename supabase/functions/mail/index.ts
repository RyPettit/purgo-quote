// Purgō: the Portal's mailbox (Google Workspace / Gmail).
// Turn "Verify JWT" OFF: Google's sign-in redirect has no Portal login, so this function checks callers itself.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (OAuth client in Google Cloud, redirect URI = this function's URL),
// The scheduled sync job proves itself with mail_connection.cron_key (server-only), so no extra secret is needed.
//
// POST JSON (signed-in staff unless noted):
//   {action:"status"}                         -> {configured, connected, address, lastSync, lastError}
//   {action:"connect", returnTo}   (admin)    -> {url}   open it, approve, Google sends you back to the Portal
//   {action:"disconnect"}          (admin)    -> {ok}
//   {action:"send", to, cc, subject, html, text, logText, attachments, accountId, quoteId, threadId} -> {id, threadId, from}
//   {action:"sync"}  (x-purgo-key or staff)   -> {added}
// GET ?code=…&state=…  Google's redirect after approving.
import { cors, reply, serviceClient, googleConfigured, getConn, accessToken, gmail, sendMail, cleanEmails } from "../_shared/gmail.ts";

const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const OK_ORIGINS = [/^https:\/\/(portal|quote)\.purgo-clean\.com$/, /^https:\/\/([a-z0-9-]+\.)?purgo-quote\.pages\.dev$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selfUrl = () => Deno.env.get("SUPABASE_URL")! + "/functions/v1/mail";

type Db = ReturnType<typeof serviceClient>;

async function who(db: Db, req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: p } = await db.from("profiles").select("name,role,active").eq("id", data.user.id).maybeSingle();
  return p && p.active && (p.role === "admin" || p.role === "staff") ? { id: data.user.id, name: p.name as string, admin: p.role === "admin" } : null;
}

/* ---------- reading messages ---------- */
const decode = (s: string) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))); };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
function findPart(p: Part, type: string): string | null {
  if (p.mimeType === type && p.body?.data) return decode(p.body.data);
  for (const c of p.parts || []) { const r = findPart(c, type); if (r) return r; }
  return null;
}
const emailsIn = (s: string) => (s.match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g) || []).map(x => x.toLowerCase());
function bodyText(payload: Part): string {
  let t = findPart(payload, "text/plain");
  if (!t) { const h = findPart(payload, "text/html") || ""; t = h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
  // drop the quoted earlier conversation
  t = t.split(/\r?\n(?:On .{5,200}wrote:|-{2,}\s*Original Message|From: .+\r?\nSent: )/)[0];
  t = t.split(/\r?\n/).filter(l => !/^>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.slice(0, 6000);
}

async function matchAccount(db: Db, emails: string[], threadId: string | null): Promise<string | null> {
  if (threadId) { const { data } = await db.from("account_comms").select("account_id").eq("thread_id", threadId).limit(1); if (data && data[0]) return data[0].account_id; }
  if (!emails.length) return null;
  const { data: a } = await db.from("accounts").select("id,email").not("email", "is", null);
  for (const e of emails) { const hit = (a || []).find(x => (x.email || "").toLowerCase() === e); if (hit) return hit.id; }
  const { data: c } = await db.from("account_contacts").select("account_id,email").not("email", "is", null);
  for (const e of emails) { const hit = (c || []).find(x => (x.email || "").toLowerCase() === e); if (hit) return hit.account_id; }
  return null;
}

async function sync(db: Db): Promise<number> {
  const conn = await getConn(db); if (!conn) return 0;
  const token = await accessToken(conn);
  const me = (conn.address || "").toLowerCase();
  let added = 0, ids: string[] = [], newHistory = conn.history_id;
  try {
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ startHistoryId: conn.history_id || "1", historyTypes: "messageAdded", maxResults: "200" }); if (page) q.set("pageToken", page);
      const h = await gmail(token, "history?" + q);
      for (const rec of h.history || []) for (const m of rec.messagesAdded || []) ids.push(m.message.id);
      newHistory = h.historyId || newHistory; page = h.nextPageToken;
    } while (page && ids.length < 1000);
  } catch (e) {
    if ((e as { status?: number }).status === 404) { const p = await gmail(token, "profile"); newHistory = p.historyId; ids = []; }   // too old: start again from now
    else throw e;
  }
  ids = [...new Set(ids)];
  if (ids.length) {
    const { data: known } = await db.from("account_comms").select("message_id").in("message_id", ids);
    const skip = new Set((known || []).map(k => k.message_id));
    for (const id of ids) {
      if (skip.has(id)) continue;
      let m;
      try { m = await gmail(token, `messages/${id}?format=full`); } catch { continue; }   // deleted since
      const labels: string[] = m.labelIds || [];
      if (labels.some(l => ["DRAFT", "SPAM", "TRASH", "CHAT"].includes(l))) continue;
      const H = (n: string) => ((m.payload?.headers || []).find((x: { name: string }) => x.name.toLowerCase() === n.toLowerCase())?.value || "") as string;
      const from = emailsIn(H("From")), to = [...emailsIn(H("To")), ...emailsIn(H("Cc"))];
      const out = labels.includes("SENT") || from.includes(me);
      const others = (out ? to : from).filter(e => e !== me && !e.endsWith("@purgo-clean.com"));
      const account = await matchAccount(db, others, m.threadId);
      if (!account) continue;            // not a customer we know: leave it in the mailbox only
      const subject = H("Subject") || "(no subject)";
      const at = m.internalDate ? new Date(+m.internalDate).toISOString() : new Date().toISOString();
      const { error } = await db.from("account_comms").insert({ account_id: account, kind: "email", direction: out ? "out" : "in", subject, body: bodyText(m.payload || {}),
        from_addr: from[0] || null, to_addr: to.join(", ") || null, message_id: id, thread_id: m.threadId, occurred_at: at, created_by_name: out ? "Email" : null, meta: { via: "gmail" } });
      if (!error) {
        added++;
        if (!out) {
          const { data: acc } = await db.from("accounts").select("name").eq("id", account).maybeSingle();
          await db.from("notifications").insert({ kind: "email_in", title: `Email from ${acc?.name || from[0]}`, body: subject, account_id: account });
        }
      }
    }
  }
  await db.from("mail_connection").update({ history_id: newHistory, last_sync: new Date().toISOString(), last_error: null }).eq("id", 1);
  return added;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = serviceClient();
  try {
    /* ---------- Google's redirect back after approving ---------- */
    if (req.method === "GET") {
      const u = new URL(req.url);
      const code = u.searchParams.get("code"), state = u.searchParams.get("state"), err = u.searchParams.get("error");
      const { data: row } = await db.from("mail_connection").select("oauth_state,oauth_state_at,oauth_return,connected_by_name").eq("id", 1).maybeSingle();
      const back = (row?.oauth_return || "https://portal.purgo-clean.com") + "/#admin";
      const go = (q: string) => new Response(null, { status: 302, headers: { Location: back.replace("/#admin", "/?mail=" + q + "#admin") } });
      if (err) return go("cancelled");
      if (!code || !state || !row || row.oauth_state !== state || Date.now() - new Date(row.oauth_state_at).getTime() > 15 * 60e3) return go("expired");
      const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, redirect_uri: selfUrl(), grant_type: "authorization_code" }) });
      const tj = await t.json();
      if (!t.ok || !tj.refresh_token) return go("failed");
      const prof = await gmail(tj.access_token, "profile");
      await db.from("mail_connection").update({ address: prof.emailAddress, refresh_token: tj.refresh_token, history_id: String(prof.historyId), connected_at: new Date().toISOString(),
        oauth_state: null, oauth_state_at: null, last_error: null }).eq("id", 1);
      return go("connected");
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    /* ---------- scheduled sync ---------- */
    if (action === "sync") {
      const { data: k } = await db.from("mail_connection").select("cron_key").eq("id", 1).maybeSingle();
      const sent = req.headers.get("x-purgo-key");
      const ok = (k?.cron_key && sent && sent === k.cron_key) || await who(db, req);
      if (!ok) return reply({ error: "Not allowed" }, 401);
      if (!googleConfigured()) return reply({ added: 0, connected: false });
      try { return reply({ added: await sync(db) }); }
      catch (e) { await db.from("mail_connection").update({ last_error: String((e as Error).message).slice(0, 500) }).eq("id", 1); return reply({ error: (e as Error).message }, 500); }
    }

    const me = await who(db, req);
    if (!me) return reply({ error: "Please sign in again." }, 401);

    if (action === "status") {
      const { data } = await db.from("mail_connection").select("address,refresh_token,last_sync,last_error,connected_at").eq("id", 1).maybeSingle();
      return reply({ configured: googleConfigured(), connected: !!(data && data.refresh_token && googleConfigured()), address: data?.refresh_token ? data.address : null,
        lastSync: data?.last_sync || null, lastError: me.admin ? (data?.last_error || null) : null, connectedAt: data?.connected_at || null });
    }

    if (action === "connect") {
      if (!me.admin) return reply({ error: "Only the admin can connect the mailbox." }, 403);
      if (!googleConfigured()) return reply({ error: "The Google sign-in details haven't been added to the Portal yet." }, 400);
      const ret = String(body.returnTo || "");
      if (!OK_ORIGINS.some(r => r.test(ret))) return reply({ error: "Unknown Portal address." }, 400);
      const state = crypto.randomUUID();
      await db.from("mail_connection").upsert({ id: 1, oauth_state: state, oauth_state_at: new Date().toISOString(), oauth_return: ret, connected_by_name: me.name });
      const q = new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, redirect_uri: selfUrl(), response_type: "code", scope: SCOPES,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
      return reply({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + q });
    }

    if (action === "disconnect") {
      if (!me.admin) return reply({ error: "Only the admin can disconnect the mailbox." }, 403);
      const conn = await getConn(db);
      if (conn?.refresh_token) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(conn.refresh_token), { method: "POST" }).catch(() => {});
      await db.from("mail_connection").update({ refresh_token: null, address: null, history_id: null }).eq("id", 1);
      return reply({ ok: true });
    }

    if (action === "send") {
      if (!googleConfigured()) return reply({ error: "Email isn't connected yet." }, 400);
      const conn = await getConn(db); if (!conn) return reply({ error: "Email isn't connected yet." }, 400);
      const to = cleanEmails(body.to), cc = cleanEmails(body.cc);
      if (!to.length) return reply({ error: "Add the customer's email address." }, 400);
      const subject = String(body.subject || "").slice(0, 300) || "Purgō";
      const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 5).map((a: { name: string; type: string; b64: string }) => ({ name: String(a.name || "file").slice(0, 120), type: String(a.type || "application/octet-stream"), b64: String(a.b64 || "") })) : [];
      if (attachments.reduce((s: number, a: { b64: string }) => s + a.b64.length, 0) > 18e6) return reply({ error: "Attachments are too big to email." }, 400);
      const token = await accessToken(conn);
      const sent = await sendMail(token, { from: conn.address!, fromName: "Purgō", to, cc, subject, html: String(body.html || ""), text: String(body.text || ""), attachments, threadId: body.threadId || undefined });
      const accountId = UUID.test(String(body.accountId || "")) ? body.accountId : null;
      const quoteId = UUID.test(String(body.quoteId || "")) ? body.quoteId : null;
      if (accountId) await db.from("account_comms").insert({ account_id: accountId, kind: "email", direction: "out", subject, body: String(body.logText || body.text || "").slice(0, 6000),
        from_addr: conn.address, to_addr: [...to, ...cc].join(", "), quote_id: quoteId, message_id: sent.id, thread_id: sent.threadId, created_by: me.id, created_by_name: me.name,
        meta: { via: "gmail", attachments: attachments.map((a: { name: string }) => a.name) } });
      return reply({ id: sent.id, threadId: sent.threadId, from: conn.address });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: (e as Error).message || String(e) }, 500);
  }
});
