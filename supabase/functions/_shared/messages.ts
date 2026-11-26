// Customer messages built from the editable templates in Admin → Reminders (public.message_templates)
// and the business details in public.business_profile. Nothing business-specific lives in code here,
// so the Portal can be run for any trade business.
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { escHtml } from "./gmail.ts";

export type Business = { trading_name: string; legal_name?: string | null; phone?: string | null; email?: string | null; website?: string | null; sign_off?: string | null; sms_sender?: string | null };
export type Template = { key: string; name: string; channel?: string; enabled: boolean; subject: string | null; body: string; send_hour: number | null };

export async function getBusiness(db: SupabaseClient): Promise<Business> {
  const { data } = await db.from("business_profile").select("*").eq("id", 1).maybeSingle();
  return data || { trading_name: "Purgō", phone: "07930 877034", email: "hello@purgo-clean.com", website: "www.purgo-clean.com", sign_off: "Kind regards,\nPurgō" };
}
export async function getTemplate(db: SupabaseClient, key: string): Promise<Template | null> {
  const { data } = await db.from("message_templates").select("key,name,channel,enabled,subject,body,send_hour").eq("key", key).maybeSingle();
  return data || null;
}
export function businessVars(b: Business): Record<string, string> {
  return { business_name: b.trading_name || "", business_phone: b.phone || "", business_email: b.email || "", business_website: b.website || "",
    sign_off: b.sign_off || `Kind regards,\n${b.trading_name || ""}` };
}
// {placeholder} → value; anything unknown is dropped so customers never see braces
export const fill = (text: string, vars: Record<string, string>) =>
  String(text || "").replace(/\{([a-z_]+)\}/g, (_, k) => vars[k] ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// the greeting name: the first name, both first names for "Chris & Amy Gray", or "there" for a business
export function firstName(name: string, kind?: string | null, contact?: string | null) {
  const pick = (s: string) => {
    const n = String(s || "").trim().replace(/\s+/g, " ");
    if (!n) return "";
    if (/\b(ltd|limited|plc|llp|management|properties|lettings|services|group|council|school|church|trust)\b/i.test(n)) return "";
    if (/ & | and /i.test(n)) { const w = n.split(" "); return w.length > 3 ? w.slice(0, -1).join(" ") : n; }
    return n.split(" ")[0];
  };
  if (kind && kind !== "res" && contact) return pick(contact) || "there";
  return pick(name) || (contact ? pick(contact) : "") || "there";
}

export const textToHtml = (text: string) =>
  text.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${escHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

export function ukNow(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, weekday: p.weekday as string };
}
export const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const fmtDate = (d: string | null) => d ? new Date(d + (d.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
