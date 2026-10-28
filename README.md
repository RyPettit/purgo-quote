# Purgō Quote

Quoting tool for Purgō exterior cleaning. Staff sign in, build quotes from the
shared price list and save them; only the admin can see costs and profit or
change prices.

- **Hosting:** Cloudflare Pages, built straight from this repository (no build step).
- **Database and logins:** Supabase (London region).
- **Works offline:** installs as an app on phones; quotes saved without signal
  upload automatically when the phone reconnects.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Supabase project URL and public (anon/publishable) key |
| `supabase/schema.sql` | Tables, access rules and starting prices. Safe to re-run. |
| `supabase/make-admin.sql` | Makes your account the admin |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and phone install |
| `postcodes.json` | Postcode coordinates within ~35 miles of base (ONS/OS open data via dwyl, 2017) |
| `vendor/` | Supabase client library, pinned |

## Who can do what

| | Admin | Staff |
|---|---|---|
| Build and save quotes | Yes | Yes |
| See every saved quote, change status | Yes | Yes |
| See costs, labour pay, profit, margins, fuel | Yes | No (never sent to their device) |
| Change prices, chemicals, fuel | Yes | No |
| Add, switch off or promote staff | Yes | No |
| Delete quotes or addresses | Yes | No |

These rules are enforced by the database, not just hidden in the app.

## First-time setup

1. **Supabase:** SQL Editor → New query → paste `supabase/schema.sql` → Run.
2. **Your login:** Authentication → Users → Add user → Create new user (your email,
   a password, tick *Auto Confirm User*).
3. **Make yourself admin:** SQL Editor → paste `supabase/make-admin.sql` (check the
   email) → Run.
4. **Password reset emails:** Authentication → URL Configuration → set *Site URL* to
   `https://quote.purgo-clean.com`.
5. **Cloudflare Pages:** Workers & Pages → Create → Pages → Connect to Git → pick
   this repo. Framework preset: *None*. Build command: *(blank)*. Output directory: `/`.
6. **Domain:** in the Pages project → Custom domains → add `quote.purgo-clean.com`,
   then at 123 Reg add the CNAME record Cloudflare shows you.

## Adding staff

Supabase → Authentication → Users → Add user → Create new user, tick
*Auto Confirm User*. They appear in the app under Admin → Staff. Switch them off
there when they leave; their quotes stay.

## Making changes

Changes are made in this repository and Cloudflare redeploys within a minute or
two. When app files change, bump `VERSION` in `sw.js` so installed phones show
"A new version is ready".
