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
  const FREQ = {once:['One-off clean',1],annual:['Annual (1 visit / year)',1],biannual:['Twice yearly (spring & autumn)',2],quarterly:['Quarterly (4 visits / year)',4]};
  const DEF_SET = {quoteRef:'', freq:'once', crew:2, discPct:10, discMin:20, vat:true, rams:true, mewpDay:0, showPhotos:true, showAccess:true, onlyReviewed:false, intro:'', validDays:30, condHeavy:true};

  let list = [], cur = null, sites = {}, tab = 'summary', siteId = null, loaded = false;
  let sortKey = 'ref', sortDir = 1, filterStatus = '', search = '', armed = 'site';
  const urls = {}; let urlsAt = 0;
  const pending = {}, chains = {};
  const root = () => $('view-portfolio');
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
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
    return d;
  }
  const totalLen = d => ['front','rear','left','right','other'].reduce((a,k)=>a+num(d.len&&d.len[k]),0);
  const sorted = () => Object.values(sites).sort((a,b)=>num(a.ref)-num(b.ref) || String(a.name||a.address).localeCompare(b.name||b.address));
  const imgs = s => [s.photos.aerial, s.photos.street, ...(s.photos.site||[])].filter(Boolean);
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
    const {data, error} = await sb.from('portfolios').select('id,name,client,status,settings,updated_at,created_by_name,portfolio_sites(count)').order('updated_at', {ascending:false});
    if(error) throw error;
    list = data || []; loaded = true;
  }
  async function openPortfolio(id){
    const p = list.find(x=>x.id===id); if(!p) return;
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
    Object.values(sites).forEach(s=>imgs(s).forEach(i=>{ if(i.path && (force || !urls[i.path])) paths.push(i.path); }));
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
      const {data, error} = await sb.from('portfolios').insert({name, client:$('pfNewClient').value.trim(), created_by_name:ME.name, settings:Object.assign({}, DEF_SET, {quoteRef:ref})}).select('id,name,client,status,settings,updated_at,created_by_name').single();
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
      <div class="vb-actions"><div class="seg" id="pfTabs">${[['summary','Summary'],['site','Properties'],['quote','Customer quote'],['settings','Settings & import']].map(([k,l])=>`<button type="button" data-t="${k}" class="${tab===k?'on':''}">${l}</button>`).join('')}</div></div></div>
    <div id="pfBody"></div>`;
    $('pfBack').onclick = e=>{ e.preventDefault(); try{ sessionStorage.removeItem('pfCur'); }catch(x){} loadList().then(renderList); };
    root().querySelectorAll('#pfTabs button').forEach(b=> b.onclick = ()=>{ tab = b.dataset.t; render(); window.scrollTo(0,0); });
    ({summary:renderSummary, site:renderSite, quote:renderQuote, settings:renderSettings}[tab]||renderSummary)($('pfBody'), P);
  }
  const statusOf = k => STATUSES.find(s=>s[0]===k) || STATUSES[0];
  const opt = (arr, val, ph) => `<option value="">${ph||'Select…'}</option>` + arr.map(o=>{ const [v,l] = Array.isArray(o)?o:[o,o]; return `<option value="${esc(v)}" ${String(val)===String(v)?'selected':''}>${esc(l)}</option>`; }).join('');

  function renderSummary(box, P){
    const all = P.all;
    if(!all.length){ box.innerHTML = `<section class="card"><h2>No properties yet</h2><p class="hint">Paste the addresses under Settings & import.</p><div style="margin-top:10px"><button class="btn pri" type="button" id="pfGoImp">Import addresses</button></div></section>`; $('pfGoImp').onclick = ()=>{ tab='settings'; render(); }; return; }
    const counts = {}; STATUSES.forEach(s=>counts[s[0]]=0); all.forEach(s=>counts[s.data.status]=(counts[s.data.status]||0)+1);
    const rev = all.reduce((a,s)=>{ const r = imgStats(s); a.d += r.done; a.t += r.total; return a; }, {d:0,t:0});
    let rows = all.filter(s=>(!filterStatus || s.data.status===filterStatus) && (!search || [s.name,s.address,s.postcode,s.data.type,s.data.notes].join(' ').toLowerCase().includes(search.toLowerCase())));
    const key = {ref:s=>num(s.ref), name:s=>(s.name||s.address||'').toLowerCase(), type:s=>s.data.type||'', storeys:s=>num(s.data.storeys), len:s=>totalLen(s.data), status:s=>STATUSES.findIndex(x=>x[0]===s.data.status), price:s=>calc(s).price, hrs:s=>calc(s).hrs};
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
        <thead><tr>${th('ref','#')}<th></th>${th('name','Property')}${th('type','Type')}${th('storeys','Storeys','r')}${th('len','Gutter m','r')}<th class="r">Downpipes</th><th>Access</th><th>Method</th><th>Condition</th>${th('status','Status')}<th>Missing</th>${th('hrs','Hours','r')}${th('price','Price','r')}</tr></thead>
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
          <td><div class="pf-badges">${iss.length?iss.map(i=>`<span class="pf-b">${esc(i)}</span>`).join(''):'<span class="pf-b ok">Complete</span>'}</div></td>
          <td class="r">${c.hrs?c.hrs.toFixed(1):'–'}</td><td class="r"><b>${c.price?gbp0(c.price):'–'}</b></td></tr>`; }).join('')}</tbody>
        <tfoot><tr><td></td><td></td><td>${rows.length} shown</td><td></td><td></td><td class="r">${Math.round(rows.reduce((a,s)=>a+totalLen(s.data),0))}</td><td class="r">${rows.reduce((a,s)=>a+num(s.data.downpipes),0)}</td><td colspan="5"></td><td class="r">${rows.reduce((a,s)=>a+calc(s).hrs,0).toFixed(1)}</td><td class="r">${gbp0(rows.filter(s=>s.data.include!==false&&s.data.status!=='noquote').reduce((a,s)=>a+calc(s).price,0))}</td></tr></tfoot>
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
        <div class="pf-slot-h"><b>${title}</b>${link}</div>
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
    b.querySelectorAll('[data-rm]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); removeImg(s, 'site', +e.dataset.rm); }));
    b.querySelectorAll('[data-full]').forEach(e=> e.addEventListener('click', ev=>{ ev.stopPropagation(); const lb = $('pfLb'); lb.querySelector('img').src = urls[e.dataset.full] || e.src; lb.hidden = false; }));
    $('pfLb').onclick = ()=> $('pfLb').hidden = true;
    let pickKind = 'site';
    b.querySelectorAll('[data-pick]').forEach(e=> e.addEventListener('click', ev=>{ ev.preventDefault(); ev.stopPropagation(); pickKind = e.dataset.pick; const f = $('pfFile'); f.multiple = pickKind==='site'; f.value = ''; f.click(); }));
    $('pfFile').onchange = e=>{ if(e.target.files.length) addImages(s, pickKind, [...e.target.files]); };
    b.querySelectorAll('.pf-slot').forEach(el=>{
      el.addEventListener('click', ()=>{ armed = el.dataset.slot; b.querySelectorAll('.pf-slot').forEach(x=>x.classList.toggle('armed', x===el)); });
      el.addEventListener('focus', ()=>{ armed = el.dataset.slot; });
      el.addEventListener('dragover', e=>{ e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', ()=> el.classList.remove('drag'));
      el.addEventListener('drop', e=>{ e.preventDefault(); el.classList.remove('drag'); const f = [...e.dataTransfer.files].filter(x=>x.type.startsWith('image/')); if(f.length) addImages(s, el.dataset.slot, f); });
    });
    const del = $('pfDelSite'); if(del) del.onclick = async ()=>{
      if(!confirmInline('pfDel'+s.id, 'Press Delete property again to remove it and its photos.')) return;
      const paths = imgs(s).map(x=>x.path).filter(Boolean);
      const {error} = await sb.from('portfolio_sites').delete().eq('id', s.id); if(error){ flash('Could not delete: ' + error.message); return; }
      if(paths.length) sb.storage.from(BUCKET).remove(paths).catch(()=>{});
      delete sites[s.id]; siteId = null; tab = 'summary'; render(); flash('Property deleted');
    };
    const pin = $('pfPin'); if(pin) pin.onclick = ()=>{ if(!live.map){ flash('The map has not loaded'); return; } const c = live.map.getCenter(); s.lat = +c.lat().toFixed(6); s.lng = +c.lng().toFixed(6); saveSite(s, 0); flash('Building pinned'); liveViews(s); };
    const ms = $('pfMeasure'); if(ms) ms.onclick = ()=>{
      if(typeof MEASURE==='undefined' || !MEASURE.openFor){ flash('Measuring is not available'); return; }
      MEASURE.openFor({kind:'gutters', addr:[s.address, s.postcode].filter(Boolean).join(', '), lat:s.lat, lng:s.lng, property:'commercial', label:'Use for this property', back:'portfolio',
        onUse:(total)=>{ s.data.len = {front:String(Math.round(total)), rear:'', left:'', right:'', other:''}; s.data.measuredAt = new Date().toISOString(); saveSite(s, 0); flash(`${Math.round(total)} m of gutter added to ${s.name||s.address}`); }});
    };
  }
  function toggleRev(s, img){
    if(!img) return;
    img.reviewed = !img.reviewed;
    if(img.reviewed){ img.reviewedAt = new Date().toISOString(); img.reviewedBy = ME.name; } else { delete img.reviewedAt; delete img.reviewedBy; }
    saveSite(s, 0); render(); flash(img.reviewed ? 'Marked as reviewed' : 'Review removed');
  }
  async function removeImg(s, kind, ix){
    const img = kind==='site' ? s.photos.site[ix] : s.photos[kind]; if(!img) return;
    if(!confirmInline('pfRm'+(img.path||ix), 'Press again to remove this image.')) return;
    if(kind==='site') s.photos.site.splice(ix, 1); else s.photos[kind] = null;
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
  async function addImages(s, kind, files, quiet){
    if(kind!=='site') files = files.slice(0,1);
    saveStatus('Uploading…'); if(!quiet) flash(files.length>1 ? `Uploading ${files.length} photos…` : 'Uploading…');
    let n = 0;
    for(const f of files){
      try{
        const rec = await uploadImg(s, kind, await shrink(f));
        if(kind==='site') s.photos.site.push(rec);
        else { const old = s.photos[kind]; s.photos[kind] = rec; if(old && old.path) sb.storage.from(BUCKET).remove([old.path]).catch(()=>{}); }
        n++;
      }catch(e){ console.error(e); flash('Upload failed: ' + (e.message||e)); }
    }
    if(n){ saveSite(s, 0); if(!quiet){ render(); flash(n>1 ? `${n} photos added` : 'Photo added'); } }
    return n;
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
  /* ---------- customer quote ---------- */
  function quoteHTML(){
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
        <div class="g"><span>Total per visit</span><span>${gbp(P.gross)}</span></div>
        ${P.visits>1?`<div><span>${P.visits} visits per year</span><b>${gbp(P.annual)} / year</b></div>`:''}
      </div>
      ${st.showPhotos?`<h3>Property survey images</h3><div class="pf-q-props">${P.priced.map(s=>`<div class="pf-q-prop"><div class="imgs">${okImg(s.photos.aerial)?`<img src="${esc(src(s.photos.aerial))}" alt="">`:'<div class="no">No aerial</div>'}${okImg(s.photos.street)?`<img src="${esc(src(s.photos.street))}" alt="">`:'<div class="no">No street view</div>'}</div><div class="tx"><b>${esc(s.ref)}. ${esc(s.name||s.address)}</b><br>${calc(s).m.toFixed(0)} m gutter · ${esc(s.data.storeys||'?')} storey${num(s.data.storeys)===1?'':'s'}${s.data.method?' · '+esc(s.data.method):''}</div></div>`).join('')}</div><p class="pf-q-small">Aerial and Street View imagery © Google.</p>`:''}
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
      if(P.disc) lines.push(`Discount ${S().discPct}%\t\t\t\t\t\t\t-${gbp(P.disc)}`); if(P.rams) lines.push(`RAMS\t\t\t\t\t\t\t${gbp(P.rams)}`); if(S().vat) lines.push(`VAT\t\t\t\t\t\t\t${gbp(P.vat)}`); lines.push(`Total per visit\t\t\t\t\t\t\t${gbp(P.gross)}`);
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
        <p class="hint">Pick many images at once. Files named with the property number and type – e.g. <b>07_aerial.jpg</b>, <b>07_street.jpg</b>, <b>07_site_1.jpg</b> – go straight onto that property.</p>
        <input type="file" id="pfImgImp" accept="image/*" multiple>
        <p class="hint" id="pfImgMsg"></p>
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
    $('pfImgImp').onchange = async e=>{
      const files = [...e.target.files]; const msg = $('pfImgMsg'); let ok = 0, skip = [];
      const byRef = {}; Object.values(sites).forEach(s=>byRef[num(s.ref)] = s);
      for(let i=0;i<files.length;i++){
        const f = files[i], m = f.name.match(/(\d+)[ _-]*(aerial|street|site)/i);
        const s = m && byRef[+m[1]]; if(!s){ skip.push(f.name); continue; }
        msg.textContent = `Uploading ${i+1} of ${files.length}…`;
        ok += await addImages(s, m[2].toLowerCase(), [f], true);
      }
      msg.textContent = `${ok} image${ok===1?'':'s'} added.` + (skip.length ? ` Skipped ${skip.length} (no matching property number): ${skip.slice(0,5).join(', ')}${skip.length>5?'…':''}` : '');
      e.target.value = '';
    };
    const dp = $('pfDelP'); if(dp) dp.onclick = async ()=>{
      if(!confirmInline('pfDelP', 'Press Delete this portfolio again to delete it, all its properties and photos.')) return;
      const paths = Object.values(sites).flatMap(s=>imgs(s).map(x=>x.path)).filter(Boolean);
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
