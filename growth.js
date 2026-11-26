/* =====================================================================
   Admin → Reviews & repeat work: switch on review requests, "due again" prompts
   and win-backs, set when they go, see the feedback that's come in, and edit
   the messages (the editor is shared with Admin → Reminders).
   Uses from purgo.js: $, esc, sb, flash, ROLE; REMINDERS.renderTemplates
   ===================================================================== */
const GROWTH = (()=>{
  const KEYS = ['review_request','review_request_sms','repeat_prompt','repeat_prompt_sms','win_back','win_back_sms'];
  const SVCS = [['gutters','Gutter clean'],['roof','Roof clean'],['pressure','Pressure washing'],['windows','Window cleaning (one-off)'],['other','Other one-off work']];
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  let M = null, fb = [], ms = [];

  async function renderAdmin(){
    const c = $('growCard'); if(!c) return;
    if(ROLE!=='admin'){ c.hidden = true; return; }
    c.innerHTML = `<h2>Reviews & repeat work</h2><p class="hint">Loading…</p>`;
    const [m, f, s] = await Promise.all([
      sb.from('marketing_settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('feedback').select('id,rating,comment,rated_at,sent_at,google_clicked_at,account_id,service,accounts(name)').not('sent_at', 'is', null).order('created_at', {ascending:false}).limit(200),
      sb.from('marketing_sends').select('id,kind,service,sent_at,response,response_note,responded_at,account_id,accounts(name)').not('sent_at', 'is', null).order('created_at', {ascending:false}).limit(200)]);
    if(m.error){ c.innerHTML = `<h2>Reviews & repeat work</h2><p class="note b">${esc(m.error.message)}</p>`; return; }
    M = m.data || {}; fb = f.data || []; ms = s.data || [];
    await REMINDERS.renderTemplates(c, KEYS, head);
    wire(c);
  }

  function results(){
    const rated = fb.filter(x => x.rating), avg = rated.length ? (rated.reduce((t, x) => t + x.rating, 0) / rated.length) : 0;
    const google = fb.filter(x => x.google_clicked_at).length;
    const yes = ms.filter(x => x.response === 'yes');
    const recent = fb.filter(x => x.rated_at).slice(0, 8).map(x => `<button type="button" class="hm-row" data-acc="${x.account_id}"><span class="gr-stars ${x.rating <= 3 ? 'low' : ''}">${stars(x.rating)}</span><span class="m"><b>${esc((x.accounts||{}).name || 'Customer')}</b><small>${esc(x.comment || 'No comment')}</small></span><span class="v">${new Date(x.rated_at).toLocaleDateString('en-GB', {day:'numeric', month:'short'})}</span></button>`).join('');
    const said = yes.slice(0, 6).map(x => `<button type="button" class="hm-row" data-acc="${x.account_id}"><span class="tag good">Yes</span><span class="m"><b>${esc((x.accounts||{}).name || 'Customer')}</b><small>${x.kind === 'repeat' ? 'Due again: ' + esc(x.service || '') : 'Win-back'}${x.response_note ? ' · ' + esc(x.response_note) : ''}</small></span><span class="v">${new Date(x.responded_at).toLocaleDateString('en-GB', {day:'numeric', month:'short'})}</span></button>`).join('');
    return `<div class="gr-stats">
        <div><b>${fb.length}</b><span>review requests sent</span></div>
        <div><b>${rated.length ? avg.toFixed(1) + '★' : '–'}</b><span>${rated.length} rating${rated.length===1?'':'s'}</span></div>
        <div><b>${google}</b><span>went on to Google</span></div>
        <div><b>${yes.length}</b><span>said yes to booking, of ${ms.length} asked</span></div>
      </div>
      ${recent ? `<h3 style="margin-top:14px">Latest feedback</h3>${recent}` : ''}
      ${said ? `<h3 style="margin-top:14px">Asked to be booked in</h3>${said}` : ''}`;
  }

  function head(){
    const mo = M.repeat_months || {};
    return `<h2>Reviews & repeat work</h2>
      <p class="hint">Messages that bring in reviews and repeat work. Each goes by email, text or both, as the customer's account says, and never to accounts set to "No reminders". All three are off until you switch them on.</p>
      ${results()}
      <h3 style="margin-top:18px">Review requests</h3>
      <div class="fields">
        <label class="ck wide"><input type="checkbox" id="grRev" ${M.review_on ? 'checked' : ''}> Ask customers how we did, the day after their job</label>
        <label class="f wide">Your Google review link<input id="grUrl" type="url" value="${esc(M.google_review_url || '')}" placeholder="https://g.page/r/…/review"></label>
        <p class="hint wide">In your Google Business Profile, choose <b>Ask for reviews</b> (or <b>Get more reviews</b>) and copy the link. Customers who give 4 or 5 stars are offered it; anyone less happy writes to you privately instead, and you get a notification.</p>
        <label class="f">Send from<select id="grHour">${[9,10,11,12,13,14,15,16,17,18].map(h => `<option value="${h}" ${(M.review_hour ?? 10) === h ? 'selected' : ''}>${h}:00</option>`).join('')}</select></label>
        <label class="f">Ask the same customer at most every<select id="grGap">${[[90,'3 months'],[180,'6 months'],[365,'year']].map(([d,l]) => `<option value="${d}" ${(M.review_gap_days ?? 180) === d ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <h3 style="margin-top:18px">Due again</h3>
      <div class="fields">
        <label class="ck wide"><input type="checkbox" id="grRep" ${M.repeat_on ? 'checked' : ''}> Ask one-off customers if they'd like booking in again when their service is due</label>
        ${SVCS.map(([k, l]) => `<label class="f">${l}: due after<select data-rm="${k}">${[[0,'never'],[6,'6 months'],[9,'9 months'],[12,'12 months'],[18,'18 months'],[24,'2 years'],[36,'3 years']].map(([n, t]) => `<option value="${n}" ${(+mo[k] || 0) === n ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('')}
        <p class="hint wide">Only when nothing of that kind is booked and they're not on a round. Each customer is asked once each time it falls due.</p>
      </div>
      <h3 style="margin-top:18px">Win-backs</h3>
      <div class="fields">
        <label class="ck wide"><input type="checkbox" id="grWin" ${M.winback_on ? 'checked' : ''}> Check in with customers we haven't been out to for a while</label>
        <label class="f">After<select id="grWinM">${[3,6,9,12,18].map(n => `<option value="${n}" ${(M.winback_months ?? 6) === n ? 'selected' : ''}>${n} months with nothing done or booked</option>`).join('')}</select></label>
        <p class="hint wide">At most once a year per customer. Messages go between 10am and 7pm, Monday to Saturday, up to 20 of each kind every 10 minutes.</p>
      </div>
      <div class="vb-actions" style="justify-content:flex-start"><button class="btn pri" type="button" id="grSave">Save settings</button></div>
      <h3 style="margin-top:22px">The messages</h3>
      <p class="hint">"Send this automatically" on each one lets you, say, use texts but not emails for reviews. {link} is the customer's own page, where they rate you or tap "yes, book me in".</p>`;
  }

  function wire(c){
    c.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => { if(typeof ACCOUNTS!=='undefined') ACCOUNTS.open(b.dataset.acc); });
    $('grSave').onclick = async () => {
      const months = {}; c.querySelectorAll('[data-rm]').forEach(s => { if(+s.value) months[s.dataset.rm] = +s.value; });
      const url = $('grUrl').value.trim();
      if(url && !/^https:\/\/\S+$/.test(url)){ flash('The Google link should start with https://'); return; }
      const reviewOn = $('grRev').checked;
      const upd = {google_review_url:url || null, review_on:reviewOn, review_hour:+$('grHour').value, review_gap_days:+$('grGap').value,
        repeat_on:$('grRep').checked, repeat_months:months, winback_on:$('grWin').checked, winback_months:+$('grWinM').value, updated_at:new Date().toISOString()};
      if(reviewOn && !M.review_on) upd.review_since = new Date().toISOString();   // only jobs done from now on are asked about
      if(reviewOn && !url && !confirm('No Google review link yet: happy customers will just be thanked. Switch on anyway?')) return;
      const {error} = await sb.from('marketing_settings').update(upd).eq('id', 1);
      if(error){ flash('Not saved: ' + error.message); return; }
      M = {...M, ...upd}; flash('Saved');
    };
  }
  return {renderAdmin};
})();
