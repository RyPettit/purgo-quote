/* =====================================================================
   Purgō Portfolios: one quote covering many properties for one client
   (e.g. a block management company). Survey each property (live Google
   satellite + Street View, saved images with a review tick, site photos),
   price it from the shared price list, and produce one customer quote.
   Uses from purgo.js: $, esc, gbp, sb, ME, ROLE, R, show, flash, VIEWS, CFG, isNetErr
   Uses from measure.js: MEASURE.loadGoogle, MEASURE.openFor
   ===================================================================== */
const PORTFOLIO = (()=>{
  const BUCKET = 'portfolio-photos';
  const TYPES = ['Purpose-built flats (low rise)','Purpose-built flats (mid/high rise)','Converted house – flats','Terraced block','Semi-detached block','Townhouses / mews','Bungalow block','Mixed use (retail below)','Commercial / communal building','Other'];
  const GUTTER_TYPES = ['uPVC half-round','uPVC square/ogee','Cast iron','Aluminium','Box / parapet gutter','Valley gutter','Mixed / unknown'];
  const METHODS = ['SkyVac from ground','SkyVac + tower','Tower + hand clean','MEWP / cherry picker','Ladder (single storey only)','TBC – site visit'];
  const CONDITIONS = [['light','Light – routine debris'],['moderate','Moderate – full in places'],['heavy','Heavy – blocked / overflowing'],['veg','Vegetation growing'],['unknown','Unknown']];
  const STATUSES = [['todo','To review','#9AAFBE'],['desk','Desk survey done','#6DA7C4'],['visit','Site visit needed','#C98A12'],['ready','Ready to quote','#2E8B57'],['noquote','Exclude / no quote','#B6453B']];
  // access items: label, and the price-list hours key (charged hours × crew × labour) where one applies
  const ACCESS = [
    ['mewp','Over 12 m / 4+ storeys – MEWP needed',null],
    ['tower','Tower needed (no ground reach)','tower'],
    ['parking','Restricted parking / permit needed','cx_parking'],
    ['gated','Gated / fob / key-holder access',null],
    ['rear','Rear access only via residents / garden',null],
    ['narrow','Narrow passage / steps for kit','cx_narrow'],
    ['conservatory','Conservatory / extension below gutter','cx_gtCons'],
    ['flatroof','Flat roof / canopy below gutter','cx_gtCons'],
    ['cars','Cars parked under gutters','cx_move'],
    ['cables','Overhead cables / obstructions',null],
    ['ground','Uneven / sloping / soft ground','cx_steps'],
    ['trees','Overhanging trees',null],
    ['water','No outside tap (downpipe flushing)','cx_water'],
    ['hours','Restricted working hours',null]
  ];
  const JOB_ST = [['','Not started','#9AAFBE'],['booked','Booked','#6DA7C4'],['done','Completed','#2E8B57'],['noaccess',"Couldn't access",'#B6453B'],['na','Not in this job','#C9D3DA']];
  const WORK_DEFAULT = 'All gutters cleared of moss, leaves and debris. Outlets and downpipes checked and flushed. Waste bagged and removed from site.';
  const FREQ = {once:['One-off clean',1],annual:['Annual (1 visit / year)',1],biannual:['Twice yearly (spring & autumn)',2],quarterly:['Quarterly (4 visits / year)',4]};
  const DEF_SET = {quoteRef:'', freq:'once', crew:2, discPct:10, discMin:20, vat:true, rams:true, mewpDay:0, showPhotos:true, showAccess:true, onlyReviewed:false, intro:'', validDays:30, condHeavy:true};

  let list = [], cur = null, sites = {}, tab = 'summary', siteId = null, loaded = false;
  let sortKey = 'ref', sortDir = 1, filterStatus = '', search = '', armed = 'site';
  const urls = {}; let urlsAt = 0;
  const pending = {}, chains = {};
  const root = () => $('view-portfolio');
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const fmtD = v => { if(!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}); };
  const gbp0 = n => '£' + Math.round(n).toLocaleString('en-GB');
  const S = () => Object.assign({}, DEF_SET, (cur && cur.settings) || {});

  /* ---------- model ---------- */
  function siteData(s){
    const d = s.data = s.data || {};
    d.len = Object.assign({front:'',rear:'',left:'',right:'',other:''}, d.len||{});
    d.access = d.access || {};
    if(d.flush===undefined) d.flush = true;
    if(d.include===undefined) d.include = true;
    d.status = d.status || 'todo'; d.condition = d.condition || 'unknown';
    s.photos = s.photos || {}; s.photos.site = Array.isArray(s.photos.site) ? s.photos.site : [];
    s.photos.job = Array.isArray(s.photos.job) ? s.photos.job : []; s.photos.files = Array.isArray(s.photos.files) ? s.photos.files : [];
    d.job = Object.assign({status:'', booked:'', done:'', reason:'', shareReport:false}, d.job||{});
    d.job.report = Object.assign({work:'', condition:'', issues:'', recommend:''}, d.job.report||{});
    return d;
  }
  const totalLen = d => ['front','rear','left','right','other'].reduce((a,k)=>a+num(d.len&&d.len[k]),0);
  const sorted = () => Object.values(sites).sort((a,b)=>num(a.ref)-num(b.ref) || String(a.name||a.address).localeCompare(b.name||b.address));
  const imgs = s => [s.photos.aerial, s.photos.street, ...(s.photos.site||[])].filter(Boolean);
  const allFiles = s => [...imgs(s), ...(s.photos.job||[]), ...(s.photos.files||[])];
  const jobOf = k => JOB_ST.find(x=>x[0]===(k||'')) || JOB_ST[0];
  const inJob = s => s.data.include!==false && s.data.status!=='noquote' && (s.data.job&&s.data.job.status)!=='na';
  const imgStats = s => { const a = imgs(s); return {total:a.length, done:a.filter(x=>x.reviewed).length}; };

  function calc(s){
    const d = siteData(s), st = S(), L = R.labour, crew = Math.max(1, Math.round(num(st.crew))||2);
    const m = totalLen(d), storeys = num(d.storeys);
    const rate = storeys>=3 ? R.gutRate3 : R.gutRate;
    const lines = []; let hrs = 0;
    const add = (label, amt, detail) => { if(amt) lines.push([label, amt, detail||'']); };
    if(m>0){
      const base = m*rate;
      add(`Gutter survey & clear (${m.toFixed(0)} m, ${storeys>=4?'4+':storeys||'?'} storey)`, Math.max(base, R.gutMin), base<R.gutMin ? `Minimum gutter charge (${m.toFixed(0)} m × ${gbp(rate)} = ${gbp(base)})` : `${m.toFixed(0)} m × ${gbp(rate)}`);
      add('Set-up & pack-down', R.gutSetup*crew*L, `${R.gutSetup}h × ${crew} × ${gbp(L)}`);
      hrs += R.gutSetup + m/(storeys>=3 ? R.gutSpeed3 : R.gutSpeed);
    }
    const dp = num(d.downpipes);
    if(m>0 && d.flush && dp){ const h = dp*0.05; add(`Flush & check downpipes × ${dp}`, h*crew*L, `${h.toFixed(2)}h × ${crew} × ${gbp(L)}`); hrs += h; }
    const gq = num(d.guards); if(gq){ add(`Downpipe guards × ${gq}`, gq*R.guard, `${gq} × ${gbp(R.guard)}`); hrs += gq*0.05; }
    const fm = num(d.fascia); if(fm){ add(`Fascia & soffit clean (${fm} m)`, fm*R.fascia, `${fm} m × ${gbp(R.fascia)}`); hrs += fm/R.fasSpeed; }
    if(m>0 && st.condHeavy!==false && (d.condition==='heavy' || d.condition==='veg')){ add('Heavy blockage / plant growth', R.cx_gtHeavy*crew*L, `${R.cx_gtHeavy}h × ${crew} × ${gbp(L)}`); hrs += R.cx_gtHeavy; }
    const usedKeys = {};
    ACCESS.forEach(([k,label,key])=>{
      if(!d.access[k] || !key || m<=0) return;
      if(key==='tower'){ const h = (R.towerErect+R.towerDismantle); add('Scaffold tower', R.towerDay + h*crew*L, `${gbp(R.towerDay)} hire + ${h}h erect & dismantle × ${crew}`); hrs += h; return; }
      if(usedKeys[key]) return; usedKeys[key] = 1;
      const h = num(R[key]); if(h){ add(label.split(' –')[0].split(' (')[0], h*crew*L, `${h}h × ${crew} × ${gbp(L)}`); hrs += h; }
    });
    if(d.access.mewp && num(st.mewpDay)) add('MEWP / cherry picker hire', num(st.mewpDay), 'per site');
    const adj = num(d.adjust); if(adj) add(d.adjustReason ? `Adjustment – ${d.adjustReason}` : (adj<0?'Discount':'Adjustment'), adj);
    const price = Math.max(0, lines.reduce((a,l)=>a+l[1],0));
    return {m, rate, lines, price: m>0 ? Math.round(price*100)/100 : 0, hrs: m>0 ? hrs : 0, needsVisit: storeys>=4 || d.access.mewp};
  }
  function issues(s){
    const d = siteData(s), a = [];
    if(!d.type) a.push('type'); if(!num(d.storeys)) a.push('storeys'); if(!totalLen(d)) a.push('gutter length'); if(!d.method) a.push('method');
    if(!s.photos.aerial) a.push('aerial'); if(!s.photos.street) a.push('street view');
    const r = imgStats(s); if(r.total>r.done) a.push(`${r.total-r.done} to review`);
    return a;
  }
  function portfolioTotals(){
    const st = S(), all = sorted();
    const inc = all.filter(s=>siteData(s).include!==false && s.data.status!=='noquote');
    let sub = 0, m = 0, hrs = 0;
    const priced = inc.filter(s=>{ const c = calc(s); sub += c.price; m += c.m; hrs += c.hrs; return c.price>0; });
    const rams = st.rams && priced.length ? R.rams : 0;
    const disc = priced.length>=num(st.discMin) ? sub*num(st.discPct)/100 : 0;
    const net = sub - disc + rams;
    const vat = st.vat ? net*R.vat/100 : 0;
    const visits = (FREQ[st.freq]||FREQ.once)[1];
    return {all, inc, priced, sub, disc, rams, net, vat, gross:net+vat, m, hrs, visits, annual:(net+vat)*visits};
  }

  /* ---------- database ---------- */
  async function loadList(){
    const {data, error} = await sb.from('portfolios').select('id,name,client,contact,email,status,settings,files,customer_quote,updated_at,created_by_name,portfolio_sites(count)').order('updated_at', {ascending:false});
    if(error) throw error;
    list = data || []; loaded = true;
  }
  async function openPortfolio(id){
    const p = list.find(x=>x.id===id); if(!p) return;
    MV.view = null; MV.plan = null;
    root().innerHTML = `<div class="card"><p class="hint">Loading ${esc(p.name)}…</p></div>`;
    const {data, error} = await sb.from('portfolio_sites').select('*').eq('portfolio_id', id).order('ref');
    if(error){ flash('Could not load: ' + error.message); return; }
    cur = p; sites = {}; (data||[]).forEach(s=>{ siteData(s); sites[s.id] = s; });
    try{ sessionStorage.setItem('pfCur', id); }catch(e){}
    await signAll();
    tab = 'summary'; siteId = null; render();
  }
  async function signAll(force){
    const paths = [];
    Object.values(sites).forEach(s=>allFiles(s).forEach(i=>{ if(i.path && (force || !urls[i.path])) paths.push(i.path); }));
    (cur && Array.isArray(cur.files) ? cur.files : []).forEach(i=>{ if(i.path && (force || !urls[i.path])) paths.push(i.path); });
    urlsAt = Date.now();
    if(!paths.length) return;
    for(let i=0;i<paths.length;i+=100){
      const {data, error} = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i,i+100), 60*60*6);
      if(error){ console.warn(error); continue; }
      (data||[]).forEach(r=>{ if(r.signedUrl) urls[r.path] = r.signedUrl; });
    }
    urlsAt = Date.now();
  }
  const src = i => i && i.path ? (urls[i.path] || '') : '';
  function saveStatus(t){ const e = $('pfSave'); if(e) e.textContent = t; }
  function queue(key, fn, delay=700){
    clearTimeout(pending[key]); saveStatus('Unsaved…');
    pending[key] = setTimeout(()=>{ delete pending[key]; chains[key] = (chains[key]||Promise.resolve()).then(fn).then(()=>{ if(!Object.keys(pending).length) saveStatus('All changes saved'); }).catch(e=>{ console.error(e); saveStatus('Not saved'); flash(isNetErr(e) ? 'No connection – changes will save when you are back online. Keep this page open.' : 'Could not save: ' + (e.message||e)); if(isNetErr(e)) setTimeout(()=>queue(key, fn, 0), 5000); }); }, delay);
  }
  function saveSite(s, delay){
    queue('s:'+s.id, async ()=>{
      const row = {ref:s.ref, name:s.name, address:s.address, postcode:s.postcode, lat:s.lat, lng:s.lng, data:s.data, photos:s.photos, updated_by:ME.id, updated_by_name:ME.name};
      const {error} = await sb.from('portfolio_sites').update(row).eq('id', s.id); if(error) throw error;
    }, delay);
  }
  function savePortfolio(delay){
    queue('p:'+cur.id, async ()=>{
      const {error} = await sb.from('portfolios').update({name:cur.name, client:cur.client, contact:cur.contact, email:cur.email, status:cur.status, settings:cur.settings}).eq('id', cur.id); if(error) throw error;
    }, delay);
  }

  /* ---------- rendering: list ---------- */
  async function onShow(){
    if(!navigator.onLine){ root().innerHTML = `<div class="viewbar"><div><h2 class="vtitle">Portfolios</h2></div></div><section class="card"><p class="note w">Portfolios need a connection. They'll open when you're back online.</p></section>`; return; }
    if(cur){ render(); return; }
    root().innerHTML = `<section class="card"><p class="hint">Loading portfolios…</p></section>`;
    try{ await loadList(); }catch(e){ root().innerHTML = `<section class="card"><p class="note b">Could not load portfolios: ${esc(e.message||e)}</p></section>`; return; }
    let last = null; try{ last = sessionStorage.getItem('pfCur'); }catch(e){}
    if(last && list.some(p=>p.id===last)) return openPortfolio(last);
    renderList();
  }
  function renderList(){
    cur = null; sites = {};
    root().innerHTML = `
    <div class="viewbar"><div><h2 class="vtitle">Portfolios</h2><p class="sub">One quote for many properties – block managers, letting agents, housing associations.</p></div>
      <div class="vb-actions"><button class="btn pri" type="button" id="pfNew">New portfolio</button></div></div>
    <section class="card" id="pfNewBox" hidden>
      <h2>New portfolio</h2>
      <div class="fields" style="margin-top:12px">
        <label class="f wide">Name<input id="pfNewName" placeholder="e.g. Pure Block – gutter cleans"></label>
        <label class="f wide">Client<input id="pfNewClient" placeholder="e.g. Pure Block Management"></label>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px"><button class="btn pri" type="button" id="pfCreate">Create</button><button class="btn" type="button" id="pfCancel">Cancel</button></div>
    </section>
    <section class="card"><div class="qlist">${list.length ? list.map(p=>`
      <div class="qitem pf-li" data-id="${p.id}"><div class="m"><b>${esc(p.name)}</b><small>${esc(p.client||'')} · ${(p.portfolio_sites&&p.portfolio_sites[0]&&p.portfolio_sites[0].count)||0} properties · updated ${new Date(p.updated_at).toLocaleDateString('en-GB')}</small></div><span class="pill ${esc(p.status)}">${esc(p.status)}</span><button class="btn sm" type="button">Open</button></div>`).join('') : '<p class="hint">No portfolios yet.</p>'}</div></section>`;
    $('pfNew').onclick = ()=>{ $('pfNewBox').hidden = false; $('pfNewName').focus(); };
    $('pfCancel').onclick = ()=>{ $('pfNewBox').hidden = true; };
    $('pfCreate').onclick = async ()=>{
      const name = $('pfNewName').value.trim(); if(!name){ flash('Give the portfolio a name'); return; }
      const ref = 'PF-' + new Date().getFullYear() + '-' + String(list.length+1).padStart(3,'0');
      const {data, error} = await sb.from('portfolios').insert({name, client:$('pfNewClient').value.trim(), created_by_name:ME.name, settings:Object.assign({}, DEF_SET, {quoteRef:ref})}).select('id,name,client,contact,email,status,settings,files,customer_quote,updated_at,created_by_name').single();
      if(error){ flash('Could not create: ' + error.message); return; }
      data.portfolio_sites = [{count:0}]; list.unshift(data); await openPortfolio(data.id); tab = 'settings'; render();
    };
    root().querySelectorAll('.pf-li').forEach(r=> r.onclick = ()=> openPortfolio(r.dataset.id));
  }

  /* ---------- rendering: portfolio ---------- */
  function render(){
    if(!cur) return renderList();
    if(urlsAt && Date.now()-urlsAt > 5*3600e3){ urlsAt = Date.now(); signAll(true).then(()=>render()); }
    const P = portfolioTotals();
    root().innerHTML = `
    <div class="viewbar pf-noprint"><div><p class="hint" style="margin:0"><a href="#" id="pfBack">← All portfolios</a></p><h2 class="vtitle">${esc(cur.name)}</h2><p class="sub">${esc(cur.client||'')} · ${P.all.length} properties · <span id="pfSave">All changes saved</span></p></div>
      <div class="vb-actions"><div class="seg" id="pfTabs">${[['summary','Summary'],['site','Properties'],['map','Map & routes'],['quote','Customer quote'],['customer','Customer access'],['settings','Settings & import']].map(([k,l])=>`<button type="button" data-t="${k}" class="${tab===k?'on':''}">${l}</button>`).join('')}</div></div></div>
    <div id="pfBody"></div>`;
    $('pfBack').onclick = e=>{ e.preventDefault(); try{ sessionStorage.removeItem('pfCur'); }catch(x){} loadList().then(renderList); };
    root().querySelectorAll('#pfTabs button').forEach(b=> b.onclick = ()=>{ tab = b.dataset.t; render(); window.scrollTo(0,0); });
    ({summary:renderSummary, site:renderSite, map:renderMap, quote:renderQuote, customer:renderCustomer, settings:renderSettings}[tab]||renderSummary)($('pfBody'), P);
  }
  const statusOf = k => STATUSES.find(s=>s[0]===k) || STATUSES[0];
  const opt = (arr, val, ph) => `<option value="">${ph||'Select…'}</option>` + arr.map(o=>{ const [v,l] = Array.isArray(o)?o:[o,o]; return `<option value="${esc(v)}" ${String(val)===String(v)?'selected':''}>${esc(l)}</option>`; }).join('');

  function renderSummary(box, P){
    const all = P.all;
    if(!all.length){ box.innerHTML = `<section class="card"><h2>No properties yet</h2><p class="hint">Paste the addresses under Settings & import.</p><div style="margin-top:10px"><button class="btn pri" type="button" id="pfGoImp">Import addresses</button></div></section>`; $('pfGoImp').onclick = ()=>{ tab='settings'; render(); }; return; }
    const counts = {}; STATUSES.forEach(s=>counts[s[0]]=0); all.forEach(s=>counts[s.data.status]=(counts[s.data.status]||0)+1);
    const rev = all.reduce((a,s)=>{ const r = imgStats(s); a.d += r.done; a.t += r.total; return a; }, {d:0,t:0});
    let rows = all.filter(s=>(!filterStatus || s.data.status===filterStatus) && (!search || [s.name,s.address,s.postcode,s.data.type,s.data.notes].join(' ').toLowerCase().includes(search.toLowerCase())));
    const key = {ref:s=>num(s.ref), name:s=>(s.name||s.address||'').toLowerCase(), type:s=>s.data.type||'', storeys:s=>num(s.data.storeys), len:s=>totalLen(s.data), status:s=>STATUSES.findIndex(x=>x[0]===s.data.status), job:s=>JOB_ST.findIndex(x=>x[0]===s.data.job.status)+(s.data.job.done||s.data.job.booked||''), price:s=>calc(s).price, hrs:s=>calc(s).hrs};
    if(key[sortKey]) rows.sort((a,b)=>{ const x = key[sortKey](a), y = key[sortKey](b); return (x>y?1:x<y?-1:0)*sortDir; });
    const th = (k,l,c='') => `<th class="${c}" ${k?`data-sort="${k}"`:''}>${l}${sortKey===k?(sortDir>0?' ▲':' ▼'):''}</th>`;
    box.innerHTML = `
    <div class="pf-stats">
      <div class="stat"><span>Properties</span><b>${all.length} <small>${P.inc.length} in quote</small></b></div>
      <div class="stat"><span>Ready to quote</span><b>${counts.ready||0}</b></div>
      <div class="stat"><span>Site visits needed</span><b>${counts.visit||0}</b></div>
      <div class="stat"><span>Images reviewed</span><b>${rev.d} <small>of ${rev.t}</small></b></div>
      <div class="stat"><span>Total gutter run</span><b>${Math.round(P.m).toLocaleString()} m</b></div>
      <div class="stat"><span>Time on site</span><b>${P.hrs.toFixed(1)} h <small>${(P.hrs/R.dayHours).toFixed(1)} days</small></b></div>
      <div class="stat"><span>Jobs completed</span><b>${all.filter(s=>inJob(s)&&s.data.job.status==='done').length} <small>of ${all.filter(inJob).length}</small></b></div>
      <div class="stat"><span>Quote / visit</span><b>${gbp0(P.net)} <small>${S().vat?'+VAT':'no VAT'}</small></b></div>
    </div>
    <section class="card">
      <div class="pf-tools">
        <input type="search" id="pfQ" placeholder="Search name, address, postcode…" value="${esc(search)}">
        <select id="pfFs"><option value="">All statuses</option>${STATUSES.map(s=>`<option value="${s[0]}" ${filterStatus===s[0]?'selected':''}>${s[1]} (${counts[s[0]]||0})</option>`).join('')}</select>
        <span style="flex:1"></span>
        <button class="btn" type="button" id="pfCsv">Copy as spreadsheet</button>
        <button class="btn" type="button" id="pfAdd">+ Add property</button>
      </div>
      <div class="pf-tbl"><table>
        <thead><tr>${th('ref','#')}<th></th>${th('name','Property')}${th('type','Type')}${th('storeys','Storeys','r')}${th('len','Gutter m','r')}<th class="r">Downpipes</th><th>Access</th><th>Method</th><th>Condition</th>${th('status','Survey')}${th('job','Job')}<th>Missing</th>${th('hrs','Hours','r')}${th('price','Price','r')}</tr></thead>
        <tbody>${rows.map(s=>{ const d = s.data, c = calc(s), st = statusOf(d.status), iss = issues(s), acc = ACCESS.filter(a=>d.access[a[0]]), im = s.photos.aerial || s.photos.street || s.photos.site[0], cond = CONDITIONS.find(x=>x[0]===d.condition);
          return `<tr data-id="${s.id}" class="${d.include===false||d.status==='noquote'?'off':''}">
          <td class="r">${esc(s.ref)}</td>
          <td>${im&&src(im)?`<img class="pf-th" src="${esc(src(im))}" alt="" loading="lazy">`:'<div class="pf-th"></div>'}</td>
          <td><b>${esc(s.name||s.address)}</b>${s.name?`<small>${esc(s.address)}</small>`:''}<small>${esc(s.postcode||'')}${d.units?' · '+esc(d.units)+' units':''}</small></td>
          <td>${esc(d.type)||'–'}${d.gutterType?`<small>${esc(d.gutterType)}</small>`:''}</td>
          <td class="r">${esc(d.storeys)||'–'}</td><td class="r"><b>${c.m?c.m.toFixed(0):'–'}</b></td><td class="r">${esc(d.downpipes)||'–'}</td>
          <td><div class="pf-badges">${acc.length?acc.map(a=>`<span class="pf-b ${a[0]==='mewp'||a[0]==='tower'?'bad':'warn'}">${esc(a[1].split(' –')[0].split(' /')[0].split(' (')[0])}</span>`).join(''):'<span class="pf-b ok">None noted</span>'}</div>${d.accessNotes?`<small>${esc(d.accessNotes.slice(0,70))}</small>`:''}</td>
          <td>${esc(d.method)||'–'}</td><td>${cond&&d.condition!=='unknown'?esc(cond[1].split(' –')[0]):'–'}</td>
          <td><span class="pf-st"><i style="background:${st[2]}"></i>${st[1]}</span></td>
          <td><span class="pf-st"><i style="background:${jobOf(d.job.status)[2]}"></i>${jobOf(d.job.status)[1]}</span>${d.job.status==='done'&&d.job.done?`<small>${fmtD(d.job.done)}</small>`:d.job.status==='booked'&&d.job.booked?`<small>${fmtD(d.job.booked)}</small>`:''}${s.photos.job.length?`<small>${s.photos.job.length} photo${s.photos.job.length>1?'s':''} · ${s.photos.job.filter(p=>p.share).length} shared</small>`:''}</td>
          <td><div class="pf-badges">${iss.length?iss.map(i=>`<span class="pf-b">${esc(i)}</span>`).join(''):'<span class="pf-b ok">Complete</span>'}</div></td>
          <td class="r">${c.hrs?c.hrs.toFixed(1):'–'}</td><td class="r"><b>${c.price?gbp0(c.price):'–'}</b></td></tr>`; }).join('')}</tbody>
        <tfoot><tr><td></td><td></td><td>${rows.length} shown</td><td></td><td></td><td class="r">${Math.round(rows.reduce((a,s)=>a+totalLen(s.data),0))}</td><td class="r">${rows.reduce((a,s)=>a+num(s.data.downpipes),0)}</td><td colspan="6"></td><td class="r">${rows.reduce((a,s)=>a+calc(s).hrs,0).toFixed(1)}</td><td class="r">${gbp0(rows.filter(s=>s.data.include!==false&&s.data.status!=='noquote').reduce((a,s)=>a+calc(s).price,0))}</td></tr></tfoot>
      </table></div>
    </section>`;
    $('pfQ').oninput = e=>{ search = e.target.value; const p = e.target.selectionStart; renderSummary(box, P); const q = $('pfQ'); q.focus(); q.setSelectionRange(p,p); };
    $('pfFs').onchange = e=>{ filterStatus = e.target.value; renderSummary(box, P); };
    box.querySelectorAll('th[data-sort]').forEach(t=> t.onclick = ()=>{ const k = t.dataset.sort; if(sortKey===k) sortDir *= -1; else { sortKey = k; sortDir = 1; } renderSummary(box, P); });
    box.querySelectorAll('tbody tr[data-id]').forEach(r=> r.onclick = ()=>{ siteId = r.dataset.id; tab = 'site'; render(); window.scrollTo(0,0); });
    $('pfAdd').onclick = addSite;
    $('pfCsv').onclick = copyCsv;
  }
  async function addSite(){
    const ref = Math.max(0, ...Object.values(sites).map(s=>num(s.ref))) + 1;
    const {data, error} = await sb.from('portfolio_sites').insert({portfolio_id:cur.id, ref, name:'', address:'', data:{status:'todo'}, updated_by_name:ME.name}).select('*').single();
    if(error){ flash('Could not add: ' + error.message); return; }
    siteData(data); sites[data.id] = data; siteId = data.id; tab = 'site'; render();
  }
  async function copyCsv(){
    const head = ['Ref','Site','Address','Postcode','Units','Type','Storeys','Total gutter m','Gutter type','Downpipes','Guards','Condition','Method','Access','Access notes','Status','Customer notes','Hours','Price'];
    const rows = sorted().map(s=>{ const d = s.data, c = calc(s); return [s.ref, s.name, s.address, s.postcode, d.units, d.type, d.storeys, c.m.toFixed(1), d.gutterType, d.downpipes, d.guards, d.condition, d.method, ACCESS.filter(a=>d.access[a[0]]).map(a=>a[1]).join('; '), d.accessNotes, statusOf(d.status)[1], d.notes, c.hrs.toFixed(1), c.price.toFixed(2)].map(v=>String(v??'').replace(/[\t\n]/g,' ')).join('\t'); });
    try{ await navigator.clipboard.writeText([head.join('\t'), ...rows].join('\n')); flash('Copied – paste into Excel or Google Sheets'); }catch(e){ flash('Copy was blocked by the browser'); }
  }

  /* ---------- rendering: one property ---------- */
  function mapLinks(s){
    const q = encodeURIComponent([s.address, s.postcode].filter(Boolean).join(', '));
    const ll = s.lat && s.lng ? `${s.lat},${s.lng}` : '';
    return {
      earth: ll ? `https://earth.google.com/web/@${s.lat},${s.lng},30a,120d,35y,0h,45t,0r` : `https://earth.google.com/web/search/${q}`,
      street: ll ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll}` : `https://www.google.com/maps/search/?api=1&query=${q}`
    };
  }
  function revBtn(img, attr){ return `<button type="button" class="pf-rev ${img.reviewed?'on':''}" ${attr} title="${img.reviewed ? 'Reviewed' + (img.reviewedBy?' by '+esc(img.reviewedBy):'') + (img.reviewedAt?' on '+new Date(img.reviewedAt).toLocaleDateString('en-GB'):'') + ' – click to undo' : 'Click once a person has checked this image'}"><span class="bx"></span>${img.reviewed ? 'Reviewed' + (img.reviewedBy?' · '+esc(img.reviewedBy.split(' ')[0]):'') : 'Mark reviewed'}</button>`; }
  function renderSite(box){
    const all = sorted();
    if(!all.length){ box.innerHTML = `<section class="card"><p class="hint">No properties yet.</p></section>`; return; }
    let s = sites[siteId]; if(!s){ s = all[0]; siteId = s.id; }
    const d = siteData(s), c = calc(s), L = mapLinks(s);
    const i = all.findIndex(x=>x.id===s.id), prev = all[i-1], next = all[i+1];
    const slot = (kind, title, img, link) => `
      <div class="pf-slot ${img&&img.reviewed?'reviewed':''}" tabindex="0" data-slot="${kind}">
        <div class="pf-slot-h"><b>${title}</b><span class="pf-slot-a"><button type="button" class="btn sm" data-gtake="${kind}" title="Take a fresh ${title.toLowerCase()} image from Google at this property's pin">Take from Google</button>${link}</span></div>
        <div class="pf-slot-b">${img ? `<img src="${esc(src(img))}" data-full="${esc(img.path)}" alt="${title}">` : `<div class="hint" style="text-align:center"><b>Click here, then paste a screenshot</b> (Ctrl+V / ⌘V)<br>or drop an image · <a href="#" data-pick="${kind}">choose file</a></div>`}</div>
        ${img ? revBtn(img, `data-rev="${kind}"`) + `<button type="button" class="btn sm pf-x" data-clear="${kind}">Remove</button>` : ''}
      </div>`;
    box.innerHTML = `
    <div class="pf-head">
      <div style="flex:1;min-width:240px"><p class="hint" style="margin:0">PROPERTY ${esc(s.ref)} OF ${all.length}</p><h2 class="vtitle" style="font-size:1.4rem">${esc(s.name||s.address||'New property')}</h2><p class="sub">${s.name?esc(s.address)+', ':''}${esc(s.postcode||'')}</p></div>
      <div class="pf-pager"><select id="pfJump">${all.map(x=>`<option value="${x.id}" ${x.id===s.id?'selected':''}>${esc(x.ref)}. ${esc((x.name||x.address||'').slice(0,40))}</option>`).join('')}</select>
        <button class="btn" type="button" id="pfPrev" ${prev?'':'disabled'}>← Prev</button><button class="btn" type="button" id="pfNext" ${next?'':'disabled'}>Next →</button></div>
    </div>
    <div class="pf-grid">
      <div class="col">
        <section class="card"><h3 style="margin-top:0">Property</h3><div class="fields">
          <label class="f wide">Site name<input data-c="name" value="${esc(s.name)}"></label>
          <label class="f wide">Address<input data-c="address" value="${esc(s.address)}"></label>
          <label class="f">Postcode<input data-c="postcode" value="${esc(s.postcode)}"></label>
          <label class="f">Ref #<input type="number" data-c="ref" value="${esc(s.ref)}"></label>
          <label class="f">Property type<select data-k="type">${opt(TYPES, d.type)}</select></label>
          <label class="f">Flats / units<input type="number" data-k="units" value="${esc(d.units)}"></label>
          <label class="f">Storeys (to gutter)<input type="number" min="1" data-k="storeys" value="${esc(d.storeys)}"></label>
          <label class="f">Survey status<select data-k="status">${opt(STATUSES.map(x=>[x[0],x[1]]), d.status, '–')}</select></label>
        </div></section>
        <section class="card"><h3 style="margin-top:0">Gutters</h3>
          <label class="f">Gutter length by elevation (m)</label>
          <div class="pf-lens">${['front','rear','left','right','other'].map(k=>`<input type="number" step="0.5" min="0" data-len="${k}" value="${esc(d.len[k])}" placeholder="${k[0].toUpperCase()+k.slice(1)}" title="${k}">`).join('')}</div>
          <div class="pf-lenbar"><span class="pf-tot" id="pfTot">Total ${c.m.toFixed(1)} m</span>${window.PURGO_MEASURE?`<button class="btn sm" type="button" id="pfMeasure">Measure on map</button>`:''}<span class="hint" style="margin:0">or measure the roofline in <a href="${L.earth}" target="_blank" rel="noopener">Google Earth</a></span></div>
          <div class="fields" style="margin-top:10px">
            <label class="f">Gutter type<select data-k="gutterType">${opt(GUTTER_TYPES, d.gutterType)}</select></label>
            <label class="f">Condition<select data-k="condition">${opt(CONDITIONS, d.condition, '–')}</select></label>
            <label class="f">Downpipes<input type="number" min="0" data-k="downpipes" value="${esc(d.downpipes)}"></label>
            <label class="f">Downpipe guards to fit<input type="number" min="0" data-k="guards" value="${esc(d.guards)}"></label>
            <label class="f">Fascia & soffit clean (m)<input type="number" min="0" data-k="fascia" value="${esc(d.fascia)}"></label>
          </div>
          <label class="ck" style="margin-top:10px"><input type="checkbox" data-k="flush" ${d.flush?'checked':''}>Flush & check all downpipes</label>
        </section>
        <section class="card"><h3 style="margin-top:0">Access & method</h3>
          <div class="fields" style="margin-bottom:12px">
            <label class="f">Cleaning method<select data-k="method">${opt(METHODS, d.method)}</select></label>
            <label class="f">Key holder / site contact<input data-k="keyholder" value="${esc(d.keyholder)}"></label>
          </div>
          <div class="checks">${ACCESS.map(([k,l,key])=>{ const h = key==='tower' ? null : key ? num(R[key]) : 0; return `<label class="ck"><input type="checkbox" data-acc="${k}" ${d.access[k]?'checked':''}>${esc(l)}${key==='tower'?` <small>+${gbp(R.towerDay)}/day</small>`:h?` <small>+${h}h</small>`:''}</label>`; }).join('')}</div>
          <label class="f" style="margin-top:12px">Access notes (parking, bin stores, gates, resident notice…)<textarea data-k="accessNotes" rows="3">${esc(d.accessNotes)}</textarea></label>
        </section>
        <section class="card"><h3 style="margin-top:0">Notes & price</h3>
          <label class="f">Notes for customer (shown on quote)<textarea data-k="notes" rows="2">${esc(d.notes)}</textarea></label>
          <label class="f" style="margin-top:10px">Internal notes (never shown to customer)<textarea data-k="internal" rows="2">${esc(d.internal)}</textarea></label>
          <div class="fields" style="margin-top:10px">
            <label class="f">Price adjustment £ (+/–)<input type="number" step="1" data-k="adjust" value="${esc(d.adjust)}"></label>
            <label class="f">Reason<input data-k="adjustReason" value="${esc(d.adjustReason)}"></label>
          </div>
          <label class="ck" style="margin-top:10px"><input type="checkbox" data-k="include" ${d.include!==false?'checked':''}>Include this property in the customer quote</label>
          ${ROLE==='admin'?`<div style="margin-top:14px;text-align:right"><button class="btn sm" type="button" id="pfDelSite" style="color:var(--bad)">Delete property</button></div>`:''}
        </section>
      </div>
      <div class="col">
        ${jobCard(s)}
        <section class="card pf-price" id="pfPrice">${priceBox(s, c)}</section>
        <section class="card"><div class="pf-maphead"><h3 style="margin:0">Live Google views</h3><span class="hint" style="margin:0">Drag to look around · <a href="${L.street}" target="_blank" rel="noopener">open in Google Maps ↗</a></span></div>
          <div class="pf-live"><div id="pfMap" class="pf-livebox"></div><div id="pfPano" class="pf-livebox"></div></div>
          <p class="hint" id="pfMapMsg">${s.lat&&s.lng?'':'No location pinned yet – the map will search by address.'}</p>
          <div class="pf-lenbar" style="margin-top:6px"><button class="btn sm" type="button" id="pfPin">Pin building to map centre</button><span class="hint" style="margin:0">To save a view for the quote: screenshot it, click the Aerial or Street View box below and paste.</span></div>
        </section>
        <section class="card"><h3 style="margin-top:0">Saved survey images</h3>
          <div class="pf-slots">${slot('aerial','Aerial', s.photos.aerial, `<a class="btn sm" href="${L.earth}" target="_blank" rel="noopener">Earth ↗</a>`)}${slot('street','Street View', s.photos.street, `<a class="btn sm" href="${L.street}" target="_blank" rel="noopener">Street ↗</a>`)}</div>
          <p class="hint">These images go on the customer quote. Each one needs a person to press <b>Mark reviewed</b> once they've checked it shows the right building.</p>
        </section>
        <section class="card pf-slot pf-sitephotos" tabindex="0" data-slot="site" style="border-style:solid">
          <div class="pf-slot-h"><h3 style="margin:0">Site photos (${s.photos.site.length})</h3><button class="btn sm" type="button" data-pick="site">+ Add photos</button></div>
          <div class="pf-gal">${s.photos.site.map((p,ix)=>`<div class="pf-ph"><img src="${esc(src(p))}" data-full="${esc(p.path)}" alt="" loading="lazy">${revBtn(p, `data-revp="${ix}"`)}<button type="button" class="pf-rm" data-rm="${ix}" title="Remove photo">×</button><input data-cap="${ix}" value="${esc(p.caption)}" placeholder="Caption…"></div>`).join('')}
            <div class="pf-ph pf-add" data-pick="site">＋<br>Add photos<br><small>or drop / paste here</small></div></div>
        </section>
      </div>
    </div>
    <div class="pf-lb" id="pfLb" hidden><img alt=""></div>
    <input type="file" id="pfFile" accept="image/*" multiple hidden>`;
    bindSite(s);
    liveViews(s);
  }
  function shareBtn(img, attr){ return `<button type="button" class="pf-rev pf-share ${img.share?'on':''}" ${attr} title="${img.share ? 'The customer can see this' + (img.sharedBy?' (ticked by '+esc(img.sharedBy)+')':'') + ' – click to hide it' : 'Hidden from the customer – click to let them see it'}"><span class="bx"></span>${img.share ? 'Customer can see' : 'Show customer'}</button>`; }
  function fileRow(f, attr, rmAttr){ return `<div class="pf-file"><span class="pf-fi">${/\.pdf$/i.test(f.path||'')?'PDF':'IMG'}</span><a href="${esc(src(f))}" target="_blank" rel="noopener">${esc(f.name||'File')}</a><small>${fmtD(f.added)}${f.addedBy?' · '+esc(f.addedBy):''}</small>${shareBtn(f, attr)}<button type="button" class="pf-rm" ${rmAttr} title="Remove file">×</button></div>`; }
  function jobCard(s){
    const j = s.data.job, r = j.report, js = jobOf(j.status), ph = s.photos.job, fl = s.photos.files;
    const stage = st => ph.map((p,ix)=>[p,ix]).filter(([p])=>(p.stage||'after')===st);
    const gal = st => stage(st).map(([p,ix])=>`<div class="pf-ph ${p.share?'shared':''}"><span class="pf-stage">${st==='before'?'Before':'After'}</span><img src="${esc(src(p))}" data-full="${esc(p.path)}" alt="" loading="lazy">${shareBtn(p, `data-sharej="${ix}"`)}<button type="button" class="pf-rm" data-rmj="${ix}" title="Remove photo">×</button><input data-capj="${ix}" value="${esc(p.caption)}" placeholder="Caption (customer sees this)…"></div>`).join('');
    return `<section class="card pf-job"><div class="pf-maphead"><h3 style="margin:0">Job &amp; customer report</h3><span class="pf-st"><i style="background:${js[2]}"></i>${js[1]}</span></div>
      <div class="fields" style="margin-top:10px">
        <label class="f">Job status<select data-j="status">${JOB_ST.map(x=>`<option value="${x[0]}" ${x[0]===(j.status||'')?'selected':''}>${x[1]}</option>`).join('')}</select></label>
        <label class="f">Booked for<input type="date" data-j="booked" value="${esc(j.booked)}"></label>
        <label class="f">Completed on<input type="date" data-j="done" value="${esc(j.done)}"></label>
        ${j.status==='noaccess'?`<label class="f wide">Why we couldn't access (customer sees this)<input data-j="reason" value="${esc(j.reason)}" placeholder="e.g. Cars parked under the rear gutters, gate locked"></label>`:''}
      </div>
      <h4 class="pf-h4">Report</h4>
      <label class="f">Work carried out<textarea data-jr="work" rows="2" placeholder="${esc(WORK_DEFAULT)}">${esc(r.work)}</textarea></label>
      <div class="fields" style="margin-top:8px"><label class="f">Gutter condition found<select data-jr="condition">${opt(CONDITIONS.filter(c=>c[0]!=='unknown'), r.condition, '–')}</select></label></div>
      <label class="f" style="margin-top:8px">Defects / issues found<textarea data-jr="issues" rows="2" placeholder="e.g. Cracked joint above flat 4 – see photo. Leave blank if none.">${esc(r.issues)}</textarea></label>
      <label class="f" style="margin-top:8px">Recommendations<textarea data-jr="recommend" rows="2" placeholder="e.g. Replace downpipe guard at rear; quote to follow">${esc(r.recommend)}</textarea></label>
      <label class="ck" style="margin-top:10px"><input type="checkbox" data-j="shareReport" ${j.shareReport?'checked':''}>Show this report to the customer</label>
      <h4 class="pf-h4">Job photos <small>${ph.length} · ${ph.filter(p=>p.share).length} shown to customer</small></h4>
      <div class="pf-lenbar"><button class="btn sm" type="button" data-pick="before">+ Before photos</button><button class="btn sm" type="button" data-pick="after">+ After photos</button><span class="hint" style="margin:0">Only photos ticked <b>Show customer</b> appear in their view.</span></div>
      ${ph.length ? `<div class="pf-gal pf-jgal">${gal('before')}${gal('after')}</div>` : ''}
      <h4 class="pf-h4">Reports &amp; files <small>PDF or image</small></h4>
      <div class="pf-files">${fl.map((f,ix)=>fileRow(f, `data-sharef="${ix}"`, `data-rmf="${ix}"`)).join('') || '<p class="hint" style="margin:0">None yet.</p>'}</div>
      <div class="pf-lenbar"><button class="btn sm" type="button" data-pick="file">+ Add file</button></div>
    </section>`;
  }
  function priceBox(s, c){
    return `<h3 style="margin-top:0">Price for this property</h3>
      ${c.lines.map(([l,a,dt])=>`<div class="pf-pl"><span>${esc(l)}<small>${esc(dt)}</small></span><b>${gbp(a)}</b></div>`).join('') || '<p class="hint">Enter the gutter lengths to price this property.</p>'}
      <div class="pf-pl big"><span>Price per visit${S().vat?' (ex VAT)':''}</span><b>${c.price?gbp(c.price):'–'}</b></div>
      <p class="hint">${c.m?`About ${c.hrs.toFixed(1)}h on site with ${S().crew} people. `:''}Rates from the price list (Admin → Gutters).${c.needsVisit?' <b>Above 3 storeys / MEWP: needs a site visit and access equipment.</b>':''}</p>`;
  }
  function refresh(s){ const c = calc(s); const p = $('pfPrice'); if(p) p.innerHTML = priceBox(s, c); const t = $('pfTot'); if(t) t.textContent = `Total ${c.m.toFixed(1)} m`; }
  function bindSite(s){
    const all = sorted(), i = all.findIndex(x=>x.id===s.id);
    const go = id => { siteId = id; render(); window.scrollTo(0,0); };
    $('pfJump').onchange = e=> go(e.target.value);
    $('pfPrev').onclick = ()=> all[i-1] && go(all[i-1].id);
    $('pfNext').onclick = ()=> all[i+1] && go(all[i+1].id);
    const b = root();
    b.querySelectorAll('[data-c]').forEach(e=> e.addEventListener('input', ()=>{ const k = e.dataset.c; s[k] = k==='ref' ? num(e.value) : e.value; saveSite(s); }));
    b.querySelectorAll('[data-k]').forEach(e=>{
      const ev = (e.tagName==='SELECT' || e.type==='checkbox') ? 'change' : 'input';
      e.addEventListener(ev, ()=>{ s.data[e.dataset.k] = e.type==='checkbox' ? e.checked : e.value; saveSite(s, ev==='change'?0:700); refresh(s); });
    });
    b.querySelectorAll('[data-len]').forEach(e=> e.addEventListener('input', ()=>{ s.data.len[e.dataset.len] = e.value; saveSite(s); refresh(s); }));
    b.querySelectorAll('[data-acc]').forEach(e=> e.addEventListener('change', ()=>{ s.data.access[e.dataset.acc] = e.checked; saveSite(s, 0); refresh(s); }));
    b.querySelectorAll('[data-cap]').forEach(e=> e.addEventListener('input', ()=>{ s.photos.site[+e.dataset.cap].caption = e.value; saveSite(s, 900); }));
    b.querySelectorAll('[data-rev]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); toggleRev(s, s.photos[e.dataset.rev]); }));
    b.querySelectorAll('[data-revp]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); toggleRev(s, s.photos.site[+e.dataset.revp]); }));
    b.querySelectorAll('[data-clear]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); removeImg(s, e.dataset.clear); }));
    b.querySelectorAll('[data-gtake]').forEach(e=> e.addEventListener('click', async ev=>{
      ev.stopPropagation(); const k = e.dataset.gtake; e.disabled = true; e.textContent = 'Taking…';
      try{ await takeGoogle(s, k); render(); flash(k==='aerial' ? 'Aerial image updated from Google' : 'Street View image updated from Google'); }
      catch(x){ flash(x.message||String(x)); e.disabled = false; e.textContent = 'Take from Google'; }
    }));
    b.querySelectorAll('[data-rm]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); removeImg(s, 'site', +e.dataset.rm); }));
    b.querySelectorAll('[data-full]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); const lb = $('pfLb'); lb.querySelector('img').src = urls[e.dataset.full] || e.src; lb.hidden = false; }));
    $('pfLb').onclick = ()=> $('pfLb').hidden = true;
    b.querySelectorAll('[data-j]').forEach(e=>{
      const ev = (e.tagName==='SELECT' || e.type==='checkbox' || e.type==='date') ? 'change' : 'input';
      e.addEventListener(ev, ()=>{
        const k = e.dataset.j, j = s.data.job; j[k] = e.type==='checkbox' ? e.checked : e.value;
        if(k==='status'){ if(j.status==='done' && !j.done) j.done = new Date().toISOString().slice(0,10); if(j.status==='done' && !j.report.work) j.report.work = WORK_DEFAULT; }
        saveSite(s, ev==='input'?700:0); if(k==='status') render();
      });
    });
    b.querySelectorAll('[data-jr]').forEach(e=> e.addEventListener(e.tagName==='SELECT'?'change':'input', ()=>{ s.data.job.report[e.dataset.jr] = e.value; saveSite(s, e.tagName==='SELECT'?0:700); }));
    b.querySelectorAll('[data-capj]').forEach(e=> e.addEventListener('input', ()=>{ s.photos.job[+e.dataset.capj].caption = e.value; saveSite(s, 900); }));
    b.querySelectorAll('[data-sharej]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); toggleShare(s, s.photos.job[+e.dataset.sharej]); }));
    b.querySelectorAll('[data-sharef]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); toggleShare(s, s.photos.files[+e.dataset.sharef]); }));
    b.querySelectorAll('[data-rmj]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); removeImg(s, 'job', +e.dataset.rmj); }));
    b.querySelectorAll('[data-rmf]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); removeImg(s, 'files', +e.dataset.rmf); }));
    let pickKind = 'site';
    b.querySelectorAll('[data-pick]').forEach(e=> e.addEventListener('click', ev=>{ ev.preventDefault(); ev.stopPropagation(); pickKind = e.dataset.pick; const f = $('pfFile'); f.multiple = pickKind!=='aerial' && pickKind!=='street'; f.accept = pickKind==='file' ? 'application/pdf,image/*' : 'image/*'; f.value = ''; f.click(); }));
    $('pfFile').onchange = e=>{ if(!e.target.files.length) return; if(pickKind==='file') addFiles(s, [...e.target.files]); else addImages(s, pickKind, [...e.target.files]); };
    b.querySelectorAll('.pf-slot').forEach(el=>{
      el.addEventListener('click', ()=>{ armed = el.dataset.slot; b.querySelectorAll('.pf-slot').forEach(x=>x.classList.toggle('armed', x===el)); });
      el.addEventListener('focus', ()=>{ armed = el.dataset.slot; });
      el.addEventListener('dragover', e=>{ e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', ()=> el.classList.remove('drag'));
      el.addEventListener('drop', e=>{ e.preventDefault(); el.classList.remove('drag'); const f = [...e.dataTransfer.files].filter(x=>x.type.startsWith('image/')); if(f.length) addImages(s, el.dataset.slot, f); });
    });
    const del = $('pfDelSite'); if(del) del.onclick = async ()=>{
      if(!confirmInline('pfDel'+s.id, 'Press Delete property again to remove it and its photos.')) return;
      const paths = allFiles(s).map(x=>x.path).filter(Boolean);
      const {error} = await sb.from('portfolio_sites').delete().eq('id', s.id); if(error){ flash('Could not delete: ' + error.message); return; }
      if(paths.length) sb.storage.from(BUCKET).remove(paths).catch(()=>{});
      delete sites[s.id]; siteId = null; tab = 'summary'; render(); flash('Property deleted');
    };
    const pin = $('pfPin'); if(pin) pin.onclick = ()=>{ if(!live.map){ flash('The map has not loaded'); return; } const c = live.map.getCenter(); s.lat = +c.lat().toFixed(6); s.lng = +c.lng().toFixed(6); saveSite(s, 0); flash('Building pinned'); liveViews(s); };
    const ms = $('pfMeasure'); if(ms) ms.onclick = ()=>{
      if(typeof MEASURE==='undefined' || !MEASURE.openFor){ flash('Measuring is not available'); return; }
      MEASURE.openFor({kind:'gutters', addr:[s.address, s.postcode].filter(Boolean).join(', '), lat:s.lat, lng:s.lng, property:'commercial', label:'Use for this property', back:'portfolio',
        shapes: Array.isArray(s.data.measureShapes) ? s.data.measureShapes : [],
        onUse:(total, runs)=>{
          // each gutter run goes on the elevation its name says (Front / Rear / Left / Right); anything else → Other
          const by = {front:0, rear:0, left:0, right:0, other:0};
          (runs||[]).forEach(r=>{ by[MEASURE.elevOf ? MEASURE.elevOf(r.label) : 'other'] += num(r.value); });
          if(!(runs||[]).length) by.front = total;
          const f = v => v ? String(Math.round(v*10)/10) : '';
          s.data.len = {front:f(by.front), rear:f(by.rear), left:f(by.left), right:f(by.right), other:f(by.other)};
          s.data.measureShapes = runs || []; s.data.measuredAt = new Date().toISOString(); saveSite(s, 0);
          const parts = Object.entries(by).filter(([k,v])=>v).map(([k,v])=>`${k} ${Math.round(v)} m`);
          flash(`Gutters saved – ${parts.join(', ')}`);
        }});
    };
  }
  function toggleRev(s, img){
    if(!img) return;
    img.reviewed = !img.reviewed;
    if(img.reviewed){ img.reviewedAt = new Date().toISOString(); img.reviewedBy = ME.name; } else { delete img.reviewedAt; delete img.reviewedBy; }
    saveSite(s, 0); render(); flash(img.reviewed ? 'Marked as reviewed' : 'Review removed');
  }
  function toggleShare(s, img, save){
    if(!img) return;
    img.share = !img.share;
    if(img.share){ img.sharedAt = new Date().toISOString(); img.sharedBy = ME.name; } else { delete img.sharedAt; delete img.sharedBy; }
    (save || (()=>saveSite(s, 0)))(); render(); flash(img.share ? 'The customer can now see this' : 'Hidden from the customer');
  }
  async function removeImg(s, kind, ix){
    const isList = kind==='site' || kind==='job' || kind==='files';
    const img = isList ? s.photos[kind][ix] : s.photos[kind]; if(!img) return;
    if(!confirmInline('pfRm'+(img.path||ix), kind==='files' ? 'Press again to remove this file.' : 'Press again to remove this image.')) return;
    if(isList) s.photos[kind].splice(ix, 1); else s.photos[kind] = null;
    saveSite(s, 0); if(img.path) sb.storage.from(BUCKET).remove([img.path]).catch(()=>{});
    render(); flash('Image removed');
  }
  async function shrink(file){
    try{
      const bmp = await createImageBitmap(file); const max = 1800, k = Math.min(1, max/Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width*k); cv.height = Math.round(bmp.height*k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      return await new Promise(r=>cv.toBlob(b=>r(b||file), 'image/jpeg', .85));
    }catch(e){ return file; }
  }
  async function uploadImg(s, kind, blob){
    const path = `${cur.id}/${s.id}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2,7)}.jpg`;
    const {error} = await sb.storage.from(BUCKET).upload(path, blob, {contentType:'image/jpeg', upsert:false});
    if(error) throw error;
    const {data} = await sb.storage.from(BUCKET).createSignedUrl(path, 60*60*6); if(data) urls[path] = data.signedUrl;
    return {path, caption:'', added:new Date().toISOString(), addedBy:ME.name};
  }
  // Fresh still images from Google at the property's pin: satellite (Maps Static API) and the nearest
  // official Street View panorama, turned to face the building (Street View Static API).
  const bearing = (a, b) => { const t = x=>x*Math.PI/180, y = Math.sin(t(b.lng-a.lng))*Math.cos(t(b.lat)), x = Math.cos(t(a.lat))*Math.sin(t(b.lat)) - Math.sin(t(a.lat))*Math.cos(t(b.lat))*Math.cos(t(b.lng-a.lng)); return (Math.atan2(y, x)*180/Math.PI + 360) % 360; };
  async function pinOf(s){
    if(s.lat && s.lng) return {lat:+s.lat, lng:+s.lng};
    await MEASURE.loadGoogle(); const q = [s.address, s.postcode].filter(Boolean).join(', ');
    const {results} = await new google.maps.Geocoder().geocode({address:q, region:'gb'});
    if(!results || !results[0]) throw new Error('Address not found on the map – pin the building first');
    const l = results[0].geometry.location; s.lat = l.lat(); s.lng = l.lng(); return {lat:s.lat, lng:s.lng};
  }
  async function googleBlob(s, kind){
    const key = (window.PURGO_CONFIG||{}).googleMapsKey; if(!key) throw new Error('Google Maps is not set up');
    const p = await pinOf(s), at = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`, G = 'https://maps.googleapis.com/maps/api/';
    let url;
    if(kind==='aerial') url = `${G}staticmap?center=${at}&zoom=20&size=640x640&scale=2&maptype=satellite&key=${key}`;
    else {
      const m = await (await fetch(`${G}streetview/metadata?location=${at}&radius=80&source=outdoor&key=${key}`)).json();
      if(m.status==='REQUEST_DENIED') throw new Error('Google refused – the Street View Static API is not allowed on the app\'s Google key yet');
      if(m.status!=='OK') throw new Error('No Google Street View near this building – take a street photo on site');
      url = `${G}streetview?size=640x640&pano=${m.pano_id}&heading=${bearing(m.location, p).toFixed(0)}&pitch=12&fov=80&key=${key}`;
    }
    const r = await fetch(url);
    if(!r.ok) throw new Error(r.status===403 ? `Google refused – the ${kind==='aerial'?'Maps Static':'Street View Static'} API is not allowed on the app's Google key yet` : `Google error ${r.status}`);
    return await r.blob();
  }
  async function takeGoogle(s, kind){
    const rec = await uploadImg(s, kind, await googleBlob(s, kind)); rec.source = 'google';
    const old = s.photos[kind]; s.photos[kind] = rec; if(old && old.path) sb.storage.from(BUCKET).remove([old.path]).catch(()=>{});
    saveSite(s, 0);
  }
  async function addImages(s, kind, files, quiet){
    const many = kind==='site' || kind==='before' || kind==='after';
    if(!many) files = files.slice(0,1);
    saveStatus('Uploading…'); if(!quiet) flash(files.length>1 ? `Uploading ${files.length} photos…` : 'Uploading…');
    let n = 0;
    for(const f of files){
      try{
        const rec = await uploadImg(s, kind, await shrink(f));
        if(kind==='site') s.photos.site.push(rec);
        else if(kind==='before' || kind==='after'){ rec.stage = kind; s.photos.job.push(rec); }
        else { const old = s.photos[kind]; s.photos[kind] = rec; if(old && old.path) sb.storage.from(BUCKET).remove([old.path]).catch(()=>{}); }
        n++;
      }catch(e){ console.error(e); flash('Upload failed: ' + (e.message||e)); }
    }
    if(n){ saveSite(s, 0); if(!quiet){ render(); flash(n>1 ? `${n} photos added` : 'Photo added'); } }
    return n;
  }
  // PDFs and other documents (reports, certificates, RAMS). Stored as-is, shown to the customer only when ticked.
  async function uploadFile(folder, file){
    const ext = (file.name.match(/\.(pdf|jpe?g|png|webp)$/i)||['','pdf'])[1].toLowerCase();
    if(!/pdf|jpe?g|png|webp/.test(ext) || file.size > 20*1024*1024) throw new Error(`${file.name}: only PDFs or images up to 20 MB`);
    const path = `${cur.id}/${folder}/file-${Date.now()}-${Math.random().toString(36).slice(2,7)}.${ext}`;
    const type = ext==='pdf' ? 'application/pdf' : ext==='png' ? 'image/png' : ext==='webp' ? 'image/webp' : 'image/jpeg';
    const {error} = await sb.storage.from(BUCKET).upload(path, file, {contentType:type, upsert:false}); if(error) throw error;
    const {data} = await sb.storage.from(BUCKET).createSignedUrl(path, 60*60*6); if(data) urls[path] = data.signedUrl;
    return {path, name:file.name.replace(/\.[^.]+$/, '').slice(0,100), added:new Date().toISOString(), addedBy:ME.name, share:false};
  }
  async function addFiles(s, files){
    saveStatus('Uploading…'); let n = 0;
    for(const f of files){ try{ s.photos.files.push(await uploadFile(s.id, f)); n++; }catch(e){ flash('Upload failed: ' + (e.message||e)); } }
    if(n){ saveSite(s, 0); render(); flash(n>1 ? `${n} files added` : 'File added'); } else saveStatus('All changes saved');
  }
  document.addEventListener('paste', e=>{
    if(root().hidden || tab!=='site' || !siteId) return;
    const a = document.activeElement; if(a && (a.tagName==='INPUT' || a.tagName==='TEXTAREA')) return;
    const files = [...(e.clipboardData && e.clipboardData.items || [])].filter(i=>i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
    if(!files.length) return; e.preventDefault();
    addImages(sites[siteId], armed || 'site', files);
  });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ const lb = $('pfLb'); if(lb) lb.hidden = true; } });

  /* ---------- live Google map + Street View ---------- */
  const live = {map:null, pano:null, marker:null};
  async function liveViews(s){
    const msg = t => { const m = $('pfMapMsg'); if(m) m.textContent = t; };
    try{
      if(typeof MEASURE==='undefined' || !MEASURE.loadGoogle) throw new Error('Google Maps is not available');
      await MEASURE.loadGoogle();
      if(!$('pfMap')) return;
      let pos = s.lat && s.lng ? {lat:+s.lat, lng:+s.lng} : null;
      if(!pos){
        const q = [s.address, s.postcode].filter(Boolean).join(', ');
        if(!q){ msg('Add an address to see the map.'); return; }
        const {results} = await new google.maps.Geocoder().geocode({address:q, region:'gb'});
        if(!results || !results.length){ msg('Address not found on the map.'); return; }
        pos = results[0].geometry.location.toJSON();
      }
      live.map = new google.maps.Map($('pfMap'), {center:pos, zoom:19, mapTypeId:'satellite', tilt:0, disableDefaultUI:true, zoomControl:true, fullscreenControl:true, gestureHandling:'cooperative', clickableIcons:false});
      live.marker = new google.maps.Marker({position:pos, map:live.map});
      new google.maps.StreetViewService().getPanorama({location:pos, radius:80, source:(google.maps.StreetViewSource.GOOGLE||google.maps.StreetViewSource.OUTDOOR), preference:google.maps.StreetViewPreference.NEAREST}, (data, status)=>{
        if(!$('pfPano')) return;
        if(status!=='OK'){ $('pfPano').innerHTML = '<div class="pf-nosv">No Google Street View near this building.<br>Take a street photo on site.</div>'; return; }
        const at = data.location.latLng;
        const heading = google.maps.geometry.spherical.computeHeading(at, new google.maps.LatLng(pos));
        live.pano = new google.maps.StreetViewPanorama($('pfPano'), {pano:data.location.pano, pov:{heading, pitch:10}, zoom:0, addressControl:false, fullscreenControl:true, motionTracking:false, linksControl:true, panControl:false, enableCloseButton:false});
      });
    }catch(e){ msg(e.message || String(e)); }
  }
  /* ---------- map of every property + visit routes ---------- */
  const BASE_ADDR = '26 Anlaby Park Road South, Hull HU4 7BJ';
  const ST = () => { cur.settings = cur.settings || {}; return cur.settings; };   // the saved settings themselves (S() is a copy)
  const MV = {map:null, markers:{}, line:null, base:null, colour:'survey', show:'all', plan:null};
  const plans = () => { const st = ST(); st.plans = Array.isArray(st.plans) ? st.plans : []; return st.plans; };
  const planOf = id => plans().find(p=>p.id===id);
  const routedIn = sid => plans().find(p=>p.stops.includes(sid));
  const hav = (a,b) => { const R6 = 6371, t = x=>x*Math.PI/180, dLa = t(b.lat-a.lat), dLo = t(b.lng-a.lng);
    const h = Math.sin(dLa/2)**2 + Math.cos(t(a.lat))*Math.cos(t(b.lat))*Math.sin(dLo/2)**2; return 2*R6*Math.asin(Math.sqrt(h)); };
  const ll = s => s && s.lat && s.lng ? {lat:+s.lat, lng:+s.lng} : null;
  const startLL = () => { const st = ST(); return st.planStartLL && st.planStartLL.lat ? st.planStartLL : null; };
  // best visiting order: nearest neighbour from the start, then 2-opt to untangle crossings
  function bestOrder(ids, start, back){
    const pts = ids.map(id=>({id, p:ll(sites[id])})).filter(x=>x.p);
    if(pts.length < 2) return pts.map(x=>x.id);
    const d = (a,b) => hav(a,b);
    let order = [], left = pts.slice(), at = start || left[0].p;
    if(!start){ order.push(left.shift()); at = order[0].p; }
    while(left.length){ let bi = 0, bd = Infinity; left.forEach((x,i)=>{ const v = d(at, x.p); if(v<bd){ bd = v; bi = i; } }); const n = left.splice(bi,1)[0]; order.push(n); at = n.p; }
    const path = o => { let t = 0, prev = start; o.forEach(x=>{ if(prev) t += d(prev, x.p); prev = x.p; }); if(back && start && o.length) t += d(o[o.length-1].p, start); return t; };
    let best = path(order), improved = true, guard = 0;
    while(improved && guard++ < 60){
      improved = false;
      for(let i=0;i<order.length-1;i++) for(let k=i+1;k<order.length;k++){
        const c = order.slice(0,i).concat(order.slice(i,k+1).reverse(), order.slice(k+1)); const v = path(c);
        if(v < best - 1e-9){ order = c; best = v; improved = true; }
      }
    }
    return order.map(x=>x.id).concat(ids.filter(id=>!ll(sites[id])));
  }
  function routeStats(p){
    const st = ST(), start = startLL(), pts = p.stops.map(id=>ll(sites[id])).filter(Boolean);
    let km = 0, prev = start; pts.forEach(x=>{ if(prev) km += hav(prev, x); prev = x; }); if(st.planReturn!==false && start && pts.length) km += hav(pts[pts.length-1], start);
    const miles = km * 1.3 * 0.621371;                     // straight line → roads, roughly
    const drive = miles / 18;                              // ~18 mph average round Hull, with parking
    const work = p.stops.reduce((a,id)=>a + (sites[id] ? calc(sites[id]).hrs : 0), 0);
    return {miles, drive, work, total:drive+work};
  }
  function mapsLinks(p){
    const st = ST(), start = startLL();
    const pts = [...(start?[start]:[]), ...p.stops.map(id=>ll(sites[id])).filter(Boolean), ...(start && st.planReturn!==false ? [start] : [])];
    const out = [];
    for(let i=0; i<pts.length-1; i+=10){                     // Google Maps links take up to 9 stops between start and end
      const seg = pts.slice(i, i+11); if(seg.length<2) break;
      const f = x => `${x.lat.toFixed(6)},${x.lng.toFixed(6)}`;
      out.push(`https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${f(seg[0])}&destination=${f(seg[seg.length-1])}${seg.length>2?'&waypoints='+encodeURIComponent(seg.slice(1,-1).map(f).join('|')):''}`);
    }
    return out;
  }
  const hm = h => { const m = Math.round(h*60); return m<60 ? `${m} min` : `${Math.floor(m/60)} h ${String(m%60).padStart(2,'0')}`; };

  function renderMap(box){
    const st = ST(), all = sorted(), P = plans();
    P.forEach(x=>{ x.stops = (x.stops||[]).filter(id=>sites[id]); });
    if(!MV.plan || !planOf(MV.plan)) MV.plan = P[0] ? P[0].id : null;
    const p = planOf(MV.plan), noLL = all.filter(s=>!ll(s));
    const routed = new Set(P.flatMap(x=>x.stops));
    const legend = (MV.colour==='job' ? JOB_ST : STATUSES).map(x=>`<span><i style="background:${x[2]}"></i>${esc(x[1])}</span>`).join('');
    const rs = p ? routeStats(p) : null, links = p ? mapsLinks(p) : [];
    box.innerHTML = `<div class="pf-mapgrid">
      <section class="card pf-bigmap"><div class="pf-maptools">
          <div class="seg" id="mvColour"><button type="button" data-c="survey" class="${MV.colour==='survey'?'on':''}">Survey</button><button type="button" data-c="job" class="${MV.colour==='job'?'on':''}">Job</button></div>
          <select id="mvShow"><option value="all" ${MV.show==='all'?'selected':''}>All properties</option><option value="free" ${MV.show==='free'?'selected':''}>Not in a route yet</option><option value="visit" ${MV.show==='visit'?'selected':''}>Site visit needed</option><option value="notdone" ${MV.show==='notdone'?'selected':''}>Job not completed</option></select>
          <span class="hint" style="margin:0">${p ? 'Click a pin to add it to or remove it from <b>' + esc(p.name) + '</b>.' : 'Make a route, then click pins to add them.'}</span></div>
        <div id="mvMap" class="pf-mvmap"><p class="hint" style="padding:16px">Loading map…</p></div>
        <div class="pf-legend">${legend}<span><i class="base"></i>Start</span></div>
        ${noLL.length ? `<p class="note w" style="margin:10px 0 0">${noLL.length} propert${noLL.length>1?'ies are':'y is'} not on the map yet (${noLL.slice(0,4).map(s=>esc(s.name||s.address)).join(', ')}${noLL.length>4?'…':''}). <button class="btn sm" type="button" id="mvFind">Find on map</button></p>` : ''}
      </section>
      <div class="pf-routes">
        <section class="card"><h3 style="margin-top:0">Start &amp; finish</h3>
          <div class="fields one"><label class="f">Start from<input id="mvStart" value="${esc(st.planStart || BASE_ADDR)}"></label></div>
          <label class="ck" style="margin-top:8px"><input type="checkbox" id="mvReturn" ${st.planReturn!==false?'checked':''}>Return to the start at the end of the day</label>
        </section>
        <section class="card"><div class="pf-maphead"><h3 style="margin:0">Routes</h3><span class="hint" style="margin:0">${routed.size} of ${all.length} properties planned</span></div>
          ${P.length ? `<div class="pf-rtabs">${P.map(x=>`<button type="button" data-plan="${x.id}" class="${x.id===MV.plan?'on':''}">${esc(x.name)}<small>${x.stops.length}${x.date?' · '+fmtD(x.date).replace(/ \d{4}$/,''):''}</small></button>`).join('')}</div>` : '<p class="hint">No routes yet.</p>'}
          <div class="pf-tools" style="margin-top:10px"><button class="btn sm" type="button" id="mvNew">+ New route</button><button class="btn sm" type="button" id="mvAuto">Suggest routes…</button></div>
          <div id="mvAutoBox" hidden class="pf-autobox"><p class="hint" style="margin-top:0">Splits every property not yet in a route into days, keeping each day's properties close together.</p>
            <div class="fields"><label class="f">Properties per day<input type="number" id="mvPer" min="1" max="40" value="${esc(st.planPer || 10)}"></label><label class="f">First day<input type="date" id="mvFirst"></label></div>
            <label class="ck" style="margin-top:6px"><input type="checkbox" id="mvWeekdays" checked>Weekdays only</label>
            <div class="pf-tools" style="margin-top:8px"><span style="flex:1"></span><button class="btn pri sm" type="button" id="mvAutoGo">Make routes</button></div></div>
        </section>
        ${p ? `<section class="card pf-route">
          <div class="fields"><label class="f">Route name<input id="mvName" value="${esc(p.name)}"></label><label class="f">Date<input type="date" id="mvDate" value="${esc(p.date||'')}"></label></div>
          <div class="pf-rstats">
            <div><b>${p.stops.length}</b><span>Stops</span></div><div><b>${rs.miles.toFixed(1)}</b><span>Miles approx.</span></div>
            <div><b>${hm(rs.drive)}</b><span>Driving approx.</span></div><div><b>${rs.work ? hm(rs.work) : '–'}</b><span>On site</span></div>
          </div>
          ${rs.work ? `<p class="hint" style="margin:6px 0 0">About ${hm(rs.total)} in total – ${rs.total > R.dayHours ? `<b style="color:var(--warn)">over a ${R.dayHours} h day</b>` : `fits a ${R.dayHours} h day`}. On-site time comes from each property's survey.</p>` : `<p class="hint" style="margin:6px 0 0">On-site time appears once properties have gutter lengths.</p>`}
          <ol class="pf-stops">${p.stops.map((id,i)=>{ const s = sites[id]; if(!s) return ''; return `<li><span class="pf-sn">${i+1}</span><div><b>${esc(s.ref)}. ${esc(s.name||s.address)}</b><small>${esc(s.postcode||'')}${s.data.keyholder?' · '+esc(s.data.keyholder):''}</small></div><span class="pf-sbtn"><button type="button" data-up="${i}" ${i?'':'disabled'} title="Move up">↑</button><button type="button" data-down="${i}" ${i<p.stops.length-1?'':'disabled'} title="Move down">↓</button><button type="button" data-open="${id}" title="Open property">↗</button><button type="button" data-out="${i}" title="Take out of route">×</button></span></li>`; }).join('') || '<p class="hint">Click pins on the map to add properties.</p>'}</ol>
          <div class="pf-tools" style="margin-top:10px">
            <button class="btn sm" type="button" id="mvBest" ${p.stops.length>1?'':'disabled'}>Best order</button>
            <button class="btn sm" type="button" id="mvRev" ${p.stops.length>1?'':'disabled'}>Reverse</button>
            <button class="btn sm" type="button" id="mvCopy" ${p.stops.length?'':'disabled'}>Copy list</button>
            <span style="flex:1"></span><button class="btn sm del" type="button" id="mvDel">Delete route</button></div>
          ${links.length ? `<div class="pf-tools" style="margin-top:8px">${links.map((u,i)=>`<a class="btn pri sm" href="${esc(u)}" target="_blank" rel="noopener">Open in Google Maps${links.length>1?` (part ${i+1} of ${links.length})`:''}</a>`).join('')}</div>${links.length>1?'<p class="hint" style="margin:6px 0 0">Google Maps takes up to 9 stops per link, so longer routes are split into parts.</p>':''}` : ''}
        </section>` : ''}
      </div></div>`;
    bindMap(box, p);
    drawMap(p);
  }
  function bindMap(box, p){
    const st = ST(), save = () => { savePortfolio(300); };
    box.querySelectorAll('#mvColour button').forEach(b=> b.onclick = ()=>{ MV.colour = b.dataset.c; render(); });
    $('mvShow').onchange = e=>{ MV.show = e.target.value; render(); };
    $('mvStart').onchange = async e=>{ st.planStart = e.target.value.trim(); st.planStartLL = null; save(); await ensureStart(); render(); };
    $('mvReturn').onchange = e=>{ st.planReturn = e.target.checked; save(); render(); };
    box.querySelectorAll('[data-plan]').forEach(b=> b.onclick = ()=>{ MV.plan = b.dataset.plan; render(); });
    $('mvNew').onclick = ()=>{ const P = plans(); const n = {id:'r'+Date.now().toString(36), name:`Day ${P.length+1}`, date:'', stops:[]}; P.push(n); MV.plan = n.id; save(); render(); };
    $('mvAuto').onclick = ()=>{ const b = $('mvAutoBox'); b.hidden = !b.hidden; };
    $('mvAutoGo').onclick = ()=>{
      const per = Math.max(1, Math.min(40, Math.round(num($('mvPer').value)) || 10)); st.planPer = per;
      const routed = new Set(plans().flatMap(x=>x.stops));
      const free = sorted().filter(s=>!routed.has(s.id) && ll(s) && s.data.include!==false && s.data.status!=='noquote' && s.data.job.status!=='done' && s.data.job.status!=='na').map(s=>s.id);
      if(!free.length){ flash('Every property is already in a route'); return; }
      const order = bestOrder(free, startLL(), false);
      let day = $('mvFirst').value ? new Date($('mvFirst').value + 'T12:00:00') : null; const wk = $('mvWeekdays').checked;
      const nextDay = d => { const n = new Date(d.getTime() + 864e5); if(wk) while(n.getDay()===0 || n.getDay()===6) n.setTime(n.getTime() + 864e5); return n; };
      if(day && wk) while(day.getDay()===0 || day.getDay()===6) day.setTime(day.getTime() + 864e5);
      const P = plans(); let made = 0, firstId = null;
      for(let i=0;i<order.length;i+=per){
        const stops = bestOrder(order.slice(i, i+per), startLL(), st.planReturn!==false);
        const n = {id:'r'+Date.now().toString(36)+i, name:`Day ${P.length+1}`, date: day ? day.toISOString().slice(0,10) : '', stops};
        P.push(n); made++; if(!firstId) firstId = n.id; if(day) day = nextDay(day);
      }
      MV.plan = firstId; save(); render(); flash(`${made} route${made>1?'s':''} made for ${order.length} properties`);
    };
    const f = $('mvFind'); if(f) f.onclick = async ()=>{
      f.disabled = true; f.textContent = 'Finding…'; let n = 0;
      try{ await MEASURE.loadGoogle(); const g = new google.maps.Geocoder();
        for(const s of sorted().filter(x=>!ll(x))){ const q = [s.address, s.postcode].filter(Boolean).join(', '); if(!q) continue;
          try{ const {results} = await g.geocode({address:q, region:'gb'}); if(results && results[0]){ const l = results[0].geometry.location; s.lat = l.lat(); s.lng = l.lng(); saveSite(s, 0); n++; } }catch(e){} }
      }catch(e){ flash(e.message||String(e)); }
      flash(n ? `${n} found` : 'None could be found – check the addresses'); render();
    };
    if(!p) return;
    $('mvName').oninput = e=>{ p.name = e.target.value || 'Route'; save(); };
    $('mvName').onchange = ()=> render();
    $('mvDate').onchange = e=>{ p.date = e.target.value; save(); render(); };
    box.querySelectorAll('[data-up]').forEach(b=> b.onclick = ()=>{ const i = +b.dataset.up; [p.stops[i-1], p.stops[i]] = [p.stops[i], p.stops[i-1]]; save(); render(); });
    box.querySelectorAll('[data-down]').forEach(b=> b.onclick = ()=>{ const i = +b.dataset.down; [p.stops[i+1], p.stops[i]] = [p.stops[i], p.stops[i+1]]; save(); render(); });
    box.querySelectorAll('[data-out]').forEach(b=> b.onclick = ()=>{ p.stops.splice(+b.dataset.out, 1); save(); render(); });
    box.querySelectorAll('[data-open]').forEach(b=> b.onclick = ()=>{ siteId = b.dataset.open; tab = 'site'; render(); window.scrollTo(0,0); });
    $('mvBest').onclick = ()=>{ p.stops = bestOrder(p.stops, startLL(), st.planReturn!==false); save(); render(); flash('Stops put in the shortest order'); };
    $('mvRev').onclick = ()=>{ p.stops.reverse(); save(); render(); };
    $('mvCopy').onclick = async ()=>{
      const t = `${p.name}${p.date?' – '+fmtD(p.date):''}\nStart: ${st.planStart||BASE_ADDR}\n` + p.stops.map((id,i)=>{ const s = sites[id]; return `${i+1}. ${s.name||s.address} – ${s.address}${s.postcode?', '+s.postcode:''}${s.data.keyholder?' (key: '+s.data.keyholder+')':''}`; }).join('\n');
      try{ await navigator.clipboard.writeText(t); flash('Copied'); }catch(e){ flash('Copy was blocked by the browser'); }
    };
    $('mvDel').onclick = ()=>{
      if(!confirmInline('mvDel'+p.id, `Press Delete route again to delete ${p.name}. The properties stay in the portfolio.`)) return;
      const P = plans(); P.splice(P.indexOf(p), 1); MV.plan = P[0] ? P[0].id : null; save(); render();
    };
  }
  async function ensureStart(){
    const st = ST(); if(startLL()) return startLL();
    try{ await MEASURE.loadGoogle(); const {results} = await new google.maps.Geocoder().geocode({address:st.planStart || BASE_ADDR, region:'gb'});
      if(results && results[0]){ st.planStartLL = results[0].geometry.location.toJSON(); savePortfolio(300); }
      else flash('Start address not found on the map');
    }catch(e){}
    return startLL();
  }
  async function drawMap(p){
    try{
      if(typeof MEASURE==='undefined' || !MEASURE.loadGoogle) throw new Error('Google Maps is not available');
      await MEASURE.loadGoogle(); await ensureStart();
      const el = $('mvMap'); if(!el) return;
      const keep = MV.map && MV.mapEl === el ? null : (MV.view || null);
      MV.map = new google.maps.Map(el, {center:{lat:53.745, lng:-0.40}, zoom:11, mapTypeId:'roadmap', mapTypeControl:true, mapTypeControlOptions:{mapTypeIds:['roadmap','hybrid']}, streetViewControl:false, fullscreenControl:true, clickableIcons:false, gestureHandling:'greedy'});
      MV.mapEl = el;
      const routedBy = {}; plans().forEach(x=>x.stops.forEach((id,i)=>routedBy[id] = {plan:x, i}));
      const bounds = new google.maps.LatLngBounds(); let any = false;
      sorted().forEach(s=>{
        const pos = ll(s); if(!pos) return;
        const r = routedBy[s.id], inThis = p && r && r.plan.id===p.id;
        const show = MV.show==='all' || inThis || (MV.show==='free' && !r) || (MV.show==='visit' && s.data.status==='visit') || (MV.show==='notdone' && s.data.job.status!=='done');
        if(!show) return;
        const col = MV.colour==='job' ? jobOf(s.data.job.status)[2] : statusOf(s.data.status)[2];
        const dim = p && r && !inThis;
        const m = new google.maps.Marker({position:pos, map:MV.map, zIndex: inThis ? 1000 : 10,
          label:{text: inThis ? String(r.i+1) : String(s.ref), color: inThis ? '#fff' : '#132f47', fontSize:'11px', fontWeight:'700'},
          icon:{path:google.maps.SymbolPath.CIRCLE, scale: inThis ? 13 : 11, fillColor: inThis ? '#132f47' : col, fillOpacity: dim ? .45 : 1, strokeColor: inThis ? col : '#fff', strokeWeight: inThis ? 4 : 2},
          title:`${s.ref}. ${s.name||s.address}\n${statusOf(s.data.status)[1]} · Job: ${jobOf(s.data.job.status)[1]}${r?`\nIn ${r.plan.name} (stop ${r.i+1})`:''}${p?`\nClick to ${inThis?'take out of':'add to'} ${p.name}`:''}`});
        m.addListener('click', ()=>{
          if(!p){ flash('Make a route first, then click pins to add them'); return; }
          if(inThis) p.stops.splice(p.stops.indexOf(s.id), 1);
          else { if(r){ r.plan.stops.splice(r.plan.stops.indexOf(s.id), 1); flash(`Moved from ${r.plan.name}`); } p.stops.push(s.id); }
          MV.view = {c:MV.map.getCenter().toJSON(), z:MV.map.getZoom()}; savePortfolio(300); render();
        });
        bounds.extend(pos); any = true;
      });
      const start = startLL();
      if(start){ new google.maps.Marker({position:start, map:MV.map, zIndex:2000, title:'Start: ' + (ST().planStart||BASE_ADDR),
        icon:{path:'M 0,-14 L 4,-4 14,-4 6,3 9,13 0,7 -9,13 -6,3 -14,-4 -4,-4 z', fillColor:'#C98A12', fillOpacity:1, strokeColor:'#fff', strokeWeight:2, scale:1}}); bounds.extend(start); }
      if(p && p.stops.length){
        const path = [...(start?[start]:[]), ...p.stops.map(id=>ll(sites[id])).filter(Boolean), ...(start && ST().planReturn!==false ? [start] : [])];
        new google.maps.Polyline({path, map:MV.map, strokeColor:'#132f47', strokeOpacity:.85, strokeWeight:3, icons:[{icon:{path:google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale:2.5, strokeColor:'#132f47'}, offset:'50%', repeat:'90px'}]});
      }
      if(MV.view){ MV.map.setCenter(MV.view.c); MV.map.setZoom(MV.view.z); }
      else if(any) MV.map.fitBounds(bounds, 40);
      MV.map.addListener('idle', ()=>{ MV.view = {c:MV.map.getCenter().toJSON(), z:MV.map.getZoom()}; });
    }catch(e){ const el = $('mvMap'); if(el) el.innerHTML = `<p class="note b" style="margin:16px">${esc(e.message||String(e))}</p>`; }
  }

  /* ---------- customer quote ---------- */
  function quoteHTML(opts={}){
    const P = portfolioTotals(), st = S(), today = new Date(), valid = new Date(today.getTime() + num(st.validDays||30)*864e5);
    const fmt = d => d.toLocaleDateString('en-GB', {day:'numeric', month:'long', year:'numeric'});
    const freqL = (FREQ[st.freq]||FREQ.once)[0];
    const okImg = i => i && src(i) && (!st.onlyReviewed || i.reviewed);
    const acc = s => ACCESS.filter(a=>s.data.access[a[0]]).map(a=>a[1].split(' –')[0]);
    return `
    <div class="pf-q-band"><div><img src="brand/logo-light.png" alt="Purgō" style="height:44px"><div class="pf-q-sub">Exterior cleaning · Hull & East Yorkshire</div></div>
      <div class="pf-q-meta"><b>Quotation</b>Ref ${esc(st.quoteRef||'')}<br>${fmt(today)}<br>Valid until ${fmt(valid)}</div></div>
    <div class="pf-q-body">
      <div class="pf-q-two"><div><h3>Prepared for</h3><p><b>${esc(cur.client||'')}</b>${cur.contact?'<br>'+esc(cur.contact):''}${cur.email?'<br>'+esc(cur.email):''}</p></div>
        <div><h3>Service</h3><p><b>Gutter clearance – ${P.priced.length} managed properties</b><br>${esc(freqL)}</p></div></div>
      <p>${esc(st.intro || 'Thank you for the opportunity to quote for gutter clearance across your portfolio. Each property has been surveyed from aerial and street-level imagery, measured, and priced individually below.')}</p>
      <h3>Scope of works – every property</h3>
      <ul><li>All gutters cleared of moss, leaves and debris using a SkyVac carbon-pole vacuum system, worked from the ground wherever possible – no ladders against your buildings</li>
        <li>Outlets and downpipes checked and flushed, so water runs freely after the clean</li>
        <li>All waste bagged and removed from site; surrounding areas left clean</li>
        <li>Before and after camera images for every property, plus a note of any defects found (cracked joints, sagging brackets, failed seals)</li>
        <li>Fully insured – £2m public liability${st.rams?'; RAMS provided for the works':'; RAMS available on request'}</li></ul>
      <h3>Property schedule</h3>
      <table class="pf-q-tbl"><thead><tr><th>#</th><th>Property</th><th>Type</th><th class="r">Storeys</th><th class="r">Gutter (m)</th>${st.showAccess?'<th>Access notes</th>':''}<th class="r">Price</th></tr></thead>
      <tbody>${P.priced.map(s=>{ const c = calc(s); return `<tr><td>${esc(s.ref)}</td><td><b>${esc(s.name||s.address)}</b><br><small>${s.name?esc(s.address)+', ':''}${esc(s.postcode||'')}</small>${s.data.notes?`<br><small>${esc(s.data.notes)}</small>`:''}</td><td>${esc(s.data.type||'')}</td><td class="r">${esc(s.data.storeys||'')}</td><td class="r">${c.m.toFixed(0)}</td>${st.showAccess?`<td><small>${esc(acc(s).join(', ')||'–')}</small></td>`:''}<td class="r"><b>${gbp(c.price)}</b></td></tr>`; }).join('') || `<tr><td colspan="7"><small>No priced properties yet – add gutter lengths on the property pages.</small></td></tr>`}</tbody></table>
      <div class="pf-q-tot">
        <div><span>Subtotal (${P.priced.length} properties)</span><b>${gbp(P.sub)}</b></div>
        ${P.disc?`<div><span>Portfolio discount ${num(st.discPct)}%</span><b>–${gbp(P.disc)}</b></div>`:''}
        ${P.rams?`<div><span>RAMS / method statement</span><b>${gbp(P.rams)}</b></div>`:''}
        ${st.vat?`<div><span>VAT ${R.vat}%</span><b>${gbp(P.vat)}</b></div>`:''}
        <div class="g"><span>Total</span><span>${gbp(P.gross)}</span></div>
        ${P.visits>1?`<div><span>${P.visits} visits per year</span><b>${gbp(P.annual)} / year</b></div>`:''}
      </div>
      ${st.showPhotos && !opts.noPhotos?`<h3>Property survey images</h3><div class="pf-q-props">${P.priced.map(s=>`<div class="pf-q-prop"><div class="imgs">${okImg(s.photos.aerial)?`<img src="${esc(src(s.photos.aerial))}" alt="">`:'<div class="no">No aerial</div>'}${okImg(s.photos.street)?`<img src="${esc(src(s.photos.street))}" alt="">`:'<div class="no">No street view</div>'}</div><div class="tx"><b>${esc(s.ref)}. ${esc(s.name||s.address)}</b><br>${calc(s).m.toFixed(0)} m gutter · ${esc(s.data.storeys||'?')} storey${num(s.data.storeys)===1?'':'s'}${s.data.method?' · '+esc(s.data.method):''}</div></div>`).join('')}</div><p class="pf-q-small">Aerial and Street View imagery © Google.</p>`:''}
      <h3>Terms</h3>
      <ul class="pf-q-small"><li>Prices are per visit and include all labour, equipment and waste removal. Quotation valid for ${num(st.validDays||30)} days.</li>
        <li>Properties may be accepted individually or as a portfolio${P.disc?`; the portfolio discount applies when ${num(st.discMin)} or more properties are booked`:''}.</li>
        <li>Where gutters need repair, we will report it with photos and quote separately – no extra work is carried out without your approval.</li>
        <li>Residents will be given notice of the visit; access to rear elevations, gates and parking is arranged through you as managing agent.</li></ul>
    </div>
    <div class="pf-q-foot"><span><b>Purgō</b> · family run exterior cleaning</span><span>07930 877034 · www.purgo-clean.com</span></div>`;
  }
  function renderQuote(box){
    const st = S();
    const fld = (k, l, type='text') => `<label class="f">${l}<input ${type==='text'?'':`type="${type}"`} data-s="${k}" value="${esc(st[k])}"></label>`;
    box.innerHTML = `
    <section class="card pf-noprint">
      <div class="fields">
        <label class="f">Client<input data-p="client" value="${esc(cur.client)}"></label>
        <label class="f">Contact name<input data-p="contact" value="${esc(cur.contact)}"></label>
        <label class="f">Contact email<input data-p="email" value="${esc(cur.email)}"></label>
        ${fld('quoteRef','Quote ref')}
        <label class="f">Frequency<select data-s="freq">${Object.entries(FREQ).map(([k,v])=>`<option value="${k}" ${st.freq===k?'selected':''}>${v[0]}</option>`).join('')}</select></label>
        <label class="f">Status<select data-p="status">${['draft','sent','accepted','declined'].map(x=>`<option ${cur.status===x?'selected':''}>${x}</option>`).join('')}</select></label>
      </div>
      <div class="checks" style="margin-top:12px">
        <label class="ck"><input type="checkbox" data-s="showPhotos" ${st.showPhotos?'checked':''}>Show survey images</label>
        <label class="ck"><input type="checkbox" data-s="onlyReviewed" ${st.onlyReviewed?'checked':''}>Only reviewed images</label>
        <label class="ck"><input type="checkbox" data-s="showAccess" ${st.showAccess?'checked':''}>Access notes column</label>
      </div>
      <label class="f" style="margin-top:12px">Intro paragraph (blank = standard wording)<textarea data-s="intro" rows="2">${esc(st.intro)}</textarea></label>
      <div class="pf-tools" style="margin-top:12px"><span class="hint" style="flex:1;margin:0">Print → Save as PDF to send it. Only properties with gutter lengths and “include” ticked appear.</span><button class="btn" type="button" id="pfCopy">Copy schedule</button><button class="btn pri" type="button" id="pfPrint">Print / save PDF</button></div>
    </section>
    <div class="pf-qdoc" id="pfQdoc">${quoteHTML()}</div>`;
    bindSettingInputs(box, ()=>{ $('pfQdoc').innerHTML = quoteHTML(); });
    $('pfPrint').onclick = ()=>{ document.body.classList.add('pf-printing'); setTimeout(()=>{ window.print(); setTimeout(()=>document.body.classList.remove('pf-printing'), 500); }, 50); };
    $('pfCopy').onclick = async ()=>{
      const P = portfolioTotals();
      const lines = ['#\tSite\tAddress\tPostcode\tType\tStoreys\tGutter (m)\tPrice', ...P.priced.map(s=>{ const c = calc(s); return [s.ref, s.name, s.address, s.postcode, s.data.type, s.data.storeys, c.m.toFixed(0), gbp(c.price)].join('\t'); }), '', `Subtotal\t\t\t\t\t\t\t${gbp(P.sub)}`];
      if(P.disc) lines.push(`Discount ${S().discPct}%\t\t\t\t\t\t\t-${gbp(P.disc)}`); if(P.rams) lines.push(`RAMS\t\t\t\t\t\t\t${gbp(P.rams)}`); if(S().vat) lines.push(`VAT\t\t\t\t\t\t\t${gbp(P.vat)}`); lines.push(`Total\t\t\t\t\t\t\t${gbp(P.gross)}`);
      try{ await navigator.clipboard.writeText(lines.join('\n')); flash('Schedule copied'); }catch(e){ flash('Copy was blocked by the browser'); }
    };
  }
  function bindSettingInputs(box, after){
    box.querySelectorAll('[data-s]').forEach(e=>{
      const ev = (e.tagName==='SELECT' || e.type==='checkbox') ? 'change' : 'input';
      e.addEventListener(ev, ()=>{ cur.settings = Object.assign({}, S()); cur.settings[e.dataset.s] = e.type==='checkbox' ? e.checked : (e.type==='number' ? num(e.value) : e.value); savePortfolio(ev==='change'?0:700); after && after(); });
    });
    box.querySelectorAll('[data-p]').forEach(e=>{
      const ev = e.tagName==='SELECT' ? 'change' : 'input';
      e.addEventListener(ev, ()=>{ cur[e.dataset.p] = e.value; savePortfolio(ev==='change'?0:700); after && after(); });
    });
  }

  /* ---------- customer access ---------- */
  async function fn(body){
    const {data, error} = await sb.functions.invoke('customer-accounts', {body});
    if(error){ let m = error.message; try{ const j = await error.context.json(); if(j && j.error) m = j.error; }catch(e){} throw new Error(m); }
    if(data && data.error) throw new Error(data.error);
    return data;
  }
  let custCache = null, lastLogin = null;
  function loginText(l){ return `Your Purgō customer login\n\nWebsite: ${location.origin}\nEmail: ${l.email}\nPassword: ${l.password}\n\nSign in to see progress, photos and reports for ${cur.client||cur.name}. You can change your password after signing in.`; }
  function savePortfolioFiles(){ queue('pf:'+cur.id, async ()=>{ const {error} = await sb.from('portfolios').update({files:cur.files}).eq('id', cur.id); if(error) throw error; }, 0); }
  function renderCustomer(box){
    cur.files = Array.isArray(cur.files) ? cur.files : [];
    const all = sorted(), job = all.filter(inJob);
    const shownPh = job.reduce((a,s)=>a+s.photos.job.filter(p=>p.share).length, 0), allPh = job.reduce((a,s)=>a+s.photos.job.length, 0);
    const reps = job.filter(s=>s.data.job.shareReport).length, done = job.filter(s=>s.data.job.status==='done').length;
    const q = cur.customer_quote;
    box.innerHTML = `<div class="pf-set">
      <section class="card"><h2>What the customer sees</h2>
        <p class="hint">Customers sign in at <b>${esc(location.origin)}</b> with their own login and see only this portfolio: each property's job status and dates, the reports you tick, the job photos and files you tick, portfolio documents you tick, and the quote once you share it. They never see survey status, internal notes, access notes, price workings or anything unticked.</p>
        <div class="pf-stats" style="margin:12px 0 4px">
          <div class="stat"><span>Properties in the job</span><b>${job.length}</b></div>
          <div class="stat"><span>Completed</span><b>${done} <small>of ${job.length}</small></b></div>
          <div class="stat"><span>Photos shown</span><b>${shownPh} <small>of ${allPh}</small></b></div>
          <div class="stat"><span>Reports shown</span><b>${reps}</b></div>
          <div class="stat"><span>Quote</span><b style="font-size:.9rem">${q?'Shared':'Not shared'}</b></div>
        </div>
        <p class="hint">Properties marked <b>Not in this job</b>, excluded from the quote, or not ticked to include are hidden from the customer.</p>
        <div class="pf-tools" style="margin-top:10px"><span style="flex:1"></span><button class="btn pri" type="button" id="pfPreview">Preview as the customer</button></div>
      </section>
      <section class="card"><h2>Customer logins</h2>
        ${ROLE==='admin' ? `
        <div id="pfCustList"><p class="hint">Loading…</p></div>
        <h3>Add a login</h3>
        <div class="fields"><label class="f">Name<input id="pfCuName" placeholder="e.g. Sarah Jones"></label><label class="f">Email<input id="pfCuEmail" type="email" placeholder="sarah@pureblock.co.uk"></label></div>
        <div class="pf-tools" style="margin-top:10px"><span class="hint" style="flex:1;margin:0">Makes a login with a temporary password for you to send them. Someone who already has a customer login is just given access to this portfolio too.</span><button class="btn pri" type="button" id="pfCuAdd">Create login</button></div>
        <div id="pfCuNew"></div>` : `<p class="note w">Only an admin can add or remove customer logins.</p>`}
      </section>
      <section class="card"><h2>Quote shown to the customer</h2>
        <p class="hint">${q ? `Shared on ${fmtD(q.publishedAt)}${q.publishedBy?' by '+esc(q.publishedBy):''}. The customer sees that version until you share it again – later price changes don't reach them on their own.` : 'Not shared. When you share it, the customer sees the quote as it stands now (without the survey images).'}</p>
        <div class="pf-tools" style="margin-top:10px"><span style="flex:1"></span>${q?`<button class="btn" type="button" id="pfQUn">Stop sharing</button>`:''}<button class="btn pri" type="button" id="pfQPub">${q?'Share the current quote again':'Share the quote'}</button></div>
      </section>
      <section class="card"><h2>Portfolio documents</h2>
        <p class="hint">For the whole portfolio – RAMS, insurance certificate, a summary report. Files for one property go on that property's page.</p>
        <div class="pf-files">${cur.files.map((f,ix)=>fileRow(f, `data-psh="${ix}"`, `data-prm="${ix}"`)).join('') || '<p class="hint" style="margin:0">None yet.</p>'}</div>
        <div class="pf-lenbar"><button class="btn sm" type="button" id="pfPAdd">+ Add document</button><input type="file" id="pfPFile" accept="application/pdf,image/*" multiple hidden></div>
      </section></div>`;
    $('pfPreview').onclick = ()=>{ if(typeof PORTAL==='undefined'){ flash('Customer view is not available'); return; } PORTAL.preview(cur.id); };
    $('pfQPub').onclick = async ()=>{
      const rec = {html:quoteHTML({noPhotos:true}), publishedAt:new Date().toISOString(), publishedBy:ME.name};
      const {error} = await sb.from('portfolios').update({customer_quote:rec}).eq('id', cur.id);
      if(error){ flash('Not shared: ' + error.message); return; }
      cur.customer_quote = rec; render(); flash('The customer can now see the quote');
    };
    const un = $('pfQUn'); if(un) un.onclick = async ()=>{
      if(!confirmInline('pfQUn', 'Press Stop sharing again to hide the quote from the customer.')) return;
      const {error} = await sb.from('portfolios').update({customer_quote:null}).eq('id', cur.id);
      if(error){ flash('Not changed: ' + error.message); return; }
      cur.customer_quote = null; render(); flash('Quote hidden from the customer');
    };
    $('pfPAdd').onclick = ()=>{ const f = $('pfPFile'); f.value = ''; f.click(); };
    $('pfPFile').onchange = async e=>{
      let n = 0; for(const f of [...e.target.files]){ try{ cur.files.push(await uploadFile('_portfolio', f)); n++; }catch(x){ flash('Upload failed: ' + (x.message||x)); } }
      if(n){ savePortfolioFiles(); render(); flash(n>1?`${n} documents added`:'Document added'); }
    };
    box.querySelectorAll('[data-psh]').forEach(b=> b.onclick = ()=> toggleShare(null, cur.files[+b.dataset.psh], savePortfolioFiles));
    box.querySelectorAll('[data-prm]').forEach(b=> b.onclick = ()=>{
      const f = cur.files[+b.dataset.prm]; if(!f || !confirmInline('pfPrm'+f.path, 'Press again to remove this document.')) return;
      cur.files.splice(+b.dataset.prm, 1); savePortfolioFiles(); sb.storage.from(BUCKET).remove([f.path]).catch(()=>{}); render(); flash('Document removed');
    });
    if(ROLE!=='admin') return;
    if(lastLogin && lastLogin.pid===cur.id) showNewLogin(lastLogin);
    loadCustomers();
    $('pfCuAdd').onclick = async ()=>{
      const name = $('pfCuName').value.trim(), email = $('pfCuEmail').value.trim();
      if(!email){ flash('Enter their email address'); return; }
      const b = $('pfCuAdd'); b.disabled = true; b.textContent = 'Creating…';
      try{
        const r = await fn({action:'create', portfolioId:cur.id, email, name});
        if(r.password){ lastLogin = {pid:cur.id, email:email.toLowerCase(), password:r.password, name}; showNewLogin(lastLogin); flash('Login created'); }
        else { lastLogin = null; $('pfCuNew').innerHTML = `<p class="note g">${esc(email)} already had a customer login. They can now see this portfolio too with their existing password.</p>`; flash('Access added'); }
        $('pfCuName').value = ''; $('pfCuEmail').value = ''; loadCustomers();
      }catch(e){ flash(e.message); $('pfCuNew').innerHTML = `<p class="note b">${esc(e.message)}</p>`; }
      b.disabled = false; b.textContent = 'Create login';
    };
  }
  function showNewLogin(l){
    const el = $('pfCuNew'); if(!el) return;
    el.innerHTML = `<div class="pf-login"><b>Send these details to ${esc(l.name||l.email)}</b><pre>${esc(loginText(l))}</pre><p class="hint" style="margin:6px 0 0">The password is only shown now. If it gets lost, press <b>New password</b> next to their name.</p>
      <div class="pf-tools" style="margin-top:8px"><span style="flex:1"></span>${l.email?`<a class="btn" href="mailto:${esc(l.email)}?subject=${encodeURIComponent('Your Purgō customer login')}&body=${encodeURIComponent(loginText(l))}">Open in email</a>`:''}<button class="btn pri" type="button" id="pfCuCopy">Copy</button></div></div>`;
    $('pfCuCopy').onclick = async ()=>{ try{ await navigator.clipboard.writeText(loginText(l)); flash('Copied'); }catch(e){ flash('Copy was blocked by the browser'); } };
  }
  async function loadCustomers(){
    const el = $('pfCustList'); if(!el) return;
    try{
      const r = await fn({action:'list', portfolioId:cur.id}); custCache = r.customers || [];
      if(!$('pfCustList')) return;
      $('pfCustList').innerHTML = custCache.length ? `<div class="qlist">${custCache.map(c=>`<div class="qitem"><div class="m"><b>${esc(c.name||c.email)}</b><small>${esc(c.email)}${c.active?'':' · switched off'}</small><small>${c.lastSignIn?'Last signed in '+fmtD(c.lastSignIn):'Not signed in yet'} · added ${fmtD(c.added)}${c.addedBy?' by '+esc(c.addedBy):''}</small></div><span></span><div class="qacts"><button class="btn sm" type="button" data-cureset="${c.userId}">New password</button><button class="btn sm del" type="button" data-curm="${c.userId}">Remove</button></div></div>`).join('')}</div>` : '<p class="hint">No customer logins yet.</p>';
      $('pfCustList').querySelectorAll('[data-cureset]').forEach(b=> b.onclick = async ()=>{
        const c = custCache.find(x=>x.userId===b.dataset.cureset);
        if(!confirmInline('cur'+c.userId, `Press New password again to replace ${c.name||c.email}'s password.`)) return;
        try{ const r = await fn({action:'reset', userId:c.userId}); lastLogin = {pid:cur.id, email:c.email, password:r.password, name:c.name}; showNewLogin(lastLogin); flash('New password made'); }catch(e){ flash(e.message); }
      });
      $('pfCustList').querySelectorAll('[data-curm]').forEach(b=> b.onclick = async ()=>{
        const c = custCache.find(x=>x.userId===b.dataset.curm);
        if(!confirmInline('curm'+c.userId, `Press Remove again to stop ${c.name||c.email} seeing this portfolio.`)) return;
        try{ const r = await fn({action:'remove', portfolioId:cur.id, userId:c.userId}); flash(r.switchedOff ? 'Removed – their login is switched off' : 'Removed from this portfolio'); loadCustomers(); }catch(e){ flash(e.message); }
      });
    }catch(e){ if($('pfCustList')) $('pfCustList').innerHTML = `<p class="note b">Could not load customer logins: ${esc(e.message)}</p>`; }
  }

  /* ---------- settings & import ---------- */
  function renderSettings(box){
    const st = S();
    box.innerHTML = `<div class="pf-set">
      <section class="card"><h2>Portfolio</h2><div class="fields" style="margin-top:12px">
        <label class="f wide">Name<input data-p="name" value="${esc(cur.name)}"></label>
        <label class="f wide">Client<input data-p="client" value="${esc(cur.client)}"></label>
      </div>
      <h3>Pricing for this portfolio</h3>
      <div class="fields">
        <label class="f">Crew on site<input type="number" min="1" max="6" data-s="crew" value="${esc(st.crew)}"></label>
        <label class="f">Portfolio discount %<input type="number" step="0.5" min="0" data-s="discPct" value="${esc(st.discPct)}"></label>
        <label class="f">…from this many properties<input type="number" min="0" data-s="discMin" value="${esc(st.discMin)}"></label>
        <label class="f">MEWP hire £ per site<input type="number" min="0" data-s="mewpDay" value="${esc(st.mewpDay)}"></label>
        <label class="f">Quote valid (days)<input type="number" min="1" data-s="validDays" value="${esc(st.validDays)}"></label>
      </div>
      <div class="checks" style="margin-top:12px">
        <label class="ck"><input type="checkbox" data-s="vat" ${st.vat?'checked':''}>Charge VAT (${R.vat}%)</label>
        <label class="ck"><input type="checkbox" data-s="rams" ${st.rams?'checked':''}>RAMS charge once (${gbp(R.rams)})</label>
        <label class="ck"><input type="checkbox" data-s="condHeavy" ${st.condHeavy!==false?'checked':''}>Heavy / vegetation adds blockage time (+${R.cx_gtHeavy}h)</label>
      </div>
      <p class="hint">Gutter £/m, minimum, set-up, guard price, labour rate and access hours all come from the shared price list (Admin). Change them there and every portfolio updates.</p>
      ${ROLE==='admin'?`<div style="margin-top:14px;text-align:right"><button class="btn sm" type="button" id="pfDelP" style="color:var(--bad)">Delete this portfolio</button></div>`:''}
      </section>
      <section class="card"><h2>Import addresses</h2>
        <p class="hint">One property per line – from Excel, an email or a PDF. Postcodes are picked out automatically. Two columns from Excel (site name · address) also work.</p>
        <textarea id="pfImp" rows="9" placeholder="Bloomsbury Court&#9;1-8 Bloomsbury Court, Hull, HU3 1AL"></textarea>
        <div class="pf-tools" style="margin-top:8px"><span class="hint" id="pfImpN" style="flex:1;margin:0"></span><button class="btn pri" type="button" id="pfImpGo">Add to portfolio</button></div>
      </section>
      <section class="card"><h2>Import photos</h2>
        <p class="hint">Pick many images at once. Files named with the property number and type – e.g. <b>07_aerial.jpg</b>, <b>07_street.jpg</b>, <b>07_site_1.jpg</b> – go straight onto that property. Job photos: <b>07_before_1.jpg</b>, <b>07_after_1.jpg</b> (hidden from the customer until ticked).</p>
        <input type="file" id="pfImgImp" accept="image/*" multiple>
        <p class="hint" id="pfImgMsg"></p>
      </section>
      <section class="card"><h2>Retake survey images from Google</h2>
        <p class="hint">Replaces the saved aerial and Street View images with fresh ones taken at each property's current pin – useful after moving a pin. Reviewed images are left alone unless you tick the box.</p>
        <div class="fields"><label class="f wide">Property numbers<input id="pfGRefs" placeholder="e.g. 6, 9, 11 – or leave blank for all"></label></div>
        <div class="pf-tools" style="margin-top:8px"><label class="ck"><input type="checkbox" id="pfGA" checked>Aerial</label><label class="ck"><input type="checkbox" id="pfGS" checked>Street View</label><label class="ck"><input type="checkbox" id="pfGRev">Include reviewed images</label><span style="flex:1"></span><button class="btn pri" type="button" id="pfGGo">Retake images</button></div>
        <p class="hint" id="pfGMsg"></p>
      </section></div>`;
    bindSettingInputs(box, ()=>{});
    const imp = $('pfImp'); imp.oninput = ()=>{ const n = parseImport(imp.value).length; $('pfImpN').textContent = n ? `${n} found` : ''; };
    $('pfImpGo').onclick = async ()=>{
      const rows = parseImport(imp.value); if(!rows.length){ flash('Nothing to import'); return; }
      const have = new Set(Object.values(sites).map(s=>(s.address+s.postcode).toLowerCase().replace(/\W/g,'')));
      let ref = Math.max(0, ...Object.values(sites).map(s=>num(s.ref)));
      const ins = rows.filter(r=>{ const k = (r.address+r.postcode).toLowerCase().replace(/\W/g,''); if(have.has(k)) return false; have.add(k); return true; })
        .map(r=>({portfolio_id:cur.id, ref:++ref, name:r.name, address:r.address, postcode:r.postcode, data:{status:'todo'}, updated_by_name:ME.name}));
      if(!ins.length){ flash('All of those are already in the portfolio'); return; }
      const {data, error} = await sb.from('portfolio_sites').insert(ins).select('*');
      if(error){ flash('Could not import: ' + error.message); return; }
      (data||[]).forEach(s=>{ siteData(s); sites[s.id] = s; }); imp.value = ''; flash(`${data.length} properties added`); tab = 'summary'; render();
    };
    $('pfGGo').onclick = async ()=>{
      const want = $('pfGRefs').value.split(/[^0-9]+/).filter(Boolean).map(Number), kinds = [...($('pfGA').checked?['aerial']:[]), ...($('pfGS').checked?['street']:[])];
      if(!kinds.length){ flash('Tick Aerial and/or Street View'); return; }
      const list = sorted().filter(s=>!want.length || want.includes(num(s.ref))); if(!list.length){ flash('No properties with those numbers'); return; }
      const btn = $('pfGGo'), msg = $('pfGMsg'), inc = $('pfGRev').checked; btn.disabled = true; let ok = 0; const fails = [];
      for(let i=0;i<list.length;i++){ const s = list[i];
        for(const k of kinds){
          if(!inc && s.photos[k] && s.photos[k].reviewed) continue;
          msg.textContent = `Property ${s.ref} (${i+1} of ${list.length})…`;
          try{ await takeGoogle(s, k); ok++; }catch(x){ fails.push(`${s.ref} ${k==='aerial'?'aerial':'street'}: ${x.message}`); if(/refused/.test(x.message)) break; }
        }
        if(fails.length && /refused/.test(fails[fails.length-1])) break;
      }
      btn.disabled = false;
      msg.innerHTML = `${ok} image${ok===1?'':'s'} updated.` + (fails.length ? `<br>Not updated: ${fails.slice(0,8).map(esc).join('<br>')}${fails.length>8?'<br>…':''}` : '');
    };
    $('pfImgImp').onchange = async e=>{
      const files = [...e.target.files]; const msg = $('pfImgMsg'); let ok = 0, skip = [];
      const byRef = {}; Object.values(sites).forEach(s=>byRef[num(s.ref)] = s);
      for(let i=0;i<files.length;i++){
        const f = files[i], m = f.name.match(/(\d+)[ _-]*(aerial|street|site|before|after)/i);
        const s = m && byRef[+m[1]]; if(!s){ skip.push(f.name); continue; }
        msg.textContent = `Uploading ${i+1} of ${files.length}…`;
        ok += await addImages(s, m[2].toLowerCase(), [f], true);
      }
      msg.textContent = `${ok} image${ok===1?'':'s'} added.` + (skip.length ? ` Skipped ${skip.length} (no matching property number): ${skip.slice(0,5).join(', ')}${skip.length>5?'…':''}` : '');
      e.target.value = '';
    };
    const dp = $('pfDelP'); if(dp) dp.onclick = async ()=>{
      if(!confirmInline('pfDelP', 'Press Delete this portfolio again to delete it, all its properties and photos.')) return;
      const paths = [...Object.values(sites).flatMap(s=>allFiles(s).map(x=>x.path)), ...(cur.files||[]).map(x=>x.path)].filter(Boolean);
      const {error} = await sb.from('portfolios').delete().eq('id', cur.id); if(error){ flash('Could not delete: ' + error.message); return; }
      for(let i=0;i<paths.length;i+=100) await sb.storage.from(BUCKET).remove(paths.slice(i,i+100)).catch(()=>{});
      try{ sessionStorage.removeItem('pfCur'); }catch(x){} flash('Portfolio deleted'); await loadList(); renderList();
    };
  }
  function parseImport(text){
    const pcRe = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
    return text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !/^(sites?|address)\s*(\t|$)/i.test(l)).map(l=>{
      const parts = l.split('\t').map(x=>x.trim()).filter(Boolean);
      let name = '', line = parts.join(', ');
      if(parts.length>=2 && !pcRe.test(parts[0])){ name = parts[0]; line = parts.slice(1).join(', '); }
      line = line.replace(/^\s*\d+[.)]\s+/, '').replace(/\s+/g,' ');
      let postcode = ''; const m = line.match(pcRe);
      if(m){ postcode = (m[1]+' '+m[2]).toUpperCase(); line = line.replace(m[0], '').replace(/[,\s]+$/,'').replace(/,\s*,/g, ','); }
      line = line.replace(/,\s*(East Yorkshire|United Kingdom)\b/gi, '').replace(/\s*,\s*/g, ', ').trim();
      return {name, address:line, postcode};
    }).filter(r=>r.address);
  }

  return {onShow, render, reset:()=>{ cur = null; sites = {}; list = []; loaded = false; try{ sessionStorage.removeItem('pfCur'); }catch(e){} }};
})();
if(typeof ME!=='undefined' && ME && !document.getElementById('view-portfolio').hidden) PORTFOLIO.onShow();
