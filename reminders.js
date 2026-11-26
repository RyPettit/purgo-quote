/* =====================================================================
   Admin → Reminders: the business details used in customer messages, and the
   editable automatic messages (appointment reminder the day before, payment reminders).
   Templates live in public.message_templates with {placeholders}, so nothing about the
   business is fixed in code (the Portal can be set up for any trade business).
   Uses from purgo.js: $, esc, sb, ROLE, flash
   ===================================================================== */
const REMINDERS = (()=>{
  // placeholders each message can use (shown as buttons that insert them)
  const COMMON = [['first_name','Customer\'s first name'],['customer_name','Account name'],['business_name','Your business name'],['business_phone','Your phone'],['business_email','Your email'],['business_website','Your website'],['sign_off','Your sign-off']];
  const VARS = {
    visit_reminder: [['date','Tomorrow\'s date'],['visit_list','Each job booked, with its address and time'],['service','The (first) service'],['address','The (first) address'],['time','Arrival time, e.g. "around 10:30"'], ...COMMON],
    payment_reminder_1: [['invoice_no','Invoice number'],['amount_due','Left to pay'],['total','Invoice total'],['work_date','Date the work was done'],['due_date','Due date'],['how_to_pay','How to pay (card / bank)'], ...COMMON],
  };
  VARS.payment_reminder_final = VARS.payment_reminder_1;
  const SAMPLE = {first_name:'Sam', customer_name:'Sam Smith', date:'Friday 27 November', time:'around 10:30', service:'Window cleaning', address:'12 Example Road, Hull',
    visit_list:'• Window cleaning at 12 Example Road, around 10:30\n• Gutter clean at 12 Example Road, around 11:00',
    invoice_no:'INV-1000', amount_due:'£45.00', total:'£45.00', work_date:'24 November 2026', due_date:'8 December 2026',
    how_to_pay:'You can pay by card using the button below, or by bank transfer using the details below.'};
  const fill = (t, v) => String(t||'').replace(/\{([a-z_]+)\}/g, (_, k)=> v[k] ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const HOURS = Array.from({length:9}, (_, i)=>i+12);   // 12:00 to 20:00
  let biz = null, tpls = [], inv = null;

  async function fn(body){
    const {data, error} = await sb.functions.invoke('reminders', {body});
    if(error){ let m = error.message; try{ const j = await error.context.json(); if(j && j.error) m = j.error; }catch(e){} throw new Error(m); }
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  const bizVars = () => ({business_name:biz.trading_name||'', business_phone:biz.phone||'', business_email:biz.email||'', business_website:biz.website||'', sign_off:biz.sign_off||`Kind regards,\n${biz.trading_name||''}`});

  function tplHTML(t){
    const k = t.key, visit = k==='visit_reminder', pay1 = k==='payment_reminder_1';
    const days = inv && inv.remind_days || [];
    return `<div class="rm-tpl" data-tk="${k}">
      <h3 style="margin-top:18px">${esc(t.name)}</h3>
      <div class="fields">
        <label class="ck wide"><input type="checkbox" data-tf="enabled" ${t.enabled?'checked':''}> Send this automatically</label>
        ${visit ? `<label class="f">Send at<select data-tf="send_hour">${HOURS.map(h=>`<option value="${h}" ${(t.send_hour??16)===h?'selected':''}>${h}:00 the day before</option>`).join('')}</select></label>
          <p class="hint wide">Goes to everyone with work booked the next day, one email per customer listing each job. Customers without an email, or marked "No automatic reminders" on their account, are skipped.</p>` : ''}
        ${pay1 ? `<label class="f">Days after the work <small>(blank: none)</small><input id="rmDay1" type="number" min="1" max="60" value="${days[0] ?? ''}" placeholder="e.g. 3"></label>` : ''}
        ${k==='payment_reminder_final' ? `<label class="f">Days after the work <small>(blank: none)</small><input id="rmDay2" type="number" min="1" max="90" value="${days[1] ?? ''}" placeholder="e.g. 7"></label>
          <p class="hint wide">Payment reminders go between 9am and 6pm, Monday to Saturday, with the Pay now button and bank details added underneath, and never within 2 days of the last email. They stop as soon as the invoice is paid (bank transfers once they're matched in Sage).</p>` : ''}
        <label class="f wide">Subject<input data-tf="subject" value="${esc(t.subject||'')}"></label>
        <label class="f wide">Message<textarea data-tf="body" rows="10">${esc(t.body||'')}</textarea></label>
        <div class="wide rm-vars"><small class="hint">Insert:</small> ${(VARS[k]||COMMON).map(([v,d])=>`<button class="btn sm" type="button" data-ins="{${v}}" title="${esc(d)}">{${v}}</button>`).join(' ')}</div>
        <div class="wide rm-prev"><small class="hint">Preview with example details</small><div class="rm-prev-box" data-prev></div></div>
      </div>
      <div class="vb-actions" style="justify-content:flex-start"><button class="btn pri" type="button" data-save>Save</button><button class="btn" type="button" data-test>Send a test to me</button><span class="hint" data-st></span></div>
    </div>`;
  }

  async function renderAdmin(){
    const c = $('remCard'); if(!c) return;
    if(ROLE!=='admin'){ c.hidden = true; return; }
    c.innerHTML = `<h2>Reminders</h2><p class="hint">Loading…</p>`;
    const [b, t, s] = await Promise.all([
      sb.from('business_profile').select('*').eq('id', 1).maybeSingle(),
      sb.from('message_templates').select('*').order('sort'),
      sb.from('invoice_settings').select('remind_days').eq('id', 1).maybeSingle()]);
    if(b.error || t.error){ c.innerHTML = `<h2>Reminders</h2><p class="note b">${esc((b.error||t.error).message)}</p>`; return; }
    biz = b.data || {trading_name:''}; tpls = t.data || []; inv = s.data || {};
    c.innerHTML = `<h2>Reminders</h2>
      <p class="hint">Messages the Portal sends to customers on its own, from the connected mailbox. Edit the wording here: words in {braces} are filled in for each customer.</p>
      <h3 style="margin-top:14px">Your business</h3>
      <p class="hint">Used in every customer message.</p>
      <div class="fields" id="rmBiz">
        <label class="f">Trading name<input data-bf="trading_name" value="${esc(biz.trading_name||'')}"></label>
        <label class="f">Company name<input data-bf="legal_name" value="${esc(biz.legal_name||'')}" placeholder="e.g. Purgō Clean Ltd"></label>
        <label class="f">Phone<input data-bf="phone" inputmode="tel" value="${esc(biz.phone||'')}"></label>
        <label class="f">Email<input data-bf="email" type="email" value="${esc(biz.email||'')}"></label>
        <label class="f">Website<input data-bf="website" value="${esc(biz.website||'')}"></label>
        <label class="f wide">Sign-off<textarea data-bf="sign_off" rows="2" placeholder="Kind regards,&#10;The team">${esc(biz.sign_off||'')}</textarea></label>
      </div>
      <div class="vb-actions" style="justify-content:flex-start"><button class="btn pri" type="button" id="rmBizSave">Save business details</button></div>
      ${tpls.map(tplHTML).join('')}`;
    $('rmBizSave').onclick = async ()=>{
      const upd = {updated_at:new Date().toISOString()};
      c.querySelectorAll('[data-bf]').forEach(el=>{ upd[el.dataset.bf] = el.value.trim() || null; });
      if(!upd.trading_name){ flash('Add a trading name'); return; }
      const {error} = await sb.from('business_profile').update(upd).eq('id', 1);
      if(error){ flash('Not saved: ' + error.message); return; }
      biz = {...biz, ...upd}; flash('Business details saved'); c.querySelectorAll('.rm-tpl').forEach(preview);
    };
    c.querySelectorAll('.rm-tpl').forEach(box=>{
      const k = box.dataset.tk, q = s=>box.querySelector(s);
      let last = q('[data-tf="body"]');
      box.querySelectorAll('[data-tf="subject"],[data-tf="body"]').forEach(el=>{ el.addEventListener('focus', ()=>{ last = el; }); el.addEventListener('input', ()=>{ preview(box); q('[data-st]').textContent = 'Unsaved changes'; }); });
      box.querySelectorAll('[data-ins]').forEach(bt=> bt.onclick = ()=>{
        const el = last, v = bt.dataset.ins, a = el.selectionStart ?? el.value.length, z = el.selectionEnd ?? a;
        el.value = el.value.slice(0, a) + v + el.value.slice(z); el.focus(); el.selectionStart = el.selectionEnd = a + v.length; preview(box); q('[data-st]').textContent = 'Unsaved changes'; });
      box.querySelectorAll('[data-tf="enabled"],[data-tf="send_hour"],#rmDay1,#rmDay2').forEach(el=> el.onchange = ()=>{ q('[data-st]').textContent = 'Unsaved changes'; });
      q('[data-save]').onclick = async ()=>{
        const upd = {enabled:q('[data-tf="enabled"]').checked, subject:q('[data-tf="subject"]').value.trim()||null, body:q('[data-tf="body"]').value.trim(), updated_at:new Date().toISOString(), updated_by_name:(typeof ME!=='undefined' && ME ? ME.name : null)};
        if(!upd.body){ flash('The message can\'t be empty'); return; }
        if(q('[data-tf="send_hour"]')) upd.send_hour = +q('[data-tf="send_hour"]').value;
        const {error} = await sb.from('message_templates').update(upd).eq('key', k);
        if(error){ flash('Not saved: ' + error.message); return; }
        if(k.startsWith('payment_')){   // the reminder days are kept with the invoice settings
          const d1 = $('rmDay1') ? parseInt($('rmDay1').value) : NaN, d2 = $('rmDay2') ? parseInt($('rmDay2').value) : NaN;
          const days = [...new Set([d1, d2].filter(n=>n>0))].sort((a,b)=>a-b);
          const r = await sb.from('invoice_settings').update({remind_days:days, updated_at:new Date().toISOString()}).eq('id', 1);
          if(r.error){ flash('Not saved: ' + r.error.message); return; }
          inv.remind_days = days;
        }
        q('[data-st]').textContent = 'Saved'; flash('Saved');
      };
      q('[data-test]').onclick = async ()=>{
        const b = q('[data-test]'); b.disabled = true; b.textContent = 'Sending…';
        try{ const r = await fn({action:'test', key:k, subject:q('[data-tf="subject"]').value, body:q('[data-tf="body"]').value}); flash('Test sent to ' + r.to); }
        catch(e){ flash('Not sent: ' + e.message); }
        b.disabled = false; b.textContent = 'Send a test to me';
      };
      preview(box);
    });
  }
  function preview(box){
    const v = {...bizVars(), ...SAMPLE};
    const subj = fill(box.querySelector('[data-tf="subject"]').value, v), body = fill(box.querySelector('[data-tf="body"]').value, v);
    box.querySelector('[data-prev]').innerHTML = `<b>${esc(subj)}</b><br><br>${esc(body).replace(/\n/g, '<br>')}`;
  }
  return {renderAdmin};
})();
