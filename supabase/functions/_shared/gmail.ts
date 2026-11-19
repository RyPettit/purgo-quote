// Purgō: Gmail helpers shared by the mail and quote-public functions.
// The connected mailbox (one per Portal) is kept in public.mail_connection, which only the server can read.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-purgo-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  let svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!svc) { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); svc = (Object.values(k)[0] as string) ?? ""; } catch { /* ignore */ } }
  return createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
}

// the Google sign-in details (stray spaces or line breaks from copy and paste are ignored)
export const gid = () => (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").replace(/\s+/g, "");
export const gsecret = () => (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").replace(/\s+/g, "");
export const googleConfigured = () => !!(gid() && gsecret());

export type Conn = { address: string | null; refresh_token: string | null; history_id: string | null; connected_at: string | null; last_sync: string | null; last_error: string | null };
export async function getConn(db: SupabaseClient): Promise<Conn | null> {
  const { data } = await db.from("mail_connection").select("address,refresh_token,history_id,connected_at,last_sync,last_error").eq("id", 1).maybeSingle();
  return data && data.refresh_token ? data as Conn : null;
}

export async function accessToken(conn: Conn): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: gid(), client_secret: gsecret(), refresh_token: conn.refresh_token!, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Google sign-in for the mailbox has expired. Reconnect it in Admin → Email. (" + (j.error_description || j.error || r.status) + ")");
  return j.access_token;
}

export async function gmail(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token } });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ("Gmail error " + r.status)) as Error & { status?: number }; e.status = r.status; throw e; }
  return j;
}

/* ---------- building an email ---------- */
const enc = new TextEncoder();
export function b64(bytes: Uint8Array): string { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const b64s = (s: string) => b64(enc.encode(s));
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
const hdr = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64s(s)}?=`;
const addr = (name: string | undefined, email: string) => name ? `${hdr(name.replace(/["\r\n]/g, ""))} <${email}>` : email;
export const cleanEmails = (s: string | string[] | undefined) =>
  (Array.isArray(s) ? s : String(s || "").split(/[,;]/)).map(x => x.trim()).filter(x => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x));

export type Mail = { fromName?: string; from: string; to: string[]; cc?: string[]; replyTo?: string; subject: string; html: string; text: string;
  attachments?: { name: string; type: string; b64: string }[]; threadId?: string };

export function buildRaw(m: Mail): string {
  const id = crypto.randomUUID().replace(/-/g, "");
  const alt = "alt_" + id, mix = "mix_" + id;
  const lines = [
    `From: ${addr(m.fromName, m.from)}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc && m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${hdr(m.subject)}`,
    "MIME-Version: 1.0",
  ];
  const altPart = [
    `--${alt}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(b64s(m.text)),
    `--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(b64s(m.html)),
    `--${alt}--`, "",
  ];
  let body: string[];
  if (m.attachments && m.attachments.length) {
    body = [`Content-Type: multipart/mixed; boundary="${mix}"`, "", `--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...altPart];
    for (const a of m.attachments) {
      const nm = a.name.replace(/["\r\n]/g, "");
      body.push(`--${mix}`, `Content-Type: ${a.type}; name="${nm}"`, `Content-Disposition: attachment; filename="${nm}"`, "Content-Transfer-Encoding: base64", "", wrap(a.b64.replace(/\s/g, "")));
    }
    body.push(`--${mix}--`, "");
  } else body = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", ...altPart];
  const raw = [...lines, ...body].join("\r\n");
  return b64s(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendMail(token: string, m: Mail): Promise<{ id: string; threadId: string }> {
  const payload: Record<string, string> = { raw: buildRaw(m) };
  if (m.threadId) payload.threadId = m.threadId;
  return await gmail(token, "messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

// send from the connected mailbox if there is one; returns null when email isn't connected
export async function trySend(db: SupabaseClient, m: Omit<Mail, "from">): Promise<{ id: string; threadId: string; from: string } | null> {
  if (!googleConfigured()) return null;
  const conn = await getConn(db); if (!conn || !conn.address) return null;
  const token = await accessToken(conn);
  const r = await sendMail(token, { ...m, from: conn.address });
  return { ...r, from: conn.address };
}

export const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// a plain, branded email body: paragraphs of text, optional button
export function simpleHtml(paras: string[], button?: { text: string; url: string }): string {
  const F = "font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;";
  return `<div style="${F}color:#132f47;font-size:15px;line-height:1.5;max-width:600px">` +
    paras.map(p => `<p style="margin:0 0 12px">${escHtml(p).replace(/\n/g, "<br>")}</p>`).join("") +
    (button ? `<p style="margin:16px 0"><a href="${escHtml(button.url)}" style="display:inline-block;background:#132f47;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">${escHtml(button.text)}</a></p>` : "") +
    SIG_HTML + `</div>`;
}
// Purgō's email signature (brand/email-signature.html); the logo is hosted on the Portal so email apps show it
export const SIG_HTML = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:560px;font-family:Calibri,Arial,Helvetica,sans-serif;margin-top:18px"><tr><td colspan="3" style="height:4px;line-height:4px;font-size:0;background:#132F47;background-image:linear-gradient(90deg,#132F47 0%,#132F47 55%,#326986 80%,#6DA7C4 100%);">&nbsp;</td></tr><tr><td colspan="3" style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr><tr><td valign="middle" style="padding-right:18px;"><a href="https://www.purgo-clean.com" style="text-decoration:none;"><img src="https://portal.purgo-clean.com/brand/email-logo.png" width="172" height="48" alt="Purgō" style="display:block;border:0;width:172px;height:48px;"></a></td><td style="width:1px;background:#C6E1EF;font-size:0;">&nbsp;</td><td valign="middle" style="padding-left:18px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:13px;line-height:19px;color:#132F47;"><div style="font-size:10px;letter-spacing:1.5px;font-weight:bold;color:#326986;">EXTERIOR CLEANING SPECIALISTS</div><div><span style="color:#6DA7C4;">T</span>&nbsp; <a href="tel:+447930877034" style="color:#132F47;text-decoration:none;font-weight:bold;">07930 877034</a></div><div><span style="color:#6DA7C4;">E</span>&nbsp; <a href="mailto:hello@purgo-clean.com" style="color:#132F47;text-decoration:none;">hello@purgo-clean.com</a></div><div><span style="color:#6DA7C4;">W</span>&nbsp; <a href="https://www.purgo-clean.com" style="color:#132F47;text-decoration:none;">www.purgo-clean.com</a></div><div style="color:#326986;">Serving Hull &amp; East Yorkshire</div></td></tr><tr><td colspan="3" style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr><tr><td colspan="3" style="border-top:1px solid #C6E1EF;padding-top:10px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1px;color:#132F47;">GUTTER CLEANING <span style="color:#6DA7C4;">&nbsp;•&nbsp;</span> ROOF CLEANING <span style="color:#6DA7C4;">&nbsp;•&nbsp;</span> WINDOW CLEANING <span style="color:#6DA7C4;">&nbsp;•&nbsp;</span> PRESSURE WASHING</td></tr><tr><td colspan="3" style="padding-top:8px;font-family:Calibri,Arial,Helvetica,sans-serif;font-size:10px;line-height:14px;color:#7a8a99;">Purgō Clean Ltd · Registered in England &amp; Wales · Company No. 17451681<br>Registered office: 103 Southfield, Hessle, HU13 0ET</td></tr></table>`;
