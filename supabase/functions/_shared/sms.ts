// Text messages through a choice of SMS provider, set in the function secrets so any business can use its own:
//   SMS_PROVIDER = "smsworks" (The SMS Works, UK)  with SMS_API_KEY = the JWT API key from thesmsworks.co.uk
//   SMS_PROVIDER = "twilio"                        with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN
// The sender name (up to 11 letters/numbers) is business_profile.sms_sender, or SMS_FROM, or a Twilio number.
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
export const smsProvider = () => {
  const p = env("SMS_PROVIDER").toLowerCase();
  if (p === "twilio" && env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN")) return "twilio";
  if ((p === "smsworks" || p === "") && env("SMS_API_KEY")) return "smsworks";
  return "";
};
export const smsConfigured = () => !!smsProvider();

// a UK mobile in international form (447…), or "" if it isn't one
export function ukMobile(phone: string | null | undefined): string {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("0044")) d = d.slice(2);
  if (d.startsWith("07")) d = "44" + d.slice(1);
  return /^447\d{9}$/.test(d) ? d : "";
}
// letters, numbers and spaces only, 11 at most (what UK networks allow as a sender name)
export const cleanSender = (s: string | null | undefined) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 11);
// texts are charged per 160 characters (153 each once split); characters outside the basic set cut that to 70
export function segments(text: string) {
  const gsm = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|€]*$/.test(text);
  const n = [...text].length, one = gsm ? 160 : 70, many = gsm ? 153 : 67;
  return n <= one ? 1 : Math.ceil(n / many);
}
// plain characters so a text isn't charged at the dearer rate (e.g. ō → o, curly quotes → straight)
export const smsSafe = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "-");

export async function sendSms(to: string, text: string, sender: string): Promise<{ id: string; provider: string }> {
  const p = smsProvider();
  if (!p) throw new Error("Text messages aren't set up yet (Admin → Reminders).");
  const dest = ukMobile(to);
  if (!dest) throw new Error("That isn't a UK mobile number.");
  const body = smsSafe(text);
  if (p === "smsworks") {
    const key = env("SMS_API_KEY");
    const r = await fetch("https://api.thesmsworks.co.uk/v1/message/send", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: /^jwt /i.test(key) ? key : "JWT " + key },
      body: JSON.stringify({ sender: cleanSender(sender) || "Info", destination: dest, content: body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Text not sent: " + (j.message || j.error || (Array.isArray(j.errors) ? j.errors.map((e: any) => e.message || e).join("; ") : "") || r.status));
    return { id: String(j.messageid || j.messageId || ""), provider: p };
  }
  const sid = env("TWILIO_ACCOUNT_SID"), tok = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_FROM") || cleanSender(sender);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: "+" + dest, From: from, Body: body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Text not sent: " + (j.message || r.status));
  return { id: String(j.sid || ""), provider: p };
}
