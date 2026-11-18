/* =====================================================================
   Purgō Accounts (CRM): one record per customer — household, business or
   managing agent — holding their details, contacts, properties, quotes,
   invoices (next phase) and every communication.
   Quotes join an account automatically when saved (database trigger), so
   nothing about quoting changes for staff.
   Uses from purgo.js: $, esc, gbp, sb, ME, ROLE, show, flash, noLabel, slug, normPc, fmtPc, isNetErr, confirmInline
   ===================================================================== */
const ACCOUNTS = (()=>{
  const KINDS = {res:'Residential', com:'Commercial', agent:'Managing agent'};
  const STATUSES = {lead:'Lead', active:'Customer', inactive:'Inactive'};
  const COMMS = {note:'Note', call:'Phone call', sms:'Text message', email:'Email', visit:'Site visit'};
  const QST = {draft:'Draft', sent:'Sent', accepted:'Accepted', declined:'Declined'};
  const accNo = n => `AC-${n}`;
  const root = () => $('view-accounts');
  const fmtD = v => { if(!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}); };
  const fmtDT = v => { if(!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleString('en-GB', {day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'}); };
  const digits = s => String(s||'').replace(/[^\d+]/g,'');
  const localDT = d => { const p = n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  let list = [], loaded = false, loading = false, err = '';
  let f = {q:'', kind:'', status:''}, sortKey = 'recent';
  let cur = null, tab = 'overview', detail = null, composer = null, editContact = null, mergeOpen = false;

  /* ---------- data ---------- */
  async function loadList(){
    loading = true;
    const {data, error} = await sb.from('accounts')
      .select('id,account_no,name,kind,status,email,phone,billing_line,billing_postcode,tags,portfolio_id,updated_at,created_at,quotes(id,status,total,created_at,updated_at),addresses(id),account_comms(occurred_at)')
      .order('name').limit(5000);
    loading = false;
    if(error) throw error;
    list = data.map(a=>{
      const qs = a.quotes||[];
      const lastQ = qs.reduce((m,q)=>Math.max(m, +new Date(q.updated_at||q.created_at)||0), 0);
      const lastC = (a.account_comms||[]).reduce((m,c)=>Math.max(m, +new Date(c.occurred_at)||0), 0);
      return Object.assign(a, {
        nQuotes: qs.length, nProps: (a.addresses||[]).length,
        won: qs.filter(q=>q.status==='accepted').reduce((s,q)=>s+(+q.total||0),0),
        open: qs.filter(q=>q.status==='sent'||q.status==='draft').reduce((s,q)=>s+(+q.total||0),0),
        lastAt: Math.max(lastQ, lastC, +new Date(a.created_at)||0)
      });
    });
    loaded = true; err = '';
  }
  async function loadDetail(id){
    const [a, c, q, p, m] = await Promise.all([
      sb.from('accounts').select('*').eq('id', id).maybeSingle(),
      sb.from('account_contacts').select('*').eq('account_id', id).order('is_primary', {ascending:false}).order('name'),
      sb.from('quotes').select('id,ref,quote_no,status,customer,address,postcode,total,created_at,updated_at,sent_at,created_by_name' + (ROLE==='admin' ? ',quote_costs(profit,margin)' : '')).eq('account_id', id).order('created_at', {ascending:false}),
      sb.from('addresses').select('id,key,line,postcode,notes,last_quoted').eq('account_id', id).order('last_quoted', {ascending:false, nullsFirst:false}),
      sb.from('account_comms').select('*').eq('account_id', id).order('occurred_at', {ascending:false}).limit(500)
    ]);
    for(const r of [a,c,q,p,m]) if(r.error) throw r.error;
    if(!a.data) throw new Error('This account no longer exists.');
    let pf = null;
    if(a.data.portfolio_id){ const r = await sb.from('portfolios').select('id,name,status').eq('id', a.data.portfolio_id).maybeSingle(); pf = r.data||null; }
    detail = {acc:a.data, contacts:c.data, quotes:q.data, props:p.data, comms:m.data, portfolio:pf};
  }

  /* ---------- list ---------- */
  function filtered(){
    const q = f.q.trim().toLowerCase(), qd = digits(q);
    let out = list.filter(a=>
      (!f.kind || a.kind===f.kind) && (!f.status || a.status===f.status) &&
      (!q || [a.name, a.email, a.billing_line, a.billing_postcode, accNo(a.account_no), (a.tags||[]).join(' ')].join(' ').toLowerCase().includes(q)
          || (qd.length>=4 && digits(a.phone).includes(qd))));
    const by = {recent:(x,y)=>y.lastAt-x.lastAt, name:(x,y)=>x.name.localeCompare(y.name), value:(x,y)=>(y.won+y.open)-(x.won+x.open), no:(x,y)=>y.account_no-x.account_no}[sortKey];
    return out.sort(by);
  }
  function renderList(){
    const rows = filtered();
    const counts = {lead:0, active:0, inactive:0}; list.forEach(a=>counts[a.status]=(counts[a.status]||0)+1);
    root().innerHTML = `
    <div class="viewbar"><div><h2 class="vtitle">Accounts</h2><p class="sub">${loading && !loaded ? 'Loading…' : `${list.length} account${list.length===1?'':'s'} · ${counts.active} customer${counts.active===1?'':'s'} · ${counts.lead} lead${counts.lead===1?'':'s'}`}</p></div>
      <div class="vb-actions"><button class="btn" type="button" id="acRefresh">Refresh</button><button class="btn pri" type="button" id="acNew">New account</button></div></div>
    <section class="card" id="acNewCard" hidden></section>
    <section class="card">
      <div class="fields">
        <label class="f wide">Search<input id="acSearch" type="search" value="${esc(f.q)}" placeholder="Name, phone, email, postcode, account no. or tag"></label>
        <label class="f">Type<select id="acKind"><option value="">All</option>${Object.entries(KINDS).map(([k,v])=>`<option value="${k}" ${f.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="f">Status<select id="acStatus"><option value="">All</option>${Object.entries(STATUSES).map(([k,v])=>`<option value="${k}" ${f.status===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="f">Sort<select id="acSort">${[['recent','Most recent activity'],['name','Name A–Z'],['value','Highest value'],['no','Newest account']].map(([k,v])=>`<option value="${k}" ${sortKey===k?'selected':''}>${v}</option>`).join('')}</select></label>
      </div>
      ${err ? `<p class="note b">${esc(err)} <button class="btn sm" type="button" id="acRetry">Try again</button></p>` : ''}
      <div class="ac-list">${rows.length ? rows.map(a=>`
        <button type="button" class="ac-row" data-acc="${a.id}">
          <span class="ac-n"><b>${esc(a.name)}</b><small>${accNo(a.account_no)} · ${KINDS[a.kind]||''}${a.billing_postcode?' · '+esc(a.billing_postcode):''}</small></span>
          <span class="ac-c"><small>${esc(a.phone||'')}</small><small>${esc(a.email||'')}</small></span>
          <span class="ac-q"><small>${a.nQuotes} quote${a.nQuotes===1?'':'s'}${a.nProps?` · ${a.nProps} propert${a.nProps===1?'y':'ies'}`:''}</small><small>${a.won?`${gbp(a.won)} won`:''}${a.won&&a.open?' · ':''}${a.open?`${gbp(a.open)} open`:''}</small></span>
          <span class="pill ac-st ${a.status}">${STATUSES[a.status]}</span>
        </button>`).join('') : `<p class="hint">${loading ? 'Loading accounts…' : list.length ? 'No accounts match the search or filters.' : 'No accounts yet. Every saved quote opens an account automatically, or press New account.'}</p>`}</div>
    </section>`;
    const re = ()=>{ const el = document.activeElement, id = el && el.id, pos = el && el.selectionStart; renderList(); if(id && $(id)){ $(id).focus(); try{ $(id).setSelectionRange(pos,pos); }catch(e){} } };
    $('acSearch').oninput = e=>{ f.q = e.target.value; re(); };
    $('acKind').onchange = e=>{ f.kind = e.target.value; renderList(); };
    $('acStatus').onchange = e=>{ f.status = e.target.value; renderList(); };
    $('acSort').onchange = e=>{ sortKey = e.target.value; renderList(); };
    $('acRefresh').onclick = ()=> refreshList();
    if($('acRetry')) $('acRetry').onclick = ()=> refreshList();
    $('acNew').onclick = ()=> newForm();
    root().querySelectorAll('[data-acc]').forEach(b=> b.onclick = ()=> open(b.dataset.acc));
  }
  async function refreshList(){
    try{ await loadList(); }catch(e){ err = isNetErr(e) ? 'Could not reach the server. Check your connection.' : 'Could not load accounts: ' + (e.message||e); }
    if(!cur) renderList();
  }

  /* ---------- new account ---------- */
  function newForm(){
    const c = $('acNewCard'); c.hidden = false;
    c.innerHTML = `<h2>New account</h2>
      <div class="fields" style="margin-top:12px">
        <label class="f">Name<input id="naName" placeholder="Customer, business or agent"></label>
        <label class="f">Type<select id="naKind">${Object.entries(KINDS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="f">Phone<input id="naPhone" inputmode="tel"></label>
        <label class="f">Email<input id="naEmail" type="email" autocapitalize="off" spellcheck="false"></label>
        <label class="f">Address<input id="naLine"></label>
        <label class="f">Postcode<input id="naPc"></label>
        <label class="f">How they found us<input id="naSource" placeholder="Google, Facebook, referral…"></label>
      </div>
      <div class="vb-actions" style="margin-top:12px"><button class="btn" type="button" id="naCancel">Cancel</button><button class="btn pri" type="button" id="naSave">Create account</button></div>`;
    $('naName').focus();
    $('naCancel').onclick = ()=>{ c.hidden = true; c.innerHTML = ''; };
    $('naSave').onclick = async ()=>{
      const name = $('naName').value.trim(); if(!name){ flash('Give the account a name'); return; }
      const email = $('naEmail').value.trim().toLowerCase(), phone = $('naPhone').value.trim();
      const dup = list.find(a=> (email && (a.email||'').toLowerCase()===email) || (digits(phone).length>=10 && digits(a.phone)===digits(phone)));
      if(dup && !confirmInline('naDup', `${dup.name} (${accNo(dup.account_no)}) already has that ${email && (dup.email||'').toLowerCase()===email ? 'email' : 'phone number'}. Press Create account again to make a separate account anyway.`)) return;
      $('naSave').disabled = true;
      const line = $('naLine').value.trim(), pc = fmtPc($('naPc').value);
      const rec = {name, kind:$('naKind').value, phone:phone||null, email:email||null, billing_line:line||null, billing_postcode:pc||null, source:$('naSource').value.trim()||null, created_by_name:ME.name};
      const {data, error} = await sb.from('accounts').insert(rec).select('id').single();
      $('naSave').disabled = false;
      if(error){ flash('Not saved: ' + (isNetErr(error)?'no connection':error.message)); return; }
      if(line || pc) await sb.from('addresses').upsert({key:slug(normPc(pc)+'-'+line), line, postcode:pc, customer:name, phone, email, account_id:data.id}, {onConflict:'key'});
      flash(`Created ${name}`); loaded = false; open(data.id);
    };
  }

  /* ---------- account page ---------- */
  async function open(id){
    cur = id; tab = tabFromSession(id); composer = null; editContact = null; mergeOpen = false;
    try{ sessionStorage.setItem('acCur', id); }catch(e){}
    if($('view-accounts').hidden) show('accounts');
    root().innerHTML = `<section class="card"><p class="hint">Loading account…</p></section>`;
    try{ await loadDetail(id); }
    catch(e){ root().innerHTML = `<section class="card"><p class="note b">${esc(isNetErr(e)?'Could not reach the server. Check your connection.':e.message||e)}</p><button class="btn" type="button" id="acBack">Back to accounts</button></section>`; $('acBack').onclick = back; return; }
    renderDetail(); window.scrollTo(0,0);
  }
  function tabFromSession(id){ try{ const t = JSON.parse(sessionStorage.getItem('acTab')||'{}'); return t.id===id ? t.tab : 'overview'; }catch(e){ return 'overview'; } }
  function setTab(t){ tab = t; try{ sessionStorage.setItem('acTab', JSON.stringify({id:cur, tab:t})); }catch(e){} renderDetail(); }
  function back(){ cur = null; detail = null; try{ sessionStorage.removeItem('acCur'); }catch(e){} if(!loaded) return onShow(); renderList(); refreshList().then(()=>{ if(!cur) renderList(); }); window.scrollTo(0,0); }

  function stats(){
    const qs = detail.quotes;
    const won = qs.filter(q=>q.status==='accepted'), open = qs.filter(q=>q.status==='sent');
    const lastC = detail.comms[0];
    return `<div class="ac-stats">
      <div class="stat"><span>Quotes</span><b>${qs.length}</b></div>
      <div class="stat"><span>Won</span><b>${gbp(won.reduce((s,q)=>s+(+q.total||0),0))}</b></div>
      <div class="stat"><span>Awaiting reply</span><b>${gbp(open.reduce((s,q)=>s+(+q.total||0),0))}</b></div>
      <div class="stat"><span>Last contact</span><b>${lastC ? fmtD(lastC.occurred_at) : '—'}</b></div>
    </div>`;
  }
  function renderDetail(){
    const a = detail.acc;
    const tabs = [['overview','Overview'],['quotes',`Quotes (${detail.quotes.length})`],['invoices','Invoices'],['comms',`Communication (${detail.comms.length})`]];
    const tel = a.phone ? `<a class="btn" href="tel:${esc(digits(a.phone))}" data-log-call>Call</a>` : '';
    const mail = a.email ? `<button class="btn" type="button" id="acEmail">Email</button>` : '';
    root().innerHTML = `
    <div class="viewbar"><div>
        <button class="linkbtn" type="button" id="acBack">← All accounts</button>
        <h2 class="vtitle">${esc(a.name)} <span class="ref-inline">${accNo(a.account_no)}</span></h2>
        <p class="sub">${KINDS[a.kind]} · <span class="pill ac-st ${a.status}">${STATUSES[a.status]}</span>${a.billing_line||a.billing_postcode ? ' · '+esc([a.billing_line,a.billing_postcode].filter(Boolean).join(', ')) : ''}</p>
      </div>
      <div class="vb-actions">${tel}${mail}<button class="btn" type="button" id="acLog">Log contact</button><button class="btn pri" type="button" id="acQuote">New quote</button></div></div>
    ${stats()}
    <div class="pf-rtabs ac-tabs">${tabs.map(([k,v])=>`<button type="button" data-actab="${k}" class="${tab===k?'on':''}">${v}</button>`).join('')}</div>
    <div class="ac-body">${({overview:tabOverview, quotes:tabQuotes, invoices:tabInvoices, comms:tabComms}[tab]||tabOverview)()}</div>`;
    $('acBack').onclick = back;
    root().querySelectorAll('[data-actab]').forEach(b=> b.onclick = ()=> setTab(b.dataset.actab));
    $('acQuote').onclick = ()=> newQuote(null);
    $('acLog').onclick = ()=>{ composer = {kind:'note'}; setTab('comms'); };
    if($('acEmail')) $('acEmail').onclick = ()=>{
      location.href = `mailto:${encodeURIComponent(a.email)}?subject=${encodeURIComponent('Purgō')}`;
      composer = {kind:'email', direction:'out', to:a.email}; setTab('comms'); flash('Your email app is opening. Log what you sent below.');
    };
    const call = root().querySelector('[data-log-call]'); if(call) call.addEventListener('click', ()=> setTimeout(()=>{ composer = {kind:'call', direction:'out'}; setTab('comms'); }, 300));
    wire();
  }

  /* ---------- Overview: details, contacts, properties ---------- */
  function tabOverview(){
    const a = detail.acc, admin = ROLE==='admin';
    return `<div class="ac-grid">
      <section class="card">
        <h2>Details</h2>
        <div class="fields" style="margin-top:12px" id="acForm">
          <label class="f wide">Name<input data-af="name" value="${esc(a.name)}"></label>
          <label class="f">Type<select data-af="kind">${Object.entries(KINDS).map(([k,v])=>`<option value="${k}" ${a.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
          <label class="f">Status<select data-af="status">${Object.entries(STATUSES).map(([k,v])=>`<option value="${k}" ${a.status===k?'selected':''}>${v}</option>`).join('')}</select></label>
          <label class="f">Phone<input data-af="phone" inputmode="tel" value="${esc(a.phone||'')}"></label>
          <label class="f">Email<input data-af="email" type="email" autocapitalize="off" spellcheck="false" value="${esc(a.email||'')}"></label>
          <label class="f">Billing address<input data-af="billing_line" value="${esc(a.billing_line||'')}"></label>
          <label class="f">Postcode<input data-af="billing_postcode" value="${esc(a.billing_postcode||'')}"></label>
          <label class="f">How they found us<input data-af="source" value="${esc(a.source||'')}"></label>
          <label class="f">Squeegee ref<input data-af="squeegee_ref" value="${esc(a.squeegee_ref||'')}" placeholder="while we use both"></label>
          <label class="f wide">Tags<input data-af="tags" value="${esc((a.tags||[]).join(', '))}" placeholder="e.g. window round, monthly, VIP"></label>
          <label class="f wide">Notes<textarea data-af="notes" rows="3" placeholder="Gate code, parking, preferences…">${esc(a.notes||'')}</textarea></label>
        </div>
        <div class="vb-actions" style="margin-top:12px"><span class="hint" id="acSaved"></span><button class="btn pri" type="button" id="acSave" disabled>Save changes</button></div>
        ${detail.portfolio ? `<p class="hint" style="margin-top:10px">Portfolio: <b>${esc(detail.portfolio.name)}</b> <button class="btn sm" type="button" id="acPf">Open portfolio</button></p>` : ''}
        ${admin ? `<details class="ac-admin"><summary>Merge or delete</summary>
          <p class="hint">If the same customer has ended up with two accounts, merge this one into the other: its quotes, properties, contacts and communication all move across and this account is removed.</p>
          <div class="fields one"><label class="f">Merge into<input id="acMergeQ" placeholder="Search accounts"><div class="sugg" id="acMergeSugg" hidden></div></label></div>
          <p style="margin-top:10px"><button class="btn sm del" type="button" id="acDel">Delete account</button> <small class="hint">Quotes are kept, just unlinked.</small></p>
        </details>` : ''}
      </section>
      <div class="col">
        <section class="card">
          <div class="svc-head"><h2>Contacts</h2><button class="btn sm" type="button" id="acAddC">+ Add contact</button></div>
          <div class="qlist" style="margin-top:8px">${detail.contacts.length || editContact ? '' : '<p class="hint">Add people at this account: a partner, a tenant, a property manager or accounts team.</p>'}
          ${detail.contacts.map(c=> editContact===c.id ? contactForm(c) : `<div class="qitem ac-ci"><div class="m"><b>${esc(c.name)}${c.is_primary?' <span class="pill sent">Main</span>':''}</b><small>${esc([c.role, c.phone, c.email].filter(Boolean).join(' · '))}</small>${c.notes?`<small>${esc(c.notes)}</small>`:''}</div>
            <div class="qacts">${c.phone?`<a class="btn sm" href="tel:${esc(digits(c.phone))}">Call</a>`:''}${c.email?`<a class="btn sm" href="mailto:${esc(c.email)}">Email</a>`:''}<button class="btn sm" type="button" data-cedit="${c.id}">Edit</button></div></div>`).join('')}
          ${editContact==='new' ? contactForm({}) : ''}</div>
        </section>
        <section class="card">
          <div class="svc-head"><h2>Properties</h2><button class="btn sm" type="button" id="acAddP">+ Add property</button></div>
          <div class="qlist" style="margin-top:8px">
          ${detail.props.map(p=>`<div class="qitem"><div class="m"><b>${esc(p.line||'(no address)')}</b><small>${esc(p.postcode||'')}${p.last_quoted?' · last quoted '+fmtD(p.last_quoted):''}</small>${p.notes?`<small>${esc(p.notes)}</small>`:''}</div><div></div><div class="qacts"><button class="btn sm" type="button" data-pquote="${p.id}">Quote</button></div></div>`).join('') || '<p class="hint">Properties appear here when you quote for this customer, or add one.</p>'}
          <div class="fields" id="acPForm" style="margin-top:10px" hidden>
            <label class="f">Address<input id="apLine"></label><label class="f">Postcode<input id="apPc"></label>
            <label class="f wide">Access notes<input id="apNotes" placeholder="Gate code, parking, dog…"></label>
            <div class="vb-actions wide"><button class="btn sm" type="button" id="apCancel">Cancel</button><button class="btn sm pri" type="button" id="apSave">Save property</button></div>
          </div></div>
        </section>
      </div>
    </div>`;
  }
  function contactForm(c){
    return `<div class="fields ac-cform" style="padding:10px 0;border-bottom:1px solid var(--line)">
      <label class="f">Name<input id="ccName" value="${esc(c.name||'')}"></label>
      <label class="f">Role<input id="ccRole" value="${esc(c.role||'')}" placeholder="e.g. Tenant, Accounts"></label>
      <label class="f">Phone<input id="ccPhone" inputmode="tel" value="${esc(c.phone||'')}"></label>
      <label class="f">Email<input id="ccEmail" type="email" autocapitalize="off" spellcheck="false" value="${esc(c.email||'')}"></label>
      <label class="f wide">Notes<input id="ccNotes" value="${esc(c.notes||'')}"></label>
      <label class="ck wide"><input type="checkbox" id="ccPrim" ${c.is_primary?'checked':''}> Main contact</label>
      <div class="vb-actions wide">${c.id ? `<button class="btn sm del" type="button" id="ccDel">Remove</button>` : ''}<button class="btn sm" type="button" id="ccCancel">Cancel</button><button class="btn sm pri" type="button" id="ccSave">Save contact</button></div>
    </div>`;
  }

  /* ---------- Quotes ---------- */
  function tabQuotes(){
    const admin = ROLE==='admin';
    return `<section class="card"><div class="svc-head"><h2>Quotes</h2><button class="btn sm pri" type="button" data-pquote="">New quote</button></div>
      <div class="qlist" style="margin-top:8px">${detail.quotes.map(q=>{
        const qc = Array.isArray(q.quote_costs) ? q.quote_costs[0] : q.quote_costs;
        return `<div class="qitem"><div class="m"><b>${q.quote_no ? noLabel(q.quote_no) : esc(q.ref)}</b><small>${esc(q.address||'')}${q.postcode?' · '+esc(q.postcode):''}</small><small>${fmtD(q.created_at)} · ${esc(q.created_by_name||'')}${q.sent_at?' · sent '+fmtD(q.sent_at):''}</small></div>
          <span class="pill ${q.status}">${QST[q.status]||q.status}</span>
          <div class="v">${gbp(q.total||0)}${admin && qc ? `<small style="display:block;color:var(--muted);font-size:.72rem">${gbp(qc.profit)} · ${qc.margin}%</small>` : ''}</div>
          <div class="qacts"><button class="btn sm" type="button" data-openq="${q.id}">Open</button></div></div>`;
      }).join('') || '<p class="hint">No quotes for this account yet.</p>'}</div></section>`;
  }

  /* ---------- Invoices (next phase) ---------- */
  function tabInvoices(){
    const a = detail.acc;
    return `<section class="card"><h2>Invoices</h2>
      <p class="hint" style="margin-top:8px">Invoicing is the next part of the Portal. Until then invoices and payments stay in Squeegee${a.squeegee_ref ? ` (this customer is <b>${esc(a.squeegee_ref)}</b> there)` : ''}.</p>
      <p class="hint">When it's built, accepted quotes will turn into invoices here with one press, and each invoice will show whether it has been paid.</p>
      ${a.squeegee_ref ? '' : `<p class="hint">Tip: add their Squeegee customer reference on the Overview tab so the two are easy to match up while we switch over.</p>`}
    </section>`;
  }

  /* ---------- Communication timeline ---------- */
  function timeline(){
    const ev = detail.comms.map(c=>({at:c.occurred_at, type:'comm', c}));
    detail.quotes.forEach(q=>{
      const ref = q.quote_no ? noLabel(q.quote_no) : q.ref;
      ev.push({at:q.created_at, type:'quote', text:`Quote ${ref} created`, sub:`${gbp(q.total||0)} · ${q.created_by_name||''}`, id:q.id});
      if(q.sent_at) ev.push({at:q.sent_at, type:'quote', text:`Quote ${ref} sent`, sub:gbp(q.total||0), id:q.id});
      if(q.status==='accepted'||q.status==='declined') ev.push({at:q.updated_at, type:'quote', text:`Quote ${ref} ${q.status}`, sub:gbp(q.total||0), id:q.id, st:q.status});
    });
    return ev.sort((x,y)=>new Date(y.at)-new Date(x.at));
  }
  function tabComms(){
    const c = composer;
    const quoteOpts = detail.quotes.map(q=>`<option value="${q.id}">${q.quote_no ? noLabel(q.quote_no) : esc(q.ref)} · ${gbp(q.total||0)}</option>`).join('');
    const form = c ? `<section class="card ac-comp">
        <h2>Log contact</h2>
        <div class="seg" id="ccKind" style="margin-top:10px">${Object.entries(COMMS).map(([k,v])=>`<button type="button" data-v="${k}" class="${c.kind===k?'on':''}">${v}</button>`).join('')}</div>
        <div class="fields" style="margin-top:12px">
          ${c.kind!=='note' ? `<label class="f">Direction<select id="cmDir"><option value="out" ${c.direction!=='in'?'selected':''}>${c.kind==='visit'?'We visited':'We contacted them'}</option><option value="in" ${c.direction==='in'?'selected':''}>${c.kind==='visit'?'They came to us':'They contacted us'}</option></select></label>` : ''}
          <label class="f">When<input id="cmAt" type="datetime-local" value="${localDT(new Date())}"></label>
          ${quoteOpts ? `<label class="f">About quote<select id="cmQuote"><option value="">—</option>${quoteOpts}</select></label>` : ''}
          ${c.kind==='email' ? `<label class="f wide">Subject<input id="cmSubj"></label>` : ''}
          <label class="f wide">${c.kind==='note'?'Note':c.kind==='call'?'What was said':'Message'}<textarea id="cmBody" rows="4"></textarea></label>
        </div>
        <div class="vb-actions" style="margin-top:10px"><button class="btn" type="button" id="cmCancel">Cancel</button><button class="btn pri" type="button" id="cmSave">Save</button></div>
      </section>` : '';
    const ev = timeline();
    return `${form}
      <section class="card">
        <div class="svc-head"><h2>Communication</h2>${c ? '' : `<button class="btn sm pri" type="button" id="cmNew">Log contact</button>`}</div>
        <p class="hint" style="margin-top:6px">Every call, text, email, visit and note with this customer, with quote activity alongside. Emails will appear here automatically once the Purgō mailbox is connected.</p>
        <ol class="ac-tl">${ev.map(e=> e.type==='quote'
          ? `<li class="q ${e.st||''}"><i></i><div><b>${esc(e.text)}</b><small>${fmtDT(e.at)} · ${esc(e.sub)}</small></div><button class="btn sm" type="button" data-openq="${e.id}">Open</button></li>`
          : `<li class="${e.c.kind}"><i></i><div><b>${COMMS[e.c.kind]}${e.c.kind!=='note' && e.c.direction ? (e.c.direction==='in' ? ' from customer' : ' to customer') : ''}${e.c.subject?`: ${esc(e.c.subject)}`:''}</b>
              <small>${fmtDT(e.c.occurred_at)} · ${esc(e.c.created_by_name||'')}${e.c.to_addr?' · to '+esc(e.c.to_addr):''}${e.c.from_addr?' · from '+esc(e.c.from_addr):''}</small>
              ${e.c.body ? `<p>${esc(e.c.body).replace(/\n/g,'<br>')}</p>` : ''}</div>${ROLE==='admin' ? `<button class="btn sm del" type="button" data-cmdel="${e.c.id}">Delete</button>` : ''}</li>`).join('') || '<p class="hint">Nothing logged yet.</p>'}</ol>
      </section>`;
  }

  /* ---------- wiring ---------- */
  function wire(){
    const a = detail.acc;
    // details form
    const form = $('acForm');
    if(form){
      const mark = ()=>{ $('acSave').disabled = false; $('acSaved').textContent = 'Unsaved changes'; };
      form.querySelectorAll('[data-af]').forEach(el=> el.addEventListener('input', mark));
      $('acSave').onclick = async ()=>{
        const upd = {};
        form.querySelectorAll('[data-af]').forEach(el=>{ const k = el.dataset.af; let v = el.value.trim();
          if(k==='tags') v = v.split(',').map(x=>x.trim()).filter(Boolean);
          else if(k==='email') v = v.toLowerCase() || null;
          else if(k==='billing_postcode') v = fmtPc(v) || null;
          else if(k!=='name' && k!=='kind' && k!=='status') v = v || null;
          upd[k] = v; });
        if(!upd.name){ flash('The account needs a name'); return; }
        $('acSave').disabled = true;
        const {data, error} = await sb.from('accounts').update(upd).eq('id', a.id).select('*').single();
        if(error){ $('acSave').disabled = false; flash('Not saved: ' + (isNetErr(error)?'no connection':error.message)); return; }
        detail.acc = data; loaded = false; flash('Account saved'); renderDetail();
      };
    }
    if($('acPf')) $('acPf').onclick = ()=>{ try{ sessionStorage.setItem('pfCur', detail.portfolio.id); }catch(e){} if(typeof PORTFOLIO!=='undefined' && PORTFOLIO.open){ show('portfolio'); PORTFOLIO.open(detail.portfolio.id); } else show('portfolio'); };
    // admin: merge / delete
    if($('acMergeQ')){
      const box = $('acMergeSugg');
      const ensure = async ()=>{ if(!loaded){ try{ await loadList(); }catch(e){} } };
      $('acMergeQ').addEventListener('input', async e=>{
        await ensure(); const q = e.target.value.trim().toLowerCase();
        const hits = q ? list.filter(x=>x.id!==a.id && [x.name,x.email,x.phone,x.billing_postcode,accNo(x.account_no)].join(' ').toLowerCase().includes(q)).slice(0,8) : [];
        box.hidden = !hits.length;
        box.innerHTML = hits.map(x=>`<button type="button" data-merge="${x.id}"><b>${esc(x.name)}</b><small>${accNo(x.account_no)} · ${esc([x.phone,x.email,x.billing_postcode].filter(Boolean).join(' · '))}</small></button>`).join('');
        box.querySelectorAll('[data-merge]').forEach(b=> b.onclick = async ()=>{
          const t = list.find(x=>x.id===b.dataset.merge);
          if(!confirmInline('merge'+t.id, `Press ${t.name} again to move everything from ${a.name} into it. This can't be undone.`)) return;
          const {error} = await sb.rpc('merge_accounts', {p_from:a.id, p_into:t.id});
          if(error){ flash('Not merged: ' + error.message); return; }
          flash(`Merged into ${t.name}`); loaded = false; open(t.id);
        });
      });
      $('acDel').onclick = async ()=>{
        if(!confirmInline('acDel', `Press Delete account again to delete ${a.name}. Its quotes are kept.`)) return;
        const {error} = await sb.from('accounts').delete().eq('id', a.id);
        if(error){ flash('Not deleted: ' + error.message); return; }
        flash('Account deleted'); loaded = false; back();
      };
    }
    // contacts
    if($('acAddC')) $('acAddC').onclick = ()=>{ editContact = 'new'; renderDetail(); $('ccName').focus(); };
    root().querySelectorAll('[data-cedit]').forEach(b=> b.onclick = ()=>{ editContact = b.dataset.cedit; renderDetail(); });
    if($('ccCancel')) $('ccCancel').onclick = ()=>{ editContact = null; renderDetail(); };
    if($('ccSave')) $('ccSave').onclick = async ()=>{
      const rec = {account_id:a.id, name:$('ccName').value.trim(), role:$('ccRole').value.trim()||null, phone:$('ccPhone').value.trim()||null,
        email:$('ccEmail').value.trim().toLowerCase()||null, notes:$('ccNotes').value.trim()||null, is_primary:$('ccPrim').checked};
      if(!rec.name){ flash('Add the contact’s name'); return; }
      $('ccSave').disabled = true;
      if(rec.is_primary) await sb.from('account_contacts').update({is_primary:false}).eq('account_id', a.id).neq('id', editContact==='new' ? '00000000-0000-0000-0000-000000000000' : editContact);
      const r = editContact==='new' ? await sb.from('account_contacts').insert(rec) : await sb.from('account_contacts').update(rec).eq('id', editContact);
      if(r.error){ $('ccSave').disabled = false; flash('Not saved: ' + (isNetErr(r.error)?'no connection':r.error.message)); return; }
      editContact = null; await reload(); flash('Contact saved');
    };
    if($('ccDel')) $('ccDel').onclick = async ()=>{
      if(!confirmInline('ccDel', 'Press Remove again to remove this contact.')) return;
      const r = await sb.from('account_contacts').delete().eq('id', editContact);
      if(r.error){ flash('Not removed: ' + r.error.message); return; }
      editContact = null; await reload();
    };
    // properties
    if($('acAddP')) $('acAddP').onclick = ()=>{ $('acPForm').hidden = false; $('apLine').focus(); };
    if($('apCancel')) $('apCancel').onclick = ()=>{ $('acPForm').hidden = true; };
    if($('apSave')) $('apSave').onclick = async ()=>{
      const line = $('apLine').value.trim(), pc = fmtPc($('apPc').value);
      if(!line && !pc){ flash('Add an address or postcode'); return; }
      $('apSave').disabled = true;
      const {error} = await sb.from('addresses').upsert({key:slug(normPc(pc)+'-'+line), line, postcode:pc, customer:a.name, phone:a.phone, email:a.email, notes:$('apNotes').value.trim()||null, account_id:a.id}, {onConflict:'key'});
      if(error){ $('apSave').disabled = false; flash('Not saved: ' + (isNetErr(error)?'no connection':error.message)); return; }
      await reload(); flash('Property added');
    };
    root().querySelectorAll('[data-pquote]').forEach(b=> b.onclick = ()=> newQuote(detail.props.find(p=>p.id===b.dataset.pquote)||null));
    // communication
    if($('cmNew')) $('cmNew').onclick = ()=>{ composer = {kind:'note'}; renderDetail(); };
    root().querySelectorAll('#ccKind button').forEach(b=> b.onclick = ()=>{ const body = $('cmBody').value; composer = Object.assign({}, composer, {kind:b.dataset.v}); renderDetail(); $('cmBody').value = body; });
    if($('cmCancel')) $('cmCancel').onclick = ()=>{ composer = null; renderDetail(); };
    if($('cmBody')) $('cmBody').focus();
    if($('cmSave')) $('cmSave').onclick = async ()=>{
      const body = $('cmBody').value.trim(), subj = $('cmSubj') ? $('cmSubj').value.trim() : '';
      if(!body && !subj){ flash('Write something to log'); return; }
      const at = $('cmAt').value ? new Date($('cmAt').value) : new Date();
      const dir = $('cmDir') ? $('cmDir').value : null;
      const rec = {account_id:a.id, kind:composer.kind, direction:composer.kind==='note'?null:dir, subject:subj||null, body:body||null,
        quote_id:($('cmQuote')&&$('cmQuote').value)||null, occurred_at:at.toISOString(), created_by_name:ME.name,
        to_addr: composer.kind==='email' && dir==='out' ? (composer.to||a.email||null) : null,
        from_addr: composer.kind==='email' && dir==='in' ? (a.email||null) : null};
      $('cmSave').disabled = true;
      const {error} = await sb.from('account_comms').insert(rec);
      if(error){ $('cmSave').disabled = false; flash('Not saved: ' + (isNetErr(error)?'no connection':error.message)); return; }
      composer = null; await reload(); flash('Logged');
    };
    root().querySelectorAll('[data-cmdel]').forEach(b=> b.onclick = async ()=>{
      if(!confirmInline('cmdel'+b.dataset.cmdel, 'Press Delete again to remove this entry.')) return;
      const {error} = await sb.from('account_comms').delete().eq('id', b.dataset.cmdel);
      if(error){ flash('Not deleted: ' + error.message); return; }
      await reload();
    });
  }
  async function reload(){ try{ await loadDetail(cur); loaded = false; renderDetail(); }catch(e){ flash('Could not refresh: ' + (e.message||e)); } }

  /* ---------- start a quote for this account ---------- */
  function newQuote(prop){
    const a = detail.acc;
    $('newJob').click();
    const set = (id, v)=>{ const el = $(id); if(el && v!=null) el.value = v; };
    set('cust', a.name); set('phone', a.phone||''); set('email', a.email||'');
    set('addr', prop ? (prop.line||'') : (a.billing_line||'')); set('pc', prop ? (prop.postcode||'') : (a.billing_postcode||''));
    if(prop && prop.notes) set('jobNotes', prop.notes);
    const want = a.kind==='res' ? 'res' : 'com';
    const seg = document.querySelector(`#ctype button[data-v="${want}"]`); if(seg && !seg.classList.contains('on')) seg.click();
    if(typeof setQuoteAccount==='function') setQuoteAccount(a.id, a.name, a.account_no);
    ['pc','addr','cust'].forEach(id=> $(id) && $(id).dispatchEvent(new Event('input', {bubbles:true})));
    document.querySelectorAll('.sugg').forEach(s=>s.hidden = true);
    show('quote'); flash(`New quote for ${a.name}`);
  }

  async function onShow(){
    if(!navigator.onLine){ root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Accounts</h2></div></div><section class="card"><p class="note w">Accounts need a connection. They'll open when you're back online.</p></section>`; return; }
    let last = null; try{ last = sessionStorage.getItem('acCur'); }catch(e){}
    if(cur && detail){ renderDetail(); return; }
    if(last) return open(last);
    if(!loaded){ renderList(); await refreshList(); return; }
    renderList(); refreshList();
  }
  // pressing Accounts in the menu while on an account goes back to the list
  const navBtn = document.querySelector('.nav button[data-view="accounts"]');
  if(navBtn) navBtn.addEventListener('click', ()=>{
    if(!cur) return;
    if(!$('view-accounts').hidden){ back(); return; }
    cur = null; detail = null; try{ sessionStorage.removeItem('acCur'); }catch(e){}
  }, true);
  return {onShow, open, accNo, reset:()=>{ list = []; loaded = false; cur = null; detail = null; try{ sessionStorage.removeItem('acCur'); sessionStorage.removeItem('acTab'); }catch(e){} }};
})();
if(typeof ME!=='undefined' && ME && !document.getElementById('view-accounts').hidden) ACCOUNTS.onShow();
