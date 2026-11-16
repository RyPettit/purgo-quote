// Purgō: customer logins for the portfolio customer portal.
// Admins create, re-issue and remove customer accounts from inside the app.
// A customer account is never staff: its role is set server-side (app_metadata) and the
// database rules give it nothing but the customer_portfolio() view of its own portfolios.
//
// Turn "Verify JWT" OFF for this function. It checks the caller itself: the request must carry
// a signed-in, switched-on Purgō Admin.
//
// Actions (POST JSON):
//   {action:"create", portfolioId, email, name}  -> {password|null, existing, userId}
//   {action:"reset",  userId}                    -> {password}
//   {action:"remove", portfolioId, userId}       -> {ok}
//   {action:"list",   portfolioId}               -> {customers:[{userId,email,name,active,lastSignIn}]}
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// e.g. "Kt7m-Qw4r-Hp9x": easy to read out, upper + lower + digits
function makePassword(): string {
  const lo = "abcdefghjkmnpqrstuvwxyz", up = "ABCDEFGHJKLMNPQRSTUVWXYZ", dg = "23456789";
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const group = () => pick(up) + pick(lo) + pick(dg) + pick(lo);
  return `${group()}-${group()}-${group()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    const token = (req.headers.get("authorization") || "").replace(/^bearer\s+/i, "");
    if (!token) return reply({ error: "Please sign in again." }, 401);
    const { data: who } = await db.auth.getUser(token);
    if (!who?.user) return reply({ error: "Please sign in again." }, 401);
    const { data: me } = await db.from("profiles").select("name,role,active").eq("id", who.user.id).maybeSingle();
    if (!me || !me.active || me.role !== "admin") return reply({ error: "Only an admin can manage customer logins." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    const customerProfile = async (id: string) => {
      if (!UUID.test(id)) return null;
      const { data } = await db.from("profiles").select("id,email,name,role,active").eq("id", id).maybeSingle();
      return data && data.role === "customer" ? data : null;
    };

    if (action === "list") {
      const pid = String(body.portfolioId || "");
      if (!UUID.test(pid)) return reply({ error: "Unknown portfolio." }, 400);
      const { data: links, error } = await db.from("portfolio_customers").select("user_id, created_at, added_by_name, profiles(email,name,active)").eq("portfolio_id", pid).order("created_at");
      if (error) return reply({ error: error.message }, 400);
      const customers = [];
      for (const l of links || []) {
        const { data: u } = await db.auth.admin.getUserById(l.user_id);
        const p = (l as any).profiles || {};
        customers.push({ userId: l.user_id, email: p.email, name: p.name, active: p.active, added: l.created_at, addedBy: l.added_by_name, lastSignIn: u?.user?.last_sign_in_at || null });
      }
      return reply({ customers });
    }

    if (action === "create") {
      const pid = String(body.portfolioId || "");
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim().slice(0, 80);
      if (!UUID.test(pid)) return reply({ error: "Unknown portfolio." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ error: "Enter a valid email address." }, 400);
      const { data: pf } = await db.from("portfolios").select("id").eq("id", pid).maybeSingle();
      if (!pf) return reply({ error: "Unknown portfolio." }, 400);

      let { data: prof } = await db.from("profiles").select("id,role,active").eq("email", email).maybeSingle();
      let password: string | null = null;
      if (prof) {
        if (prof.role !== "customer") return reply({ error: "That email belongs to a Purgō staff account. Use a different email for the customer login." }, 400);
        if (!prof.active) await db.from("profiles").update({ active: true }).eq("id", prof.id);
      } else {
        password = makePassword();
        const { data: created, error } = await db.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { name: name || email.split("@")[0] },
          app_metadata: { purgo_role: "customer" },
        });
        if (error || !created?.user) return reply({ error: error?.message || "Could not create the login." }, 400);
        prof = { id: created.user.id, role: "customer", active: true };
        // the sign-up trigger already made it a customer; make sure, and set the name
        await db.from("profiles").update({ role: "customer", ...(name ? { name } : {}) }).eq("id", prof.id);
      }
      const { error: le } = await db.from("portfolio_customers").upsert({ portfolio_id: pid, user_id: prof.id, added_by_name: me.name }, { onConflict: "portfolio_id,user_id" });
      if (le) return reply({ error: le.message }, 400);
      return reply({ ok: true, userId: prof.id, password, existing: !password });
    }

    if (action === "reset") {
      const p = await customerProfile(String(body.userId || ""));
      if (!p) return reply({ error: "That is not a customer login." }, 400);
      const password = makePassword();
      const { error } = await db.auth.admin.updateUserById(p.id, { password });
      if (error) return reply({ error: error.message }, 400);
      if (!p.active) await db.from("profiles").update({ active: true }).eq("id", p.id);
      return reply({ ok: true, password });
    }

    if (action === "remove") {
      const pid = String(body.portfolioId || "");
      const p = await customerProfile(String(body.userId || ""));
      if (!p || !UUID.test(pid)) return reply({ error: "That is not a customer login." }, 400);
      await db.from("portfolio_customers").delete().eq("portfolio_id", pid).eq("user_id", p.id);
      const { count } = await db.from("portfolio_customers").select("*", { count: "exact", head: true }).eq("user_id", p.id);
      if (!count) await db.from("profiles").update({ active: false }).eq("id", p.id); // no portfolios left: switch the login off
      return reply({ ok: true, switchedOff: !count });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500);
  }
});
