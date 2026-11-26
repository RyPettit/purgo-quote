/* =====================================================================
   Home: the dashboard. Work booked this week and next, quotes waiting for a
   reply, money owed and overdue, work still to invoice, what's coming up,
   and anything that needs doing. Read-only: every item opens the place to act on it.
   Uses from purgo.js: $, esc, sb, gbp, noLabel, show, ROLE, ME
   ===================================================================== */
const HOME = (()=>{
  const SVC = {windows:'Window cleaning', gutters:'Gutter clean', roof:'Roof clean', pressure:'Pressure washing'};
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const monday = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const day = s => new Date(s + 'T12:00:00');
  const short = s => day(s).toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  const whole = n => '£' + Math.round(n||0).toLocaleString('en-GB');
  const daysAgo = s => Math.round((new Date(ymd(new Date()) + 'T12:00:00') - day(s)) / 864e5);
  const plural = (n, w, ws) => `${n} ${n===1 ? w : (ws || w + 's')}`;
  const sum = (a, f) => a.reduce((t, x) => t + (+f(x) || 0), 0);
  let busy = false, lastLoad = 0, data = null;

  async function load(){
    const now = new Date(), mon = monday(now), today = ymd(now);
    const from = ymd(mon), to = ymd(addDays(mon, 55));               // this week and the 7 after it
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1), lastStart = ymd(lastMonth);
    const back120 = ymd(addDays(now, -120)), back90 = new Date(Date.now() - 90*864e5).toISOString();
    const back14 = new Date(Date.now() - 14*864e5).toISOString();
    const [vis, quo, jobq, inv, pay, done, lines, acc, fbk, yes] = await Promise.all([
      sb.from('visits').select('id,date,start_time,status,price,account_id,accounts(name),jobs(title,service,line)').gte('date', from).lte('date', to).in('status', ['booked','done']).order('date').order('start_time', {nullsFirst:false}).limit(2000),
      sb.from('quotes').select('id,quote_no,customer,address,total,accepted_total,status,sent_at,follow_up_at,viewed_at,accepted_at,declined_at,created_at,account_id').order('created_at', {ascending:false}).limit(1000),
      sb.from('jobs').select('quote_id').not('quote_id', 'is', null).limit(2000),
      sb.from('invoices').select('id,invoice_no,bill_name,total,paid,due_date,issue_date,status,account_id').in('status', ['sent','part_paid']).order('due_date').limit(500),
      sb.from('payments').select('amount,paid_on').gte('paid_on', lastStart).limit(2000),
      sb.from('visits').select('id,date,price,account_id').eq('status', 'done').gte('date', back120).limit(2000),
      sb.from('invoice_lines').select('visit_id').not('visit_id', 'is', null).limit(5000),
      sb.from('accounts').select('id,status,created_at').limit(5000),
      sb.from('feedback').select('id,rating,comment,rated_at,account_id,accounts(name)').gte('rated_at', back90).order('rated_at', {ascending:false}).limit(500),
      sb.from('marketing_sends').select('id,kind,service,response_note,responded_at,account_id,accounts(name)').eq('response', 'yes').gte('responded_at', back14).order('responded_at', {ascending:false}).limit(100),
    ]);
    const err = [vis, quo, jobq, inv, pay, done, lines, acc].find(r => r.error);
    if(err) throw err.error;
    const ratings = fbk.error ? [] : (fbk.data || []);   // the reviews tables may not exist yet
    const invoiced = new Set((lines.data || []).map(l => l.visit_id));
    const booked = new Set((jobq.data || []).map(j => j.quote_id));
    const q = quo.data || [];
    const decided = q.filter(x => (x.accepted_at || x.declined_at || '') >= back90 && (x.status === 'accepted' || x.status === 'declined'));
    return {
      now, mon, today, monthStart, lastStart,
      visits: vis.data || [],
      awaiting: q.filter(x => x.status === 'sent'),
      followDue: q.filter(x => x.status === 'sent' && x.follow_up_at && new Date(x.follow_up_at) <= now),
      drafts: q.filter(x => x.status === 'draft'),
      toBook: q.filter(x => x.status === 'accepted' && !booked.has(x.id)),
      won: decided.filter(x => x.status === 'accepted'), lost: decided.filter(x => x.status === 'declined'),
      quotedMonth: q.filter(x => x.sent_at && x.sent_at >= monthStart),
      open: (inv.data || []).filter(i => (+i.total - +i.paid) > 0.004),
      pays: pay.data || [],
      toInvoice: (done.data || []).filter(v => !invoiced.has(v.id) && +v.price > 0),
      accounts: acc.data || [],
      ratings, low: ratings.filter(f => f.rating <= 3 && f.rated_at >= back14), yes: yes.error ? [] : (yes.data || []),
    };
  }

  function tile(label, big, small, go, tone){
    return `<button type="button" class="hm-tile ${tone||''}" ${go ? `data-go="${go}"` : 'disabled'}><span class="hm-l">${label}</span><span class="hm-b">${big}</span>${small ? `<span class="hm-s">${small}</span>` : ''}</button>`;
  }

  function render(){
    const el = $('view-home'), D = data;
    const greet = (h => h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening')(new Date().getHours());
    const head = `<div class="viewbar"><div><h2 class="vtitle">${greet}${ME && ME.name ? ', ' + esc(String(ME.name).split(' ')[0]) : ''}</h2>
      <p class="sub">${new Date().toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'})}</p></div>
      <div class="vb-actions"><button class="btn sm" type="button" id="hmRefresh">Refresh</button></div></div>`;
    if(!D){ el.innerHTML = head + `<section class="card"><p class="hint">Loading…</p></section>`; wireHead(); return; }

    const wk0 = ymd(D.mon), wk1 = ymd(addDays(D.mon, 7)), wk2 = ymd(addDays(D.mon, 14));
    const inWeek = (a, b) => D.visits.filter(v => v.date >= a && v.date < b);
    const thisW = inWeek(wk0, wk1), nextW = inWeek(wk1, wk2);
    const thisDone = thisW.filter(v => v.status === 'done').length;
    const owed = sum(D.open, i => +i.total - +i.paid);
    const overdue = D.open.filter(i => i.due_date && i.due_date < D.today);
    const overdueAmt = sum(overdue, i => +i.total - +i.paid);
    const paidMonth = sum(D.pays.filter(p => p.paid_on >= D.monthStart), p => p.amount);
    const paidLast = sum(D.pays.filter(p => p.paid_on >= D.lastStart && p.paid_on < D.monthStart), p => p.amount);
    const winRate = D.won.length + D.lost.length ? Math.round(100 * D.won.length / (D.won.length + D.lost.length)) : null;
    const active = D.accounts.filter(a => a.status === 'active').length, leads = D.accounts.filter(a => a.status === 'lead').length;
    const newAcc = D.accounts.filter(a => (a.created_at || '') >= D.monthStart).length;

    const tiles = [
      tile('This week', plural(thisW.length, 'job'), `${whole(sum(thisW, v => v.price))}${thisDone ? ` · ${thisDone} done` : ''}`, 'jobs'),
      tile('Next week', plural(nextW.length, 'job'), whole(sum(nextW, v => v.price)), 'jobs'),
      tile('Quotes awaiting reply', String(D.awaiting.length), `${whole(sum(D.awaiting, x => x.total))}${D.followDue.length ? ` · <b>${D.followDue.length} to follow up</b>` : ''}`, 'quotes', D.followDue.length ? 'warn' : ''),
      tile('Accepted, not booked', String(D.toBook.length), whole(sum(D.toBook, x => x.accepted_total || x.total)), 'quotes', D.toBook.length ? 'warn' : ''),
      tile('Owed to you', whole(owed), overdue.length ? `<b>${whole(overdueAmt)} overdue</b> · ${plural(overdue.length, 'invoice')}` : `${plural(D.open.length, 'invoice')}, none overdue`, 'invoices', overdue.length ? 'bad' : ''),
      tile('Work to invoice', String(D.toInvoice.length), D.toInvoice.length ? whole(sum(D.toInvoice, v => v.price)) + ' done, not invoiced' : 'All done work is invoiced', 'invoices', D.toInvoice.length ? 'warn' : ''),
      tile('Paid this month', whole(paidMonth), `Last month ${whole(paidLast)}`, 'invoices', 'good'),
      tile('Quotes won', winRate === null ? '–' : winRate + '%', winRate === null ? 'No quotes decided in the last 90 days' : `${D.won.length} of ${D.won.length + D.lost.length} decided, last 90 days`, 'quotes'),
      tile('Customers', String(active), `${plural(leads, 'lead')} · ${newAcc} new this month`, 'accounts'),
      D.ratings.length ? tile('Reviews', (D.ratings.reduce((t, f) => t + f.rating, 0) / D.ratings.length).toFixed(1) + '★', `${plural(D.ratings.length, 'rating')}, last 90 days`, ROLE === 'admin' ? 'admin/growth' : '', D.low.length ? 'bad' : 'good') : '',
    ].join('');

    // coming up: the next 7 days, by day
    const end7 = ymd(addDays(new Date(), 7));
    const soon = D.visits.filter(v => v.status === 'booked' && v.date >= D.today && v.date < end7);
    const byDay = soon.reduce((m, v) => ((m[v.date] = m[v.date] || []).push(v), m), {});
    const dayName = s => s === D.today ? 'Today' : s === ymd(addDays(new Date(), 1)) ? 'Tomorrow' : day(s).toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'short'});
    const coming = Object.keys(byDay).length ? Object.entries(byDay).map(([d, vs]) => `<div class="hm-day"><div class="hm-dh"><b>${dayName(d)}</b><span>${plural(vs.length, 'job')} · ${whole(sum(vs, v => v.price))}</span></div>
      ${vs.map(v => { const j = v.jobs || {}; return `<button type="button" class="hm-row" data-acc="${v.account_id}"><span class="t">${v.start_time ? v.start_time.slice(0,5) : ''}</span><span class="m"><b>${esc((v.accounts||{}).name || 'Customer')}</b><small>${esc(SVC[j.service] || j.title || 'Visit')}${j.line ? ' · ' + esc(j.line) : ''}</small></span><span class="v">${+v.price ? whole(v.price) : ''}</span></button>`; }).join('')}</div>`).join('')
      : `<p class="hint">Nothing booked in the next 7 days.</p>`;

    // booked work for the next 8 weeks, as bars
    const weeks = Array.from({length:8}, (_, i) => { const a = ymd(addDays(D.mon, 7*i)), b = ymd(addDays(D.mon, 7*i + 7)); const vs = inWeek(a, b); return {a, n:vs.length, v:sum(vs, x => x.price)}; });
    const top = Math.max(1, ...weeks.map(w => w.v));
    const bars = `<div class="hm-bars">${weeks.map((w, i) => `<div class="hm-bar ${i < 2 ? 'now' : ''}" title="${plural(w.n, 'job')}, ${whole(w.v)}"><span class="hm-bv">${w.v ? whole(w.v) : ''}</span><span class="hm-bf" style="height:${Math.max(2, Math.round(100 * w.v / top))}%"></span><span class="hm-bl">${i === 0 ? 'This wk' : i === 1 ? 'Next wk' : short(w.a)}</span><span class="hm-bn">${w.n}</span></div>`).join('')}</div>
      <p class="hint">Booked jobs and their value by week (week starting Monday). Number under each bar is the jobs that week.</p>`;

    // needs attention
    const att = [];
    D.followDue.forEach(x => att.push(`<button type="button" class="hm-row" data-openq="${x.id}"><span class="tag warn">Follow up</span><span class="m"><b>${esc(x.customer || x.address || 'Quote')}</b><small>${x.quote_no ? noLabel(x.quote_no) + ' · ' : ''}sent ${x.sent_at ? short(x.sent_at.slice(0,10)) : ''}${x.viewed_at ? ' · opened by the customer' : ''}</small></span><span class="v">${whole(x.total)}</span></button>`));
    D.toBook.forEach(x => att.push(`<button type="button" class="hm-row" data-openq="${x.id}"><span class="tag good">Book in</span><span class="m"><b>${esc(x.customer || x.address || 'Quote')}</b><small>${x.quote_no ? noLabel(x.quote_no) + ' · ' : ''}accepted ${x.accepted_at ? short(x.accepted_at.slice(0,10)) : ''}, no job made yet</small></span><span class="v">${whole(x.accepted_total || x.total)}</span></button>`));
    overdue.forEach(i => att.push(`<button type="button" class="hm-row" data-inv="${i.id}"><span class="tag bad">Overdue</span><span class="m"><b>${esc(i.bill_name || 'Customer')}</b><small>${typeof INVOICES!=='undefined' ? esc(INVOICES.invNo(i.invoice_no)) : 'Invoice ' + i.invoice_no} · ${plural(daysAgo(i.due_date), 'day')} overdue</small></span><span class="v">${whole(+i.total - +i.paid)}</span></button>`));
    D.low.forEach(f => att.push(`<button type="button" class="hm-row" data-acc="${f.account_id}"><span class="tag bad">${f.rating}★</span><span class="m"><b>${esc((f.accounts||{}).name || 'Customer')}</b><small>${esc(f.comment || 'Low rating, no comment')}: get in touch</small></span><span class="v"></span></button>`));
    D.yes.forEach(x => att.push(`<button type="button" class="hm-row" data-acc="${x.account_id}"><span class="tag good">Book in</span><span class="m"><b>${esc((x.accounts||{}).name || 'Customer')}</b><small>Said yes to ${x.kind === 'repeat' ? 'their ' + esc(x.service || 'service') + ' again' : 'more work'}${x.response_note ? ' · ' + esc(x.response_note) : ''}</small></span><span class="v"></span></button>`));
    if(D.toInvoice.length) att.push(`<button type="button" class="hm-row" data-go="invoices"><span class="tag warn">Invoice</span><span class="m"><b>${plural(D.toInvoice.length, 'visit')} done but not invoiced</b><small>Open Invoices to bill them</small></span><span class="v">${whole(sum(D.toInvoice, v => v.price))}</span></button>`);
    if(D.drafts.length) att.push(`<button type="button" class="hm-row" data-go="quotes"><span class="tag">Draft</span><span class="m"><b>${plural(D.drafts.length, 'quote')} not sent yet</b><small>Finish and send from Saved quotes</small></span><span class="v">${whole(sum(D.drafts, x => x.total))}</span></button>`);

    el.innerHTML = head + `<div class="hm-tiles">${tiles}</div>
      <div class="hm-cols">
        <section class="card"><h2>Coming up</h2>${coming}</section>
        <div class="hm-side">
          <section class="card"><h2>Needs attention</h2>${att.length ? att.join('') : '<p class="hint">Nothing to chase. 👍</p>'}</section>
          <section class="card"><h2>Booked work, next 8 weeks</h2>${bars}</section>
        </div>
      </div>`;
    wireHead();
    el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const [v, sub] = b.dataset.go.split('/'); if(sub) location.hash = '#' + b.dataset.go; else show(v); });
    el.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => { if(typeof ACCOUNTS!=='undefined' && b.dataset.acc !== 'null') ACCOUNTS.open(b.dataset.acc); });
    el.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => { if(typeof INVOICES!=='undefined') INVOICES.openInvoice(b.dataset.inv, () => refresh(true)); });
  }
  function wireHead(){ const b = $('hmRefresh'); if(b) b.onclick = () => refresh(true); }

  async function refresh(force){
    if(busy) return;
    if(!force && data && Date.now() - lastLoad < 60e3){ render(); return; }   // coming back within a minute: no reload
    busy = true; if(!data) render();
    try{ data = await load(); lastLoad = Date.now(); render(); }
    catch(e){ $('view-home').insertAdjacentHTML('beforeend', `<p class="note b">Couldn't load the dashboard: ${esc(e.message || e)}</p>`); }
    busy = false;
  }
  const onShow = () => refresh(false);
  return {onShow, refresh, reset:() => { data = null; lastLoad = 0; }};
})();
