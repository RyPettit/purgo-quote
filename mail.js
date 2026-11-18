/* =====================================================================
   Purgō email: send quotes and messages to customers, the online
   "accept your quote" link, the Gmail connection (Admin) and the
   notification bell.
   Sends from the connected Google mailbox when there is one; until then
   it opens the email app on this device with the message ready to go.
   Uses from purgo.js: $, esc, gbp, sb, ME, ROLE, show, flash, isNetErr, CFG, last, calc, lastQuoteModel,
     editing, quoteAccount, ensureNumber, quoteHTML, quoteText, buildQuotePdf, pdfName, setQuoteStatus, pricing, fmtDay
   ===================================================================== */
const MAIL = (()=>{
  let st = null, stAt = 0, started = false;
  let notes = [], notesTimer = null, channel = null, firstLoad = true;

  async function fn(body){
    const {data, error} = await sb.functions.invoke('mail', {body});
    if(error){ let m = error.message; try{ const j = await error.context.json(); if(j && j.error) m = j.error; }catch(e){} throw new Error(m); }
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  async function status(force){
    if(!force && st && Date.now()-stAt < 60e3) return st;
    try{ st = await fn({action:'status'}); }catch(e){ st = st || {configured:false, connected:false}; }
    stAt = Date.now(); return st;
  }
  const firstName = s => { const n = String(s||'').trim(); if(!n || /\b(ltd|limited|plc|llp|management|properties|lettings|services|group|council|school|church)\b/i.test(n)) return ''; return n.split(/\s+/)[0]; };
  const hello = n => n ? `Hi ${n},` : 'Hello,';
  const signoff = () => `Kind regards,\n${(ME && ME.name) || 'Purgō'}\nPurgō\n07930 877034`;
  const paras = msg => esc(msg).split(/\n{2,}/).map(p=>`<p style="margin:0 0 12px">${p.replace(/\n/g,'<br>')}</p>`).join('');
  const F = "font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;";
  const wrapHtml = (msg, extra) => `<div style="${F}color:#132f47;font-size:15px;line-height:1.5;max-width:640px">${paras(msg)}${extra ? `<div style="margin-top:18px">${extra}</div>` : `<p style="margin:16px 0 0;color:#53708a;font-size:13px">Purgō, family run exterior cleaning<br>Tel 07930 877034 · www.purgo-clean.com</p>`}</div>`;
  const toB64 = doc => doc.output('datauristring').split(',')[1];

  /* ---------- compose dialog ---------- */
  // o: {title, to, toOptions:[{label,email}], subject, text, templates:{key:{label,subject,text}}, note,
  //     build(msg)->{html,text}, appBody(msg)->text, attach:{label, make()->[{name,type,b64}]},
  //     beforeSend(), accountId, quoteId, onSent(via)}
  async function compose(o){
    const s = await status();
    const dlg = document.createElement('dialog'); dlg.className = 'ac-dlg ml-dlg';
    const via = s.connected ? `Sends from <b>${esc(s.address)}</b>. It's logged on the customer's account.`
      : `Email isn't connected to the Portal yet, so this opens the email app on this device with the message ready. ${o.attach ? 'Attachments can\'t be added that way, but the email includes the link to the quote online.' : ''}`;
    dlg.innerHTML = `<h2>${esc(o.title)}</h2>
      <p class="hint ml-via">${via}</p>
      <div class="fields one">
        <label class="f">To<input id="mlTo" type="email" multiple autocapitalize="off" spellcheck="false" value="${esc(o.to||'')}" list="mlToList" placeholder="customer@example.com">
          ${o.toOptions && o.toOptions.length ? `<datalist id="mlToList">${o.toOptions.map(t=>`<option value="${esc(t.email)}">${esc(t.label)}</option>`).join('')}</datalist>` : ''}</label>
        ${s.connected ? `<label class="f">Cc <small>(optional)</small><input id="mlCc" autocapitalize="off" spellcheck="false"></label>` : ''}
        ${o.templates ? `<label class="f">Template<select id="mlTpl">${Object.entries(o.templates).map(([k,t])=>`<option value="${k}">${esc(t.label)}</option>`).join('')}</select></label>` : ''}
        <label class="f">Subject<input id="mlSubj" value="${esc(o.subject||'')}"></label>
        <label class="f">Message<textarea id="mlBody" rows="10">${esc(o.text||'')}</textarea></label>
      </div>
      ${o.note ? `<p class="hint">${o.note}</p>` : ''}
      ${o.attach && s.connected ? `<label class="ck" style="margin-top:8px"><input type="checkbox" id="mlAttach" checked> ${esc(o.attach.label)}</label>` : ''}
      <p class="note b" id="mlErr" hidden></p>
      <div class="vb-actions" style="margin-top:14px"><button class="btn" type="button" id="mlCancel">Cancel</button><button class="btn pri" type="button" id="mlSend">${s.connected ? 'Send' : 'Open in email app'}</button></div>`;
    document.body.appendChild(dlg);
    const close = ()=>{ dlg.close(); dlg.remove(); };
    dlg.querySelector('#mlCancel').onclick = close;
    dlg.addEventListener('cancel', e=>{ e.preventDefault(); close(); });
    const tpl = dlg.querySelector('#mlTpl');
    if(tpl) tpl.onchange = ()=>{ const t = o.templates[tpl.value]; dlg.querySelector('#mlSubj').value = t.subject; dlg.querySelector('#mlBody').value = t.text; };
    dlg.querySelector('#mlSend').onclick = async ()=>{
      const err = dlg.querySelector('#mlErr'); err.hidden = true;
      const to = dlg.querySelector('#mlTo').value.trim(), subject = dlg.querySelector('#mlSubj').value.trim(), msg = dlg.querySelector('#mlBody').value.trim();
      if(!/\S+@\S+\.\S+/.test(to)){ err.hidden = false; err.textContent = "Add the customer's email address."; return; }
      if(!msg){ err.hidden = false; err.textContent = 'Write a message.'; return; }
      const btn = dlg.querySelector('#mlSend'); btn.disabled = true; btn.textContent = s.connected ? 'Sending…' : 'Opening…';
      try{
        if(o.beforeSend) await o.beforeSend();
        if(s.connected){
          const built = o.build ? o.build(msg) : {html:wrapHtml(msg), text:msg};
          const attachments = o.attach && dlg.querySelector('#mlAttach') && dlg.querySelector('#mlAttach').checked ? await o.attach.make() : [];
          await fn({action:'send', to, cc:(dlg.querySelector('#mlCc')||{}).value||'', subject, html:built.html, text:built.text, logText:built.log||built.text, attachments, accountId:o.accountId||null, quoteId:o.quoteId||null});
          close(); flash(`Sent to ${to}`);
          if(o.onSent) await o.onSent('gmail', to);
        } else {
          const body = o.appBody ? o.appBody(msg) : msg;
          location.href = `mailto:${encodeURIComponent(to).replace(/%40/g,'@').replace(/%2C/g,',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          if(o.accountId) await sb.from('account_comms').insert({account_id:o.accountId, kind:'email', direction:'out', subject, body:body.slice(0,6000), to_addr:to, quote_id:o.quoteId||null, created_by_name:ME.name, meta:{via:'email app'}});
          close(); flash('Your email app has opened with the message. Press send there.');
          if(o.onSent) await o.onSent('app', to);
        }
      }catch(e){ btn.disabled = false; btn.textContent = s.connected ? 'Send' : 'Open in email app'; err.hidden = false; err.textContent = 'Not sent: ' + (isNetErr(e) ? 'no connection' : e.message); }
    };
    dlg.showModal();
    setTimeout(()=>{ const t = dlg.querySelector('#mlTo'); (t.value ? dlg.querySelector('#mlBody') : t).focus(); }, 30);
  }

  /* ---------- email the open quote ---------- */
  async function emailQuote(){
    const o = last || calc();
    if(!(o.sub>0)){ flash('Add some work to the quote first'); return; }
    if(!navigator.onLine){ flash('Emailing a quote needs a connection'); return; }
    const btn = $('emailQ'); btn.disabled = true;
    try{
      await ensureNumber();
      if(!editing || !editing.id){ flash('Save the quote first'); return; }
      const qid = editing.id, m = lastQuoteModel;
      const {data:tok, error} = await sb.rpc('share_quote', {p_quote:qid, p_html:null});
      if(error) throw error;
      const link = `${location.origin}/q?t=${tok}`;
      const row = (await sb.from('quotes').select('account_id,status,email').eq('id', qid).maybeSingle()).data || {};
      const accountId = quoteAccount || row.account_id || null;
      const first = firstName($('cust').value);
      const s = await status();
      const msg = `${hello(first)}\n\nThank you for getting in touch. Your quote ${m.ref} is below${s.connected ? ', with a PDF copy attached' : ''}.\n\nYou can accept it online in a couple of clicks using the button in this email, or just reply to let us know. If you have any questions, give us a call on 07930 877034.\n\n${signoff()}`;
      await compose({
        title: `Email quote ${m.ref}`, to: $('email').value.trim() || row.email || '', subject: `Your Purgō quote ${m.ref}`, text: msg,
        note: 'The email includes the full quote and a <b>View and accept your quote</b> button. When the customer accepts, the quote is marked Accepted and you get a notification.',
        accountId, quoteId: qid,
        build: t => ({html: wrapHtml(t, quoteHTML(m, {acceptUrl:link})), text: `${t}\n\n${quoteText(m, {acceptUrl:link})}`, log: `${t}\n\n(Quote ${m.ref} for ${gbp(m.total)} included, with the link to accept online.)`}),
        appBody: t => `${t}\n\nView and accept your quote online:\n${link}`,
        attach: {label:`Attach the quote as a PDF (${pdfName(m)})`, make: async ()=> [{name:pdfName(m), type:'application/pdf', b64:toB64(await buildQuotePdf(m, {acceptUrl:link}))}]},
        beforeSend: async ()=>{ const r = await sb.rpc('share_quote', {p_quote:qid, p_html:quoteHTML(m, {acceptUrl:link})}); if(r.error) throw r.error; },
        onSent: async (via, to)=>{
          if(!row.email || row.email!==to){ await sb.from('quotes').update({email:to}).eq('id', qid); if(editing && editing.id===qid && !$('email').value.trim()) $('email').value = to; }
          if(row.status==='draft' || row.status==='sent' || !row.status) await setQuoteStatus(qid, 'sent', true);
        }
      });
    }catch(e){ flash('Could not prepare the email: ' + (isNetErr(e) ? 'no connection' : e.message)); }
    finally{ btn.disabled = false; }
  }

  /* ---------- email from an account page ---------- */
  function accountTemplates(a, contacts){
    const prim = contacts.find(c=>c.is_primary) || contacts[0];
    const first = a.kind==='res' ? firstName(a.name) : firstName(prim && prim.name);
    const h = hello(first), sig = signoff();
    return {
      blank:    {label:'Blank message', subject:'Purgō', text:`${h}\n\n\n\n${sig}`},
      followup: {label:'Quote follow-up', subject:'Your Purgō quote', text:`${h}\n\nI just wanted to check you received your quote and see whether you had any questions. We'd be happy to talk it through or find a date that suits you.\n\n${sig}`},
      booking:  {label:'Booking confirmation', subject:'Your Purgō booking', text:`${h}\n\nThis is to confirm we've booked your clean for [day and date]. We'll arrive between [time] and [time].\n\nPlease make sure we can get to any side or back gates, and that cars are moved off the drive if we're cleaning it. You don't need to be in.\n\n${sig}`},
      reminder: {label:'Visit reminder', subject:'Purgō visit tomorrow', text:`${h}\n\nJust a reminder that we're due with you tomorrow. Please leave gates unlocked and move any cars off areas we're cleaning.\n\n${sig}`},
      thanks:   {label:'Thank you and review request', subject:'Thank you from Purgō', text:`${h}\n\nThank you for choosing Purgō. We hope you're happy with the results.\n\nIf you have a moment, a quick Google review would mean a lot to us as a small family business.\n\n${sig}`}
    };
  }
  function composeAccount(d, to){
    const a = d.acc, contacts = d.contacts || [];
    const opts = [a.email ? {label:a.name, email:a.email} : null, ...contacts.filter(c=>c.email).map(c=>({label:`${c.name}${c.role?' ('+c.role+')':''}`, email:c.email}))].filter(Boolean);
    const T = accountTemplates(a, contacts);
    return compose({title:`Email ${a.name}`, to: to || a.email || (opts[0] && opts[0].email) || '', toOptions:opts, templates:T, subject:T.blank.subject, text:T.blank.text,
      accountId:a.id, onSent: async ()=>{ if(typeof ACCOUNTS!=='undefined' && ACCOUNTS.refresh) ACCOUNTS.refresh(); }});
  }

  /* ---------- Admin: connect the mailbox ---------- */
  async function renderAdmin(){
    const c = $('mailCard'); if(!c || ROLE!=='admin') return;
    c.innerHTML = `<h2>Email</h2><p class="hint">Checking…</p>`;
    const s = await status(true);
    const ago = s.lastSync ? fmtDay(s.lastSync) + ' ' + new Date(s.lastSync).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : 'not yet';
    c.innerHTML = `<h2>Email</h2>` + (
      !s.configured ? `<p class="hint">Not connected yet. Once Purgō's Google Workspace account is live, the Google sign-in details get added here and you press Connect. Until then, emails open in the email app on your device.</p>`
      : !s.connected ? `<p class="hint">Connect the Purgō mailbox so quotes and messages send from the Portal and customer emails appear on their accounts. You'll sign in with Google and approve access.</p><button class="btn pri" type="button" id="mlConnect">Connect Google mailbox</button>`
      : `<p>Connected: <b>${esc(s.address)}</b></p><p class="hint">Customer emails are checked every couple of minutes and added to their account's Communication tab. Last checked ${esc(ago)}.</p>
         ${s.lastError ? `<p class="note b">Last check failed: ${esc(s.lastError)}</p>` : ''}
         <div class="vb-actions" style="justify-content:flex-start"><button class="btn" type="button" id="mlSync">Check now</button><button class="btn del" type="button" id="mlDisc">Disconnect</button></div>`);
    if($('mlConnect')) $('mlConnect').onclick = async ()=>{ try{ const r = await fn({action:'connect', returnTo:location.origin}); location.href = r.url; }catch(e){ flash(e.message); } };
    if($('mlSync')) $('mlSync').onclick = async ()=>{ $('mlSync').disabled = true; try{ const r = await fn({action:'sync'}); flash(r.added ? `${r.added} new email${r.added>1?'s':''} added to accounts` : 'No new customer emails'); }catch(e){ flash('Check failed: ' + e.message); } renderAdmin(); };
    if($('mlDisc')) $('mlDisc').onclick = async ()=>{ if(!confirmInline('mlDisc', 'Press Disconnect again to stop the Portal using the mailbox.')) return; try{ await fn({action:'disconnect'}); flash('Mailbox disconnected'); }catch(e){ flash(e.message); } renderAdmin(); };
  }

  /* ---------- notification bell ---------- */
  const ICON = {quote_accepted:'✓', quote_declined:'✕', quote_question:'?', email_in:'✉'};
  function bellUI(){
    if($('bell')) return;
    const u = $('tbUser'); if(!u) return;
    u.insertAdjacentHTML('afterbegin', `<div class="bell-wrap"><button class="bell" id="bell" type="button" aria-label="Notifications" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>
      <span class="bell-n" id="bellN" hidden></span></button><div class="bell-panel" id="bellPanel" hidden></div></div>`);
    $('bell').onclick = e=>{ e.stopPropagation(); const p = $('bellPanel'); p.hidden = !p.hidden; $('bell').setAttribute('aria-expanded', String(!p.hidden)); if(!p.hidden) drawPanel(); };
    document.addEventListener('click', e=>{ const p = $('bellPanel'); if(p && !p.hidden && !e.target.closest('.bell-wrap')){ p.hidden = true; $('bell').setAttribute('aria-expanded','false'); } });
  }
  function drawBadge(){
    const n = notes.filter(x=>!x.read_at).length, b = $('bellN'); if(!b) return;
    b.hidden = !n; b.textContent = n > 9 ? '9+' : n;
  }
  function drawPanel(){
    const p = $('bellPanel'); if(!p) return;
    const unread = notes.some(x=>!x.read_at);
    p.innerHTML = `<div class="bp-head"><b>Notifications</b>${unread ? `<button class="linkbtn" type="button" id="bpAll">Mark all read</button>` : ''}</div>` +
      (notes.length ? notes.map(x=>`<button type="button" class="bp-item ${x.read_at?'':'new'} ${esc(x.kind)}" data-note="${x.id}"><i>${ICON[x.kind]||'•'}</i><span><b>${esc(x.title)}</b>${x.body?`<small>${esc(x.body)}</small>`:''}<small>${fmtDay(x.created_at)} ${new Date(x.created_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</small></span></button>`).join('')
        : '<p class="hint" style="padding:10px 12px">Nothing yet. You\'ll see quotes accepted online, customer questions and new emails here.</p>');
    p.querySelectorAll('[data-note]').forEach(b=> b.onclick = ()=> openNote(notes.find(x=>x.id===b.dataset.note)));
    if($('bpAll')) $('bpAll').onclick = async ()=>{ const ids = notes.filter(x=>!x.read_at).map(x=>x.id); const now = new Date().toISOString();
      notes.forEach(x=>{ if(!x.read_at) x.read_at = now; }); drawBadge(); drawPanel();
      await sb.from('notifications').update({read_at:now, read_by_name:ME.name}).in('id', ids); };
  }
  async function openNote(x){
    if(!x) return;
    $('bellPanel').hidden = true;
    if(!x.read_at){ x.read_at = new Date().toISOString(); drawBadge(); sb.from('notifications').update({read_at:x.read_at, read_by_name:ME.name}).eq('id', x.id).then(()=>{}); }
    if(x.account_id && typeof ACCOUNTS!=='undefined'){ try{ sessionStorage.setItem('acTab', JSON.stringify({id:x.account_id, tab:'comms'})); }catch(e){} ACCOUNTS.open(x.account_id); }
    else if(x.quote_id){ const b = document.createElement('button'); b.dataset.openq = x.quote_id; b.hidden = true; document.body.appendChild(b); b.click(); b.remove(); }
  }
  async function loadNotes(){
    if(!ME || ROLE==='customer' || !navigator.onLine) return;
    const {data, error} = await sb.from('notifications').select('*').order('created_at', {ascending:false}).limit(40);
    if(error || !data) return;
    const known = new Set(notes.map(x=>x.id));
    const fresh = data.filter(x=>!known.has(x.id) && !x.read_at);
    notes = data; drawBadge(); if($('bellPanel') && !$('bellPanel').hidden) drawPanel();
    if(!firstLoad && fresh.length) arrived(fresh);
    firstLoad = false;
  }
  function arrived(list){
    flash(list.length===1 ? list[0].title : `${list.length} new notifications`);
    if(list.some(x=>/^quote_/.test(x.kind)) && typeof loadQuotes==='function' && quotesLoaded) loadQuotes();
  }
  function start(){
    if(started || !ME || ROLE==='customer') return; started = true;
    bellUI(); firstLoad = true; loadNotes();
    clearInterval(notesTimer); notesTimer = setInterval(loadNotes, 60e3);
    document.addEventListener('visibilitychange', onVis);
    try{
      channel = sb.channel('purgo-notifications').on('postgres_changes', {event:'INSERT', schema:'public', table:'notifications'}, p=>{
        const x = p.new; if(!x || notes.some(n=>n.id===x.id)) return;
        notes.unshift(x); drawBadge(); if(!$('bellPanel').hidden) drawPanel(); arrived([x]);
      }).subscribe();
    }catch(e){}
    status(true);
    const q = new URLSearchParams(location.search).get('mail');
    if(q){ const msg = {connected:'Mailbox connected. Customer emails will start appearing on their accounts.', cancelled:'Connecting the mailbox was cancelled.', expired:'That took too long. Press Connect again.', failed:'Google didn\'t return access. Press Connect again and approve everything it asks.'}[q];
      if(msg) setTimeout(()=>flash(msg), 600); history.replaceState(null, '', location.pathname + location.hash); }
  }
  const onVis = ()=>{ if(document.visibilityState==='visible') loadNotes(); };
  function stop(){
    started = false; clearInterval(notesTimer); notes = []; st = null;
    document.removeEventListener('visibilitychange', onVis);
    if(channel){ try{ sb.removeChannel(channel); }catch(e){} channel = null; }
    const w = document.querySelector('.bell-wrap'); if(w) w.remove();
  }

  if($('emailQ')) $('emailQ').onclick = emailQuote;
  return {start, stop, status, compose, composeAccount, emailQuote, renderAdmin};
})();
if(typeof ME!=='undefined' && ME && ROLE && ROLE!=='customer') MAIL.start();
