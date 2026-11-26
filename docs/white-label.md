# Making the Portal white-label

Goal: one Portal that runs everything for a trade business (quotes, CRM, jobs and rounds, invoicing,
payments, reminders, email), which can later be set up for any trade business under its own name and brand.

## Rules for new work
- **No business details in code.** Name, phone, email, website and sign-off come from `business_profile`
  (Admin → Reminders → Your business). Anything a customer reads should be an editable template in
  `message_templates` with `{placeholders}` (see `supabase/messages.sql`, `supabase/functions/_shared/messages.ts`).
- **Settings, not constants.** Prices, services, terms, timings and on/off switches live in settings tables
  the admin can edit, with sensible defaults seeded by the `.sql` files.
- **Trade-neutral names** in tables and code (jobs, visits, rounds, services), with the trade's own words as data.
- **Integrations are optional and per business** (Gmail, Stripe, Sage, Google Calendar): the Portal works without them.

## Done
- `business_profile` and `message_templates` (appointment reminder, payment reminders), editable in Admin → Reminders.
- Per-customer choice of how reminders arrive (`accounts.remind_by`: email, text, both, none).
- Text messages through a choice of provider (`_shared/sms.ts`), with the sender name in `business_profile.sms_sender`.

## Still hard-coded (to move into settings over time)
Counted on 26 Nov 2026 (mentions of Purgō, its phone or domain):
- Email signature `SIG_HTML` in `supabase/functions/_shared/gmail.ts` (logo, phone, company number, services line).
- Invoice emails and pages: `supabase/functions/invoicing/index.ts` (default message, "from" name, phone, bank account name), `i.html`, `invoices.js`.
- Quote emails and pages: `supabase/functions/quote-public`, `q.html`, `mail.js`, `purgo.js`, `portfolio.js`, `portal.js`.
- `config.js`, Portal addresses (`portal.purgo-clean.com`), the project id check in `DEV()`, Sage contact refs.
- Service list and pricing model (window, gutter, roof, pressure washing) in `purgo.js` and `jobs.js`.
- Brand colours and logo in `purgo.css` and `brand/`.
