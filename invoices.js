/* =====================================================================
   Purgō invoices: bill done work, email invoices with a "Pay now" link
   (card payments through Stripe), record bank transfers and cash, and
   keep Sage Accounting up to date (the invoicing function copies every
   invoice and payment to Sage and reads back payments matched there).
   - Invoices tab on each account, and the Invoices page for everything
   - Admin → Invoicing: payment terms, bank details, VAT, auto-invoicing, Sage and Stripe
   Uses from purgo.js: $, esc, gbp, sb, ME, ROLE, show, flash, isNetErr, confirmInline, fmtDay
   ===================================================================== */
const INVOICES = (()=>{
  const ST = {draft:'Draft', sent:'Unpaid', part_paid:'Part paid', paid:'Paid', void:'Void'};
  const METHOD = {bank:'Bank transfer', card:'Card', cash:'Cash', dd:'Direct debit', other:'Other'};
  const invNo = n => `${window.PURGO_DEV?'DEV-':''}INV-${n}`;
  const today = () => { const d = new Date(), p = n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };
  const fmtD = v => { if(!v) return ''; const d = new Date(String(v).length===10 ? v+'T12:00:00' : v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}); };
  const r2 = n => Math.round((+n||0)*100)/100;
  const left = i => Math.max(0, r2(i.total - i.paid));
  const overdue = i => (i.status==='sent'||i.status==='part_paid') && i.due_date && i.due_date < today();
  const pill = i => overdue(i) ? `<span class="pill inv-st overdue">Overdue</span>` : `<span class="pill inv-st ${i.status}">${ST[i.status]||i.status}</span>`;
  let settings = null;

  async function fn(body){
    const {data, error} = await sb.functions.invoke('invoicing', {body});
    if(error){ let m = error.message; try{ const j = await error.context.json(); if(j && j.error) m = j.error; }catch(e){} throw new Error(m); }
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  async function getSettings(force){
    if(settings && !force) return settings;
    const {data} = await sb.from('invoice_settings').select('*').eq('id', 1).maybeSingle();
    return settings = data || {terms_days:14, vat_registered:false, vat_rate:20, auto_invoice:'off'};
  }
  const sageNote = i => i.status==='draft' ? '' : i.sage_error ? `<small class="jb-err">Sage: ${esc(i.sage_error)}</small>` : i.sage_id && !i.sage_dirty ? `<small class="hint">In Sage</small>` : '';

  /* ---------- an account's invoices ---------- */
  async function loadAccount(accId){
    const [inv, vis, used] = await Promise.all([
      sb.from('invoices').select('*').eq('account_id', accId).order('invoice_no', {ascending:false}),
      sb.from('visits').select('id,date,price,job_id,jobs(title,service,line,postcode,price)').eq('account_id', accId).eq('status', 'done').order('date', {ascending:false}).limit(300),
      sb.from('invoice_lines').select('visit_id,invoices!inner(status,account_id)').eq('invoices.account_id', accId).not('visit_id', 'is', null)
    ]);
    for(const r of [inv, vis, used]) if(r.error) throw r.error;
    const done = new Set(used.data.filter(l=>l.invoices && l.invoices.status!=='void').map(l=>l.visit_id));
    return {invoices:inv.data, uninvoiced:vis.data.filter(v=>!done.has(v.id) && (+(v.price ?? (v.jobs||{}).price) || 0) > 0)};
  }
  function accountHTML(d){
    const I = d.invoiceData || {invoices:[], uninvoiced:[]};
    const out = I.invoices.filter(i=>i.status==='sent'||i.status==='part_paid');
    const owed = out.reduce((s,i)=>s+left(i),0), od = out.filter(overdue);
    const accepted = d.quotes.filter(q=>q.status==='accepted');
    const vName = v => { const j = v.jobs||{}; return `${j.title || j.service || 'Work'}${j.line ? ' · '+j.line : ''}`; };
    return `
    <div class="ac-stats">
      <div class="stat"><span>Owed</span><b>${gbp(owed)}</b></div>
      <div class="stat"><span>Overdue</span><b class="${od.length?'inv-bad':''}">${od.length ? gbp(od.reduce((s,i)=>s+left(i),0)) : '—'}</b></div>
      <div class="stat"><span>Paid to date</span><b>${gbp(I.invoices.filter(i=>i.status!=='void').reduce((s,i)=>s+(+i.paid||0),0))}</b></div>
      <div class="stat"><span>Invoices</span><b>${I.invoices.filter(i=>i.status!=='void').length}</b></div>
    </div>
    ${I.uninvoiced.length ? `<section class="card"><div class="svc-head"><h2>Work to invoice</h2><button class="btn sm pri" type="button" id="ivFromVisits">Invoice ticked</button></div>
      <p class="hint" style="margin-top:6px">Done visits that aren't on an invoice yet. Tick the ones to bill together.</p>
      <div class="qlist">${I.uninvoiced.map(v=>`<label class="qitem inv-v"><input type="checkbox" data-ivv="${v.id}" checked><div class="m"><b>${esc(vName(v))}</b><small>Done ${fmtD(v.date)}</small></div><div class="v">${gbp(+(v.price ?? (v.jobs||{}).price) || 0)}</div></label>`).join('')}</div></section>` : ''}
    <section class="card"><div class="svc-head"><h2>Invoices</h2><span class="vb-actions">${accepted.length ? `<select id="ivFromQuote" class="sm-sel"><option value="">Invoice a quote…</option>${accepted.map(q=>`<option value="${q.id}">${q.quote_no ? noLabel(q.quote_no) : esc(q.ref)} · ${gbp(wonTotal(q))}</option>`).join('')}</select>` : ''}<button class="btn sm" type="button" id="ivNew">+ New invoice</button></span></div>
      <div class="qlist" style="margin-top:8px">${I.invoices.map(i=>rowHTML(i)).join('') || `<p class="hint">No invoices yet. Mark visits as done on the Jobs tab and they appear above to invoice, or make one here.${d.acc.squeegee_ref ? ` Older invoices are in Squeegee (customer ${esc(d.acc.squeegee_ref)}).` : ''}</p>`}</div></section>`;
  }
  function rowHTML(i, withName){
    return `<div class="qitem"><div class="m"><b>${invNo(i.invoice_no)}${withName ? ` · ${esc(i.bill_name||'')}` : ''}</b><small>${fmtD(i.issue_date)}${i.status!=='draft' ? ` · due ${fmtD(i.due_date)}` : ''}${i.sent_at ? ' · emailed '+fmtD(i.sent_at) : ''}${i.viewed_at ? ' · opened' : ''}</small>${sageNote(i)}</div>
      ${pill(i)}<div class="v">${gbp(+i.total||0)}${+i.paid>0 && i.status!=='paid' ? `<small style="display:block;color:var(--muted);font-size:.72rem">${gbp(left(i))} left</small>` : ''}</div>
      <div class="qacts"><button class="btn sm" type="button" data-ivopen="${i.id}">Open</button></div></div>`;
  }
  function wireAccount(d, reload){
    const el = $('view-accounts');
    el.querySelectorAll('[data-ivopen]').forEach(b=> b.onclick = ()=> openInvoice(b.dataset.ivopen, reload));
    if($('ivNew')) $('ivNew').onclick = async ()=>{ const id = await createBlank(d.acc); if(id){ await reload(); openInvoice(id, reload); } };
    if($('ivFromVisits')) $('ivFromVisits').onclick = async ()=>{
      const ids = [...el.querySelectorAll('[data-ivv]:checked')].map(c=>c.dataset.ivv);
      if(!ids.length){ flash('Tick the work to invoice'); return; }
      $('ivFromVisits').disabled = true;
      const {data, error} = await sb.rpc('invoice_from_visits', {p_visits:ids, p_send:false});
      if(error){ $('ivFromVisits').disabled = false; flash('Not made: ' + (isNetErr(error)?'no connection':error.message)); return; }
      await reload(); openInvoice(data, reload);
    };
    if($('ivFromQuote')) $('ivFromQuote').onchange = async e=>{
      const q = d.quotes.find(x=>x.id===e.target.value); if(!q) return;
      const id = await createFromQuote(d.acc, q); e.target.value = '';
      if(id){ await reload(); openInvoice(id, reload); }
    };
  }

  /* ---------- making invoices ---------- */
  async function header(a){ return {account_id:a.id, bill_name:a.name, bill_address:[a.billing_line, a.billing_postcode].filter(Boolean).join(', ') || null, email:a.email||null, created_by_name:ME.name}; }
  async function createBlank(a){
    const {data, error} = await sb.from('invoices').insert(await header(a)).select('id').single();
    if(error){ flash('Not made: ' + error.message); return null; }
    return data.id;
  }
  async function createFromQuote(a, q){
    const s = await getSettings();
    const opt = optionsOf(q), names = acceptedNames(q);
    const p = names ? pickPrice(opt, names) : {total:+q.total||0};
    const ref = q.quote_no ? noLabel(q.quote_no) : q.ref;
    const what = names ? names.join(', ') : (opt.sections.map(x=>x.name).join(', ') || 'Work as quoted');
    const vat = opt.vatRate>0 ? opt.vatRate : (s.vat_registered ? +s.vat_rate : 0);
    const h = Object.assign(await header(a), {quote_id:q.id});
    const {data, error} = await sb.from('invoices').insert(h).select('id').single();
    if(error){ flash('Not made: ' + error.message); return null; }
    const l = await sb.from('invoice_lines').insert({invoice_id:data.id, sort:1, description:`${what}${q.address ? ' – '+q.address : ''} (quote ${ref})`, qty:1, unit_price:r2(p.total), vat_rate:vat});
    if(l.error) flash('Lines not added: ' + l.error.message);
    return data.id;
  }

  /* ---------- the invoice dialog ---------- */
  async function load(id){
    const [i, l, p] = await Promise.all([
      sb.from('invoices').select('*').eq('id', id).single(),
      sb.from('invoice_lines').select('*').eq('invoice_id', id).order('sort'),
      sb.from('payments').select('*').eq('invoice_id', id).order('paid_on')
    ]);
    for(const r of [i,l,p]) if(r.error) throw r.error;
    return {inv:i.data, lines:l.data, pays:p.data};
  }
  async function openInvoice(id, after){
    let D; try{ D = await load(id); }catch(e){ flash('Could not open the invoice: ' + (e.message||e)); return; }
    const s = await getSettings();
    const dlg = document.createElement('dialog'); dlg.className = 'ac-dlg inv-dlg';
    document.body.appendChild(dlg);
    let payForm = false, voidForm = false;
    const done = async ()=>{ dlg.close(); dlg.remove(); if(after) await after(); };
    const reloadD = async ()=>{ D = await load(id); draw(); };
    const lineRow = (l, k)=> `<tr data-li="${k}">
      <td><input data-lf="description" value="${esc(l.description||'')}" placeholder="What was done"></td>
      <td><input data-lf="qty" type="number" min="0.01" step="any" value="${+l.qty||1}"></td>
      <td><input data-lf="unit_price" type="number" step="0.01" value="${l.unit_price ?? ''}"></td>
      ${s.vat_registered ? `<td><label class="ck"><input data-lf="vat" type="checkbox" ${+l.vat_rate>0?'checked':''}> VAT</label></td>` : ''}
      <td class="a">${gbp(r2((+l.qty||0)*(+l.unit_price||0)))}</td><td><button class="btn sm del" type="button" data-ldel="${k}">✕</button></td></tr>`;
    let lines = D.lines.map(l=>({...l}));
    function draw(){
      const i = D.inv, draft = i.status==='draft', voided = i.status==='void', due = left(i);
      const total = draft ? r2(lines.reduce((t,l)=>t+(+l.qty||0)*(+l.unit_price||0),0)) : +i.total;
      dlg.innerHTML = `<div class="svc-head"><h2>Invoice ${invNo(i.invoice_no)}</h2>${pill(i)}</div>
        <p class="hint">${esc(i.bill_name||'')}${i.bill_address?' · '+esc(i.bill_address):''}${i.status!=='draft' ? ` · issued ${fmtD(i.issue_date)} · due ${fmtD(i.due_date)}` : ''}</p>
        ${draft ? `<div class="inv-lines"><table><thead><tr><th>Description</th><th>Qty</th><th>Price each${s.vat_registered?' (inc VAT)':''}</th>${s.vat_registered?'<th></th>':''}<th class="a">Amount</th><th></th></tr></thead>
            <tbody>${lines.map(lineRow).join('')}</tbody></table>
            <button class="btn sm" type="button" id="ivAddL">+ Add line</button></div>
          <div class="fields" style="margin-top:12px">
            <label class="f">Email to<input id="ivEmail" type="email" autocapitalize="off" spellcheck="false" value="${esc(i.email||'')}"></label>
            <label class="f">Bill to<input id="ivName" value="${esc(i.bill_name||'')}"></label>
            <label class="f wide">Address<input id="ivAddr" value="${esc(i.bill_address||'')}"></label>
            <label class="f wide">Note on the invoice <small>(optional)</small><textarea id="ivNotes" rows="2">${esc(i.notes||'')}</textarea></label>
          </div>`
        : `<div class="qlist">${D.lines.map(l=>`<div class="qitem"><div class="m"><b>${+l.qty!==1?`${+l.qty} × `:''}${esc(l.description)}</b>${+l.vat>0?`<small>inc VAT ${gbp(l.vat)}</small>`:''}</div><div></div><div class="v">${gbp(l.amount)}</div><div></div></div>`).join('')}</div>
          ${i.notes ? `<p class="hint">${esc(i.notes)}</p>` : ''}`}
        <div class="sec-tot"><span>Total${+i.vat>0 || (draft && s.vat_registered) ? ' inc VAT' : ''}</span><b>${gbp(total)}</b></div>
        ${!draft && !voided ? `<div class="sec-tot"><span>${due>0 ? 'Left to pay' : 'Paid in full'}</span><b>${gbp(due)}</b></div>` : ''}
        ${D.pays.length ? `<h3 style="margin:12px 0 4px">Payments</h3><div class="qlist">${D.pays.map(p=>`<div class="qitem"><div class="m"><b>${gbp(p.amount)} · ${METHOD[p.method]||p.method}</b><small>${fmtD(p.paid_on)}${p.reference?' · '+esc(p.reference):''} · ${esc(p.created_by_name||'')}${p.sage_error?'':p.sage_id?' · in Sage':''}</small>${p.sage_error?`<small class="jb-err">Sage: ${esc(p.sage_error)}</small>`:''}</div><div></div><div></div>
            <div class="qacts">${ROLE==='admin' && p.source==='manual' && !p.sage_id ? `<button class="btn sm del" type="button" data-pdel="${p.id}">Remove</button>` : ''}</div></div>`).join('')}</div>` : ''}
        ${payForm ? `<div class="fields inv-pay"><label class="f">Amount<input id="pyAmt" type="number" step="0.01" min="0.01" value="${due.toFixed(2)}"></label>
            <label class="f">How<select id="pyHow">${Object.entries(METHOD).filter(([k])=>k!=='card').map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
            <label class="f">Date<input id="pyDate" type="date" value="${today()}" max="${today()}"></label>
            <label class="f">Reference <small>(optional)</small><input id="pyRef"></label>
            <p class="hint wide">Card payments through the Pay now link are recorded automatically, and so are bank transfers you match to this invoice in Sage. Record anything else here, e.g. cash on the doorstep.</p>
            <div class="vb-actions wide"><button class="btn sm" type="button" id="pyCancel">Cancel</button><button class="btn sm pri" type="button" id="pySave">Record payment</button></div></div>` : ''}
        ${voidForm ? `<div class="fields inv-pay"><label class="f wide">Why is it being voided?<input id="vdWhy" placeholder="e.g. raised in error, replaced by INV-…"></label>
            <p class="hint wide">The invoice stays on record marked Void, and is voided in Sage too. The customer's link will show it as void.</p>
            <div class="vb-actions wide"><button class="btn sm" type="button" id="vdCancel">Keep it</button><button class="btn sm del" type="button" id="vdGo">Void invoice</button></div></div>` : ''}
        ${i.sage_error ? `<p class="note b">Not in Sage yet: ${esc(i.sage_error)}</p>` : ''}
        <p class="note b" id="ivErr" hidden></p>
        <div class="vb-actions inv-acts">
          ${draft ? `<button class="btn del" type="button" id="ivDel">Delete draft</button><span class="sp"></span><button class="btn" type="button" id="ivClose">Close</button><button class="btn" type="button" id="ivSave">Save draft</button><button class="btn pri" type="button" id="ivSend">Save and email</button>`
          : `${ROLE==='admin' && !voided && !voidForm ? `<button class="btn del" type="button" id="ivVoid">Void</button>` : ''}<span class="sp"></span><button class="btn" type="button" id="ivClose">Close</button>
             ${!voided ? `<button class="btn" type="button" id="ivLink">Copy link</button><button class="btn" type="button" id="ivSend">${i.sent_at?'Email again':'Email'}</button>${due>0 && !payForm ? `<button class="btn pri" type="button" id="ivPay">Record payment</button>` : ''}` : ''}`}
        </div>`;
      wire();
    }
    const err = m=>{ const e = dlg.querySelector('#ivErr'); e.hidden = !m; e.textContent = m||''; };
    function readLines(){
      dlg.querySelectorAll('[data-li]').forEach(tr=>{ const l = lines[+tr.dataset.li];
        tr.querySelectorAll('[data-lf]').forEach(inp=>{ const k = inp.dataset.lf;
          if(k==='vat') l.vat_rate = inp.checked ? +s.vat_rate : 0; else l[k] = k==='description' ? inp.value : inp.value==='' ? '' : +inp.value; }); });
    }
    async function saveDraft(){
      readLines();
      const bad = lines.find(l=> !String(l.description||'').trim() || !(+l.qty>0) || l.unit_price==='');
      if(bad){ err('Each line needs a description, a quantity and a price.'); return false; }
      const upd = {email:(dlg.querySelector('#ivEmail').value.trim().toLowerCase()||null), bill_name:dlg.querySelector('#ivName').value.trim()||null,
        bill_address:dlg.querySelector('#ivAddr').value.trim()||null, notes:dlg.querySelector('#ivNotes').value.trim()||null};
      const u = await sb.from('invoices').update(upd).eq('id', id); if(u.error){ err('Not saved: ' + u.error.message); return false; }
      const keep = lines.filter(l=>l.id).map(l=>l.id);
      const gone = D.lines.filter(l=>!keep.includes(l.id)).map(l=>l.id);
      if(gone.length){ const r = await sb.from('invoice_lines').delete().in('id', gone); if(r.error){ err('Not saved: ' + r.error.message); return false; } }
      for(const [k,l] of lines.entries()){
        const row = {invoice_id:id, sort:k+1, description:String(l.description).trim(), qty:+l.qty, unit_price:+l.unit_price, vat_rate:+l.vat_rate||0};
        const r = l.id ? await sb.from('invoice_lines').update(row).eq('id', l.id) : await sb.from('invoice_lines').insert(row);
        if(r.error){ err('Not saved: ' + r.error.message); return false; }
      }
      D = await load(id); lines = D.lines.map(l=>({...l}));
      return true;
    }
    function wire(){
      const q = s=>dlg.querySelector(s);
      if(q('#ivClose')) q('#ivClose').onclick = done;
      dlg.oncancel = e=>{ e.preventDefault(); done(); };
      if(q('#ivAddL')) q('#ivAddL').onclick = ()=>{ readLines(); lines.push({description:'', qty:1, unit_price:'', vat_rate: s.vat_registered ? +s.vat_rate : 0}); draw(); const t = dlg.querySelectorAll('[data-lf="description"]'); t[t.length-1].focus(); };
      dlg.querySelectorAll('[data-ldel]').forEach(b=> b.onclick = ()=>{ readLines(); lines.splice(+b.dataset.ldel, 1); draw(); });
      dlg.querySelectorAll('[data-lf="qty"],[data-lf="unit_price"],[data-lf="vat"]').forEach(inp=> inp.onchange = ()=>{ readLines(); draw(); });
      if(q('#ivSave')) q('#ivSave').onclick = async ()=>{ q('#ivSave').disabled = true; if(await saveDraft()){ flash('Draft saved'); draw(); } else q('#ivSave').disabled = false; };
      if(q('#ivDel')) q('#ivDel').onclick = async ()=>{ if(!confirmInline('ivd'+id, 'Press Delete draft again to delete it')) return;
        const r = await sb.from('invoices').delete().eq('id', id); if(r.error){ err(r.error.message); return; } flash('Draft deleted'); done(); };
      if(q('#ivSend')) q('#ivSend').onclick = async ()=>{
        if(D.inv.status==='draft'){ q('#ivSend').disabled = true; const ok = await saveDraft(); q('#ivSend').disabled = false; if(!ok) return;
          if(!(+D.inv.total>0)){ err('Add something to the invoice first.'); return; } }
        sendDialog(D.inv, async ()=>{ await reloadD(); });
      };
      if(q('#ivLink')) q('#ivLink').onclick = async ()=>{ const url = `${location.origin}/i?t=${D.inv.share_token}`;
        try{ await navigator.clipboard.writeText(url); flash('Link copied: paste it into a text or WhatsApp'); }catch(e){ prompt('The customer\'s invoice link', url); } };
      if(q('#ivPay')) q('#ivPay').onclick = ()=>{ payForm = true; draw(); q('#pyAmt').focus(); };
      if(q('#pyCancel')) q('#pyCancel').onclick = ()=>{ payForm = false; draw(); };
      if(q('#pySave')) q('#pySave').onclick = async ()=>{
        const amount = r2(q('#pyAmt').value); if(!(amount>0)){ err('Enter the amount received.'); return; }
        if(amount > left(D.inv)+0.004 && !confirmInline('ovp'+id, `That's more than the ${gbp(left(D.inv))} left to pay. Press again to record it anyway.`)) return;
        q('#pySave').disabled = true;
        const r = await sb.from('payments').insert({invoice_id:id, account_id:D.inv.account_id, amount, method:q('#pyHow').value, paid_on:q('#pyDate').value||today(), reference:q('#pyRef').value.trim()||null, created_by_name:ME.name});
        if(r.error){ q('#pySave').disabled = false; err('Not recorded: ' + r.error.message); return; }
        payForm = false; flash(`${gbp(amount)} recorded`); await reloadD();
      };
      dlg.querySelectorAll('[data-pdel]').forEach(b=> b.onclick = async ()=>{ if(!confirmInline('pd'+b.dataset.pdel, 'Press Remove again to delete this payment')) return;
        const r = await sb.from('payments').delete().eq('id', b.dataset.pdel); if(r.error){ err(r.error.message); return; } await reloadD(); });
      if(q('#ivVoid')) q('#ivVoid').onclick = ()=>{ voidForm = true; draw(); q('#vdWhy').focus(); };
      if(q('#vdCancel')) q('#vdCancel').onclick = ()=>{ voidForm = false; draw(); };
      if(q('#vdGo')) q('#vdGo').onclick = async ()=>{
        if(+D.inv.paid>0){ err('Payments have been recorded against this invoice. Remove or refund them first.'); return; }
        const r = await sb.from('invoices').update({status:'void', void_reason:q('#vdWhy').value.trim()||null, send_requested:false}).eq('id', id);
        if(r.error){ err(r.error.message); return; } voidForm = false; flash('Invoice voided'); await reloadD();
      };
    }
    draw(); dlg.showModal();
  }

  /* ---------- emailing an invoice ---------- */
  async function sendDialog(inv, after){
    let pre, mailOn = false;
    try{ [pre, mailOn] = await Promise.all([fn({action:'preview', invoiceId:inv.id}), typeof MAIL!=='undefined' ? MAIL.status().then(s=>!!s.connected) : false]); }
    catch(e){ flash('Could not prepare the email: ' + e.message); return; }
    const dlg = document.createElement('dialog'); dlg.className = 'ac-dlg ml-dlg';
    dlg.innerHTML = `<h2>Email invoice ${invNo(inv.invoice_no)}</h2>
      <p class="hint ml-via">${mailOn ? `Sends from the Purgō mailbox with the invoice in the email${pre.cardPay ? ' and a <b>Pay now</b> button for card payment' : ''}, plus your bank details. It's logged on the customer's account.` : 'Email isn\'t connected to the Portal, so this opens the email app on this device with the link to the invoice.'}</p>
      <div class="fields one">
        <label class="f">To<input id="ieTo" type="email" multiple autocapitalize="off" spellcheck="false" value="${esc(inv.email||'')}"></label>
        ${mailOn ? `<label class="f">Cc <small>(optional)</small><input id="ieCc" autocapitalize="off" spellcheck="false"></label>` : ''}
        <label class="f">Subject<input id="ieSubj" value="${esc(pre.subject)}"></label>
        <label class="f">Message<textarea id="ieMsg" rows="10">${esc(pre.message)}</textarea></label>
      </div>
      <p class="note b" id="ieErr" hidden></p>
      <div class="vb-actions" style="margin-top:14px"><button class="btn" type="button" id="ieX">Cancel</button><button class="btn pri" type="button" id="ieGo">${mailOn ? 'Send' : 'Open in email app'}</button></div>`;
    document.body.appendChild(dlg);
    const close = ()=>{ dlg.close(); dlg.remove(); };
    dlg.querySelector('#ieX').onclick = close; dlg.oncancel = e=>{ e.preventDefault(); close(); };
    dlg.querySelector('#ieGo').onclick = async ()=>{
      const e = dlg.querySelector('#ieErr'); e.hidden = true;
      const to = dlg.querySelector('#ieTo').value.trim(), subject = dlg.querySelector('#ieSubj').value.trim(), message = dlg.querySelector('#ieMsg').value.trim();
      if(!/\S+@\S+\.\S+/.test(to)){ e.hidden = false; e.textContent = "Add the customer's email address."; return; }
      const b = dlg.querySelector('#ieGo'); b.disabled = true; b.textContent = mailOn ? 'Sending…' : 'Opening…';
      try{
        if(mailOn){
          await fn({action:'send', invoiceId:inv.id, to, cc:(dlg.querySelector('#ieCc')||{}).value||'', subject, message});
          close(); flash(`Invoice sent to ${to}`);
        } else {
          const {error} = await sb.rpc('invoice_issue', {p_invoice:inv.id}); if(error) throw error;
          await sb.from('invoices').update({sent_at:new Date().toISOString(), email:to}).eq('id', inv.id);
          location.href = `mailto:${encodeURIComponent(to).replace(/%40/g,'@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${message}\n\nView${pre.cardPay?' and pay':''} your invoice online:\n${pre.link}`)}`;
          await sb.from('account_comms').insert({account_id:inv.account_id, kind:'email', direction:'out', subject, body:message.slice(0,6000), to_addr:to, invoice_id:inv.id, created_by_name:ME.name, meta:{via:'email app'}});
          close(); flash('Your email app has opened with the invoice link. Press send there.');
        }
        if(after) await after();
      }catch(x){ b.disabled = false; b.textContent = mailOn ? 'Send' : 'Open in email app'; e.hidden = false; e.textContent = 'Not sent: ' + (isNetErr(x) ? 'no connection' : x.message); }
    };
    dlg.showModal();
  }

  /* ---------- the Invoices page ---------- */
  let all = [], filt = 'owed', q = '';
  const root = () => $('view-invoices');
  async function onShow(){
    if(!root()) return;
    if(!navigator.onLine){ root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Invoices</h2></div></div><section class="card"><p class="note w">Invoices need a connection.</p></section>`; return; }
    root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Invoices</h2><p class="sub">Loading…</p></div></div>`;
    const {data, error} = await sb.from('invoices').select('*').order('invoice_no', {ascending:false}).limit(2000);
    if(error){ root().innerHTML = `<section class="card"><p class="note b">Could not load invoices: ${esc(error.message)}</p></section>`; return; }
    all = data; renderPage();
  }
  function renderPage(){
    const owed = all.filter(i=>i.status==='sent'||i.status==='part_paid'), od = owed.filter(overdue), drafts = all.filter(i=>i.status==='draft');
    const month = today().slice(0,7);
    const paidMonth = all.filter(i=>i.paid_at && i.paid_at.slice(0,7)===month).reduce((s,i)=>s+(+i.paid||0),0);
    const F = {owed:['Unpaid', owed], overdue:['Overdue', od], draft:['Drafts', drafts], paid:['Paid', all.filter(i=>i.status==='paid')], all:['All', all]};
    const qq = q.trim().toLowerCase();
    const rows = F[filt][1].filter(i=> !qq || [invNo(i.invoice_no), i.bill_name, i.email, i.bill_address].join(' ').toLowerCase().includes(qq));
    root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Invoices</h2><p class="sub">${owed.length} unpaid · ${gbp(owed.reduce((s,i)=>s+left(i),0))} owed${od.length?` · <b class="inv-bad">${od.length} overdue</b>`:''}</p></div>
        <div class="vb-actions"><button class="btn" type="button" id="ivRefresh">Refresh</button></div></div>
      <div class="ac-stats">
        <div class="stat"><span>Owed</span><b>${gbp(owed.reduce((s,i)=>s+left(i),0))}</b></div>
        <div class="stat"><span>Overdue</span><b class="${od.length?'inv-bad':''}">${gbp(od.reduce((s,i)=>s+left(i),0))}</b></div>
        <div class="stat"><span>Paid this month</span><b>${gbp(paidMonth)}</b></div>
        <div class="stat"><span>Drafts to send</span><b>${drafts.length}</b></div>
      </div>
      <section class="card">
        <div class="pf-rtabs ac-tabs">${Object.entries(F).map(([k,[n,l]])=>`<button type="button" data-ivf="${k}" class="${filt===k?'on':''}">${n} (${l.length})</button>`).join('')}</div>
        <div class="fields one" style="margin-top:10px"><label class="f">Search<input id="ivQ" type="search" value="${esc(q)}" placeholder="Invoice number, customer, email or address"></label></div>
        <div class="qlist" style="margin-top:8px">${rows.map(i=>rowHTML(i, true).replace('<div class="qacts">', `<div class="qacts"><button class="btn sm" type="button" data-ivacc="${i.account_id}">Account</button>`)).join('') || '<p class="hint">Nothing here.</p>'}</div>
      </section>`;
    root().querySelectorAll('[data-ivf]').forEach(b=> b.onclick = ()=>{ filt = b.dataset.ivf; renderPage(); });
    $('ivQ').oninput = e=>{ q = e.target.value; const pos = e.target.selectionStart; renderPage(); $('ivQ').focus(); try{ $('ivQ').setSelectionRange(pos,pos); }catch(x){} };
    $('ivRefresh').onclick = onShow;
    root().querySelectorAll('[data-ivopen]').forEach(b=> b.onclick = ()=> openInvoice(b.dataset.ivopen, onShow));
    root().querySelectorAll('[data-ivacc]').forEach(b=> b.onclick = ()=>{ try{ sessionStorage.setItem('acTab', JSON.stringify({id:b.dataset.ivacc, tab:'invoices'})); }catch(e){} show('accounts'); ACCOUNTS.open(b.dataset.ivacc); });
  }

  /* ---------- Admin → Invoicing ---------- */
  async function renderAdmin(){
    const c = $('invCard'); if(!c || ROLE!=='admin') return;
    c.innerHTML = `<h2>Invoicing</h2><p class="hint">Checking…</p>`;
    let st = null; try{ st = await fn({action:'status'}); }catch(e){ st = {sage:{}, stripe:{}, error:e.message}; }
    const s = await getSettings(true);
    const S = st.sage||{}, T = st.stripe||{};
    const ago = S.lastSync ? fmtDay(S.lastSync) + ' ' + new Date(S.lastSync).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : 'not yet';
    c.innerHTML = `<h2>Invoicing</h2>
      <div class="fields" style="margin-top:10px">
        <label class="f">Days to pay<input id="isTerms" type="number" min="0" max="120" value="${s.terms_days}"></label>
        <label class="f wide">When a visit is marked done<select id="isAuto">${[['off','Nothing: invoice it from the account'],['draft','Make a draft invoice'],['send','Make the invoice and email it']].map(([k,v])=>`<option value="${k}" ${s.auto_invoice===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="ck"><input type="checkbox" id="isVat" ${s.vat_registered?'checked':''}> VAT registered</label>
        <label class="f">VAT %<input id="isVatR" type="number" step="0.1" min="0" value="${s.vat_rate}" ${s.vat_registered?'':'disabled'}></label>
        <p class="hint wide"><b>Bank details on invoices</b> (for customers paying by bank transfer to Tide)</p>
        <label class="f">Account name<input id="isBName" value="${esc(s.bank_account_name||'')}" placeholder="Purgō Clean Ltd"></label>
        <label class="f">Sort code<input id="isSort" inputmode="numeric" value="${esc(s.bank_sort_code||'')}" placeholder="00-00-00"></label>
        <label class="f">Account number<input id="isAcc" inputmode="numeric" value="${esc(s.bank_account_no||'')}"></label>
        <label class="f wide">Footer on invoices <small>(optional)</small><input id="isFoot" value="${esc(s.footer||'')}" placeholder="Thank you for choosing Purgō, a family run business."></label>
      </div>
      <div class="vb-actions" style="justify-content:flex-start;margin-top:8px"><button class="btn pri" type="button" id="isSave">Save invoicing settings</button></div>
      ${s.auto_invoice==='send' ? `<p class="hint">Invoices are emailed within 10 minutes of a visit being marked done, to the email on the customer's account. Customers with no email get a draft to send another way.</p>` : ''}

      <h3 style="margin-top:20px">Sage Accounting</h3>
      ${!S.configured ? `<p class="hint">Not set up yet. Once Purgō's Sage developer app is made, its details are added to the Portal and you press Connect here. Until then invoices and payments stay in the Portal only.</p>${S.callback?`<p class="hint">Callback URL for the Sage app: <code>${esc(S.callback)}</code></p>`:''}`
        : !S.connected ? `<p class="hint">Connect Purgō's Sage business so every invoice and payment is copied into the books for your accountant, and bank transfers matched in Sage show as paid here.</p><button class="btn pri" type="button" id="sgConnect">Connect Sage</button>`
        : `<p>Connected${S.business?`: <b>${esc(S.business)}</b>`:''}</p>
           <p class="hint">Invoices go to <b>${esc(S.ledger||'(choose)')}</b>. Bank transfers, cash and direct debits are paid into <b>${esc(S.bank||'(choose)')}</b>; card payments into <b>${esc(S.card||S.bank||'(choose)')}</b>. Copied every 10 minutes; last ${esc(ago)}.</p>
           ${!S.ready ? `<p class="note w">Choose the Sage accounts below before anything is copied.</p>` : ''}
           ${S.lastError ? `<p class="note b">${esc(S.lastError)}</p>` : ''}
           <div id="sgChoose"></div>
           <div class="vb-actions" style="justify-content:flex-start"><button class="btn" type="button" id="sgPick">Choose Sage accounts</button><button class="btn" type="button" id="sgSync">Copy to Sage now</button><button class="btn del" type="button" id="sgDisc">Disconnect</button></div>`}

      <h3 style="margin-top:20px">Card payments (Stripe)</h3>
      ${T.configured ? `<p class="hint">On${T.test ? ' in <b>test mode</b> (no real money moves)' : ''}. Invoices have a Pay now button; payments are marked on the invoice straight away and copied to Sage. Stripe pays out to Tide every few days, less its fee.</p>`
        : `<p class="hint">Not set up yet. Once Purgō has a Stripe account, its keys are added to the Portal and invoices get a Pay now button for card, Apple Pay and Google Pay. Until then invoices show bank details only.</p>`}`;
    const v = id=>$(id).value.trim();
    $('isVat').onchange = ()=>{ $('isVatR').disabled = !$('isVat').checked; };
    $('isSave').onclick = async ()=>{
      const upd = {terms_days:Math.max(0, Math.min(120, parseInt(v('isTerms'))||0)), auto_invoice:$('isAuto').value, vat_registered:$('isVat').checked, vat_rate:+v('isVatR')||20,
        bank_account_name:v('isBName')||null, bank_sort_code:v('isSort')||null, bank_account_no:v('isAcc')||null, footer:v('isFoot')||null, updated_at:new Date().toISOString()};
      $('isSave').disabled = true;
      const {error} = await sb.from('invoice_settings').update(upd).eq('id', 1);
      if(error){ $('isSave').disabled = false; flash('Not saved: ' + error.message); return; }
      flash('Invoicing settings saved'); renderAdmin();
    };
    if($('sgConnect')) $('sgConnect').onclick = async ()=>{ try{ const r = await fn({action:'sage_connect', returnTo:location.origin}); location.href = r.url; }catch(e){ flash(e.message); } };
    if($('sgDisc')) $('sgDisc').onclick = async ()=>{ if(!confirmInline('sgDisc', 'Press Disconnect again: invoices stop being copied to Sage.')) return; try{ await fn({action:'sage_disconnect'}); flash('Sage disconnected'); }catch(e){ flash(e.message); } renderAdmin(); };
    if($('sgSync')) $('sgSync').onclick = async ()=>{ $('sgSync').disabled = true; try{ const r = await fn({action:'sync'}); const g = r.sage||{};
        flash(g.waiting || (g.connected ? `Sage: ${g.invoices||0} invoice${g.invoices===1?'':'s'}, ${g.payments||0} payment${g.payments===1?'':'s'} copied${g.received?`, ${g.received} payment${g.received===1?'':'s'} found`:''}${g.failed?` · ${g.failed} failed`:''}` : 'Sage isn\'t connected')); }
      catch(e){ flash('Sage: ' + e.message); } renderAdmin(); };
    if($('sgPick')) $('sgPick').onclick = async ()=>{
      const box = $('sgChoose'); box.innerHTML = '<p class="hint">Loading from Sage…</p>';
      let o; try{ o = await fn({action:'sage_options'}); }catch(e){ box.innerHTML = `<p class="note b">${esc(e.message)}</p>`; return; }
      const sel = (id, list, cur, blank)=>`<select id="${id}">${blank?`<option value="">${blank}</option>`:''}${list.map(x=>`<option value="${esc(x.id)}" ${x.id===cur?'selected':''}>${esc(x.name)}</option>`).join('')}</select>`;
      box.innerHTML = `<div class="fields" style="margin:8px 0">
        <label class="f">Sales go to${sel('sgL', o.ledgers, o.chosen.ledger)}</label>
        <label class="f">Bank transfers, cash, direct debits into${sel('sgB', o.banks, o.chosen.bank)}</label>
        <label class="f">Card payments (Stripe) into${sel('sgC', o.banks, o.chosen.card, 'Same as bank transfers')}</label>
        <label class="f">VAT rate when VAT is charged${sel('sgTs', o.taxRates, o.chosen.taxStandard)}</label>
        <label class="f">VAT rate when there's no VAT${sel('sgTn', o.taxRates, o.chosen.taxNone)}</label>
        <p class="hint wide">Ask your accountant which accounts they want. A common setup is a separate "Stripe" bank account in Sage for card payments, as Stripe pays out to Tide in batches less its fees.</p>
        <div class="vb-actions wide" style="justify-content:flex-start"><button class="btn pri" type="button" id="sgSave">Save Sage choices</button></div></div>`;
      const pick = (id, list)=>{ const x = list.find(y=>y.id===$(id).value); return x ? {id:x.id, name:x.name} : null; };
      $('sgSave').onclick = async ()=>{ try{ await fn({action:'sage_choose', ledger:pick('sgL', o.ledgers), bank:pick('sgB', o.banks), card:pick('sgC', o.banks), taxStandard:pick('sgTs', o.taxRates), taxNone:pick('sgTn', o.taxRates)}); flash('Sage choices saved'); }catch(e){ flash(e.message); } renderAdmin(); };
    };
  }

  // back from Sage's sign-in
  const back = new URLSearchParams(location.search).get('sage');
  if(back){ const msg = {connected:'Sage connected. Check the accounts it picked in Admin → Invoicing.', cancelled:'Connecting Sage was cancelled.', expired:'That took too long. Press Connect Sage again.', failed:'Sage didn\'t return access. Press Connect Sage again.'}[back];
    if(msg) setTimeout(()=>flash(msg), 700); history.replaceState(null, '', location.pathname + location.hash); }

  return {fn, loadAccount, accountHTML, wireAccount, openInvoice, onShow, renderAdmin, invNo};
})();
