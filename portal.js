/* =====================================================================
   Purgō customer portal: what a customer (e.g. a block manager) sees
   when they sign in. Read-only. Everything comes from the database
   function customer_portfolio(), which only returns what staff have
   chosen to share: job progress, ticked reports, photos and files, and
   the published quote. Staff can open the same view as a preview.
   Uses from purgo.js: $, esc, sb, ME, ROLE, show, flash, isNetErr
   ===================================================================== */
const PORTAL = (()=>{
  const BUCKET = 'portfolio-photos';
  const JOB = {'':['Not started yet','todo'], booked:['Booked','booked'], done:['Completed','done'], noaccess:["Couldn't access",'bad']};
  const COND = {light:'Light – routine debris', moderate:'Moderate – full in places', heavy:'Heavy – blocked / overflowing', veg:'Vegetation growing'};
  let list = null, P = null, tab = 'overview', siteId = null, previewOf = null, filter = null, q = '';
  const urls = {};
  const root = () => $('view-portal');
  const fmtD = v => { if(!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'}); };
  const js = s => (s.job && s.job.status) || '';
  const src = p => urls[p.path] || '';
  const rf = s => s.sub ? `${s.ref}.${s.sub}` : String(s.ref ?? '');   // subsections show as 9.1, 9.2 …

  async function onShow(){
    if(previewOf){ if(!P) return open(previewOf); return render(); }
    if(P) return render();
    root().innerHTML = `<section class="card"><p class="hint">Loading…</p></section>`;
    try{
      const {data, error} = await sb.rpc('customer_portfolios'); if(error) throw error;
      list = data || [];
    }catch(e){ root().innerHTML = `<section class="card"><p class="note b">${isNetErr(e) ? 'No connection. Check your internet and try again.' : 'Could not load your account: ' + esc(e.message||e)}</p><div style="margin-top:10px"><button class="btn" type="button" id="ptRetry">Try again</button></div></section>`; $('ptRetry').onclick = onShow; return; }
    if(list.length===1) return open(list[0].id);
    renderList();
  }
  function renderList(){
    P = null;
    root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Welcome${ME && ME.name ? ', ' + esc(ME.name.split(' ')[0]) : ''}</h2><p class="sub">Your work with Purgō</p></div></div>
      <section class="card">${list.length ? `<div class="qlist">${list.map(p=>`<div class="qitem pt-li" data-id="${p.id}"><div class="m"><b>${esc(p.name)}</b><small>${esc(p.client||'')}</small></div>${bar(p.done, p.total)}<button class="btn sm" type="button">Open</button></div>`).join('')}</div>` : '<p class="hint">Nothing has been shared with your login yet. Please contact Purgō on 07930 877034.</p>'}</section>
      ${pwBox()}`;
    root().querySelectorAll('.pt-li').forEach(r=> r.onclick = ()=> open(r.dataset.id));
    bindPw();
  }
  const bar = (done, total) => `<div class="pt-bar" title="${done} of ${total} completed"><i style="width:${total ? Math.round(done/total*100) : 0}%"></i><span>${done} of ${total} done</span></div>`;

  async function open(id){
    root().innerHTML = `<section class="card"><p class="hint">Loading…</p></section>`;
    try{
      const {data, error} = await sb.rpc('customer_portfolio', {pid:id}); if(error) throw error;
      if(!data){ throw new Error('Not found'); }
      P = data; P.sites = P.sites || []; P.files = P.files || [];
      const paths = [...P.files, ...P.sites.flatMap(s=>[...(s.photos||[]), ...(s.files||[])])].map(x=>x.path).filter(Boolean);
      for(let i=0;i<paths.length;i+=100){
        const {data:sd} = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i,i+100), 60*60*6);
        (sd||[]).forEach(r=>{ if(r.signedUrl) urls[r.path] = r.signedUrl; });
      }
      P.loadedAt = Date.now();
    }catch(e){ root().innerHTML = `<section class="card"><p class="note b">${isNetErr(e) ? 'No connection. Check your internet and try again.' : 'Could not open this: ' + esc(e.message||e)}</p></section>`; return; }
    if(!previewOf){ tab = 'overview'; siteId = null; }
    render();
  }

  function render(){
    if(!P) return renderList();
    if(Date.now() - P.loadedAt > 5*3600e3) return open(P.id);   // photo links last 6 hours
    const S = P.sites, n = k => S.filter(s=>js(s)===k).length;
    const done = n('done');
    const tabs = [['overview','Overview'],['sites','Properties'],...(P.quote?[['quote','Quote']]:[])];
    root().innerHTML = `
      ${previewOf ? `<div class="pt-preview pf-noprint"><b>Preview</b> – this is exactly what the customer sees. <button class="btn sm" type="button" id="ptBackStaff">← Back to the portfolio</button></div>` : ''}
      <div class="viewbar pf-noprint"><div>${!previewOf && list && list.length>1 ? `<p class="hint" style="margin:0"><a href="#" id="ptAll">← All</a></p>` : ''}<h2 class="vtitle">${esc(P.name)}</h2><p class="sub">${esc(P.client||'')} · ${S.length} properties</p></div>
        <div class="vb-actions"><div class="seg" id="ptTabs">${tabs.map(([k,l])=>`<button type="button" data-t="${k}" class="${tab===k?'on':''}">${l}</button>`).join('')}</div></div></div>
      <div id="ptBody"></div>`;
    const back = $('ptBackStaff'); if(back) back.onclick = ()=>{ previewOf = null; P = null; show('portfolio'); };
    const all = $('ptAll'); if(all) all.onclick = e=>{ e.preventDefault(); renderList(); };
    root().querySelectorAll('#ptTabs button').forEach(b=> b.onclick = ()=>{ tab = b.dataset.t; siteId = null; render(); window.scrollTo(0,0); });
    const box = $('ptBody');
    if(siteId) return renderSite(box);
    if(tab==='sites') return renderSites(box);
    if(tab==='quote' && P.quote) return renderQuote(box);
    renderOverview(box, done, n);
  }

  function renderOverview(box, done, n){
    const S = P.sites, pct = S.length ? Math.round(done/S.length*100) : 0;
    const recent = S.filter(s=>js(s)==='done').sort((a,b)=>String(b.job.done||'').localeCompare(String(a.job.done||''))).slice(0,6);
    const next = S.filter(s=>js(s)==='booked').sort((a,b)=>String(a.job.booked||'9').localeCompare(String(b.job.booked||'9'))).slice(0,6);
    const issues = S.filter(s=>s.report && s.report.issues);
    box.innerHTML = `
      <section class="card pt-hero"><div class="pt-ring" style="--p:${pct}"><b>${pct}%</b><span>complete</span></div>
        <div class="pt-counts">
          <div><b>${done}</b><span>Completed</span></div><div><b>${n('booked')}</b><span>Booked</span></div>
          <div><b>${n('')}</b><span>Not started</span></div>${n('noaccess')?`<div class="bad"><b>${n('noaccess')}</b><span>Couldn't access</span></div>`:''}
        </div></section>
      <div class="pt-grid">
        <section class="card"><h3 style="margin-top:0">Recently completed</h3>${recent.length ? recent.map(siteLine).join('') : '<p class="hint">Nothing completed yet.</p>'}</section>
        <section class="card"><h3 style="margin-top:0">Coming up</h3>${next.length ? next.map(siteLine).join('') : '<p class="hint">No visits booked at the moment.</p>'}</section>
        ${n('noaccess') ? `<section class="card"><h3 style="margin-top:0">Couldn't access</h3>${S.filter(s=>js(s)==='noaccess').map(siteLine).join('')}<p class="hint">We'll be in touch to arrange access for these.</p></section>` : ''}
        ${issues.length ? `<section class="card"><h3 style="margin-top:0">Defects reported</h3>${issues.map(s=>`<a href="#" class="pt-line" data-site="${s.id}"><b>${esc(rf(s))}. ${esc(s.name||s.address)}</b><small>${esc(s.report.issues.slice(0,120))}${s.report.issues.length>120?'…':''}</small></a>`).join('')}</section>` : ''}
        ${P.files.length ? `<section class="card"><h3 style="margin-top:0">Documents</h3>${P.files.map(fileLink).join('')}</section>` : ''}
      </div>
      ${previewOf ? '' : pwBox()}`;
    bindLines(box); bindPw();
  }
  function siteLine(s){
    const j = s.job || {}, st = JOB[js(s)] || JOB[''];
    const when = js(s)==='done' ? fmtD(j.done) : js(s)==='booked' ? (j.booked ? fmtD(j.booked) : 'Date to be confirmed') : js(s)==='noaccess' ? (j.reason||'') : '';
    return `<a href="#" class="pt-line" data-site="${s.id}"><b>${esc(rf(s))}. ${esc(s.name||s.address)}</b><small><span class="pt-st ${st[1]}">${st[0]}</span>${when?' '+esc(when):''}${s.photos&&s.photos.length?` · ${s.photos.length} photo${s.photos.length>1?'s':''}`:''}</small></a>`;
  }
  const fileLink = f => `<a class="pt-file" href="${esc(src(f))}" target="_blank" rel="noopener"><span class="pf-fi">${/\.pdf$/i.test(f.path||'')?'PDF':'IMG'}</span><b>${esc(f.name||'Document')}</b><small>${fmtD(f.added)}</small></a>`;
  function bindLines(box){ box.querySelectorAll('[data-site]').forEach(a=> a.onclick = e=>{ e.preventDefault(); siteId = a.dataset.site; tab = 'sites'; render(); window.scrollTo(0,0); }); }

  function renderSites(box){
    const rows = P.sites.filter(s=>(filter===null || js(s)===filter) && (!q || [s.name,s.address,s.postcode].join(' ').toLowerCase().includes(q.toLowerCase())));
    box.innerHTML = `<section class="card">
      <div class="pf-tools"><input type="search" id="ptQ" placeholder="Search name, address, postcode…" value="${esc(q)}">
        <select id="ptF"><option value="">All</option>${Object.entries(JOB).map(([k,v])=>`<option value="k:${k}" ${filter===k?'selected':''}>${v[0]} (${P.sites.filter(s=>js(s)===k).length})</option>`).join('')}</select></div>
      <div class="pf-tbl"><table class="pt-tbl"><thead><tr><th>#</th><th>Property</th><th>Status</th><th>Date</th><th class="r">Photos</th><th>Report</th></tr></thead>
      <tbody>${rows.map(s=>{ const st = JOB[js(s)]||JOB[''], j = s.job||{}; return `<tr data-site="${s.id}"><td>${esc(rf(s))}</td><td><b>${esc(s.name||s.address)}</b><small>${s.name?esc(s.address)+', ':''}${esc(s.postcode||'')}</small></td><td><span class="pt-st ${st[1]}">${st[0]}</span></td><td>${js(s)==='done'?fmtD(j.done):js(s)==='booked'?(fmtD(j.booked)||'TBC'):''}</td><td class="r">${(s.photos||[]).length||''}</td><td>${s.report?'✓':''}${(s.files||[]).length?` <small>${s.files.length} file${s.files.length>1?'s':''}</small>`:''}</td></tr>`; }).join('') || '<tr><td colspan="6"><small>No properties match.</small></td></tr>'}</tbody></table></div></section>`;
    $('ptQ').oninput = e=>{ q = e.target.value; const p = e.target.selectionStart; renderSites(box); const el = $('ptQ'); el.focus(); el.setSelectionRange(p,p); };
    $('ptF').onchange = e=>{ filter = e.target.value ? e.target.value.slice(2) : null; renderSites(box); };
    box.querySelectorAll('tr[data-site]').forEach(r=> r.onclick = ()=>{ siteId = r.dataset.site; render(); window.scrollTo(0,0); });
  }

  function renderSite(box){
    const S = P.sites, i = S.findIndex(x=>x.id===siteId), s = S[i];
    if(!s){ siteId = null; return render(); }
    const j = s.job || {}, st = JOB[js(s)] || JOB[''], r = s.report, ph = s.photos || [];
    const grp = k => ph.filter(p=>(p.stage||'after')===k);
    const gal = (title, a) => a.length ? `<h4 class="pf-h4">${title}</h4><div class="pt-gal">${a.map(p=>`<figure><img src="${esc(src(p))}" data-full="${esc(p.path)}" alt="${esc(p.caption||title)}" loading="lazy">${p.caption?`<figcaption>${esc(p.caption)}</figcaption>`:''}</figure>`).join('')}</div>` : '';
    box.innerHTML = `
      <div class="pf-head pf-noprint"><p class="hint" style="margin:0;flex:1"><a href="#" id="ptBack">← All properties</a></p>
        <div class="pf-pager"><button class="btn" type="button" id="ptPrev" ${i>0?'':'disabled'}>← Prev</button><button class="btn" type="button" id="ptNext" ${i<S.length-1?'':'disabled'}>Next →</button></div></div>
      <section class="card">
        <p class="hint" style="margin:0">PROPERTY ${esc(rf(s))}${s.group?' · PART OF '+esc(s.group).toUpperCase():''}</p><h2 class="vtitle" style="font-size:1.35rem">${esc(s.name||s.address)}</h2><p class="sub">${s.name?esc(s.address)+', ':''}${esc(s.postcode||'')}</p>
        <div class="pt-status"><span class="pt-st big ${st[1]}">${st[0]}</span>
          ${js(s)==='done'&&j.done?`<span>Completed ${fmtD(j.done)}</span>`:''}${js(s)==='booked'?`<span>${j.booked?'Booked for '+fmtD(j.booked):'Date to be confirmed'}</span>`:''}${js(s)==='noaccess'&&j.reason?`<span>${esc(j.reason)}</span>`:''}</div>
      </section>
      ${r ? `<section class="card"><h3 style="margin-top:0">Job report</h3>
        ${r.work?`<div class="pt-rep"><span>Work carried out</span><p>${esc(r.work)}</p></div>`:''}
        ${r.condition?`<div class="pt-rep"><span>Gutter condition found</span><p>${esc(COND[r.condition]||r.condition)}</p></div>`:''}
        <div class="pt-rep"><span>Defects / issues found</span><p>${r.issues?esc(r.issues):'None found.'}</p></div>
        ${r.recommend?`<div class="pt-rep"><span>Recommendations</span><p>${esc(r.recommend)}</p></div>`:''}
      </section>` : ''}
      ${ph.length ? `<section class="card"><h3 style="margin-top:0">Photos</h3>${gal('Before', grp('before'))}${gal('After', grp('after'))}</section>` : ''}
      ${(s.files||[]).length ? `<section class="card"><h3 style="margin-top:0">Reports &amp; documents</h3>${s.files.map(fileLink).join('')}</section>` : ''}
      ${!r && !ph.length && !(s.files||[]).length ? `<section class="card"><p class="hint">${js(s)==='done' ? 'The report and photos for this property will appear here shortly.' : 'Photos and a report will appear here once the work is done.'}</p></section>` : ''}
      <div class="pf-lb" id="ptLb" hidden><img alt=""></div>`;
    $('ptBack').onclick = e=>{ e.preventDefault(); siteId = null; tab = 'sites'; render(); };
    $('ptPrev').onclick = ()=>{ siteId = S[i-1].id; render(); window.scrollTo(0,0); };
    $('ptNext').onclick = ()=>{ siteId = S[i+1].id; render(); window.scrollTo(0,0); };
    box.querySelectorAll('[data-full]').forEach(img=> img.onclick = ()=>{ const lb = $('ptLb'); lb.querySelector('img').src = img.src; lb.hidden = false; });
    $('ptLb').onclick = ()=> $('ptLb').hidden = true;
  }

  function renderQuote(box){
    box.innerHTML = `<section class="card pf-noprint"><div class="pf-tools"><span class="hint" style="flex:1;margin:0">Shared with you on ${fmtD(P.quote.publishedAt)}.</span><button class="btn pri" type="button" id="ptPrint">Print / save PDF</button></div></section>
      <div class="pf-qdoc">${P.quote.html||''}</div>`;
    $('ptPrint').onclick = ()=>{ document.body.classList.add('pf-printing'); setTimeout(()=>{ window.print(); setTimeout(()=>document.body.classList.remove('pf-printing'), 500); }, 50); };
  }

  function pwBox(){
    if(previewOf) return '';
    return `<section class="card pf-noprint pt-pw"><details><summary>Change my password</summary>
      <form id="ptPwForm" style="margin-top:10px"><div class="fields"><label class="f">New password<input type="password" id="ptPw1" minlength="8" autocomplete="new-password" required></label><label class="f">Type it again<input type="password" id="ptPw2" minlength="8" autocomplete="new-password" required></label></div>
      <div style="margin-top:10px"><button class="btn pri" type="submit">Save password</button></div></form></details></section>`;
  }
  function bindPw(){
    const f = $('ptPwForm'); if(!f) return;
    f.onsubmit = async e=>{
      e.preventDefault();
      const a = $('ptPw1').value, b = $('ptPw2').value;
      if(a.length<8){ flash('Use at least 8 characters'); return; }
      if(a!==b){ flash('The two passwords are different'); return; }
      const {error} = await sb.auth.updateUser({password:a});
      if(error){ flash('Not saved: ' + error.message); return; }
      $('ptPw1').value = ''; $('ptPw2').value = ''; flash('Password saved');
    };
  }

  function preview(id){ previewOf = id; P = null; tab = 'overview'; siteId = null; show('portal'); }
  return {onShow, preview, reset:()=>{ list = null; P = null; previewOf = null; siteId = null; tab = 'overview'; filter = null; q = ''; }, isPreview:()=>!!previewOf};
})();
if(typeof ME!=='undefined' && ME && !document.getElementById('view-portal').hidden) PORTAL.onShow();
