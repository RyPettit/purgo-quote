
const DEF = {
  labour:30, labourPaid:20, targetMargin:35,
  pwRate:3, heavySoil:1.00, pwSetup:0, pwSetupTime:0.33, pwMin:90,
  sf_block:55, sf_concrete:70, sf_tarmac:55, sf_stone:40, sf_imprint:60, sf_porcelain:65, sf_deck:35,
  sandBag:5.49, sandCover:10, sandRate:80, sandMarkup:20,
  chemLabour:0.50, chemApp:200,
  gutRate:3.00, gutRate3:4.00, gutMin:60, guard:8, fascia:4, gutSpeed:40, gutSpeed3:28, fasSpeed:25, gutSetup:0.25,
  perWin:1.5, priceT:13, priceS:15, priceD:20, stdT:8, stdS:10, stdD:14, sillT:5, sillS:8, sillD:12,
  firstClean:50, winMins:1.5, winSetup:8, waterPerWin:3, waterCost:0.07,
  scrape:6, lpw:5, steepUp:20, mossModUp:10, mossHeavyUp:25, scrapeRate:12, lpwRate:25, roofSetup:0.5,
  towerDay:50, towerErect:0.75, towerDismantle:0.5, dayHours:7.5,
  freeMiles:10, perMile:1.00, roadFactor:1.3, avgMph:28, vanMpg:32, rigLph:2.5,
  minRes:40, minCom:150, rams:40, ooh:25, vat:20,
  cx_hose:0.5, cx_water:0.5, cx_steps:0.25, cx_move:0.5, cx_weeds:0.75, cx_stain:0.5, cx_narrow:0.25, cx_parking:0.25,
  cx_gtCons:0.25, cx_gtHeavy:0.5, cx_ind:1, cx_bar:0.5,
  chems:[
    {id:'c1',name:'Patio pre-treat (TBC)',cost:0,cover:10,markup:0},
    {id:'c2',name:'Roof biocide (TBC)',cost:0,cover:10,markup:0},
    {id:'c3',name:'Post-treat / algae inhibitor (TBC)',cost:0,cover:10,markup:0}
  ]
};
const RATE_GROUPS = [
  ['Labour & margin',[['labour','Ancillary labour charged £/hr per worker'],['labourPaid','Labour paid £/hr per worker'],['targetMargin','Target margin %'],['dayHours','Working day (hours)'],['minRes','Minimum charge, residential £'],['minCom','Minimum charge, commercial £'],['vat','VAT %']]],
  ['Travel & fuel',[['freeMiles','Free travel radius (miles)'],['perMile','Travel charge £/mile beyond radius'],['roadFactor','Road distance factor'],['avgMph','Average travel speed mph'],['vanMpg','Van mpg (Transit Custom)'],['rigLph','Pressure washer petrol L/hr']]],
  ['Pressure washing',[['pwRate','Wash & slurry £/m²'],['heavySoil','Heavy soiling uplift £/m²'],['pwMin','Pressure washing minimum £'],['pwSetupTime','Set-up & pack-down time (h, not billed)'],['sf_block','Block paving m²/hr'],['sf_concrete','Concrete m²/hr'],['sf_tarmac','Tarmac m²/hr'],['sf_stone','Natural stone m²/hr'],['sf_imprint','Imprinted concrete m²/hr'],['sf_porcelain','Porcelain m²/hr'],['sf_deck','Decking m²/hr']]],
  ['Sand & chemicals',[['sandBag','Kiln sand 25kg bag £'],['sandCover','m² per bag (refill)'],['sandRate','Sand brushing m²/hr per worker'],['sandMarkup','Sand markup %'],['chemLabour','Chemical application £/m²'],['chemApp','Chemical application m²/hr']]],
  ['Gutters',[['gutRate','Survey & clear £/m (1–2 storey)'],['gutRate3','Survey & clear £/m (3 storey)'],['gutMin','Gutter minimum £'],['guard','Downpipe guard £ each'],['fascia','Fascia & soffit £/m'],['gutSetup','Set-up & pack-down (h, billed)'],['gutSpeed','Clear speed m/hr (1–2 storey)'],['gutSpeed3','Clear speed m/hr (3 storey)'],['fasSpeed','Fascia speed m/hr']]],
  ['Windows',[['perWin','Per window £'],['priceT','Terrace £'],['priceS','Semi £'],['priceD','Detached £'],['stdT','Windows in std terrace'],['stdS','Windows in std semi'],['stdD','Windows in std detached'],['sillT','Sills & doors, terrace £'],['sillS','Sills & doors, semi £'],['sillD','Sills & doors, detached £'],['firstClean','First clean uplift %'],['winMins','Minutes per window'],['winSetup','Set-up minutes (not billed)'],['waterPerWin','Litres per window'],['waterCost','Pure water £/litre']]],
  ['Roof',[['scrape','Scraping £/m²'],['lpw','Low pressure wash £/m²'],['steepUp','Steep pitch uplift %'],['mossModUp','Moderate moss uplift %'],['mossHeavyUp','Heavy moss uplift %'],['roofSetup','Set-up & pack-down (h, billed)'],['scrapeRate','Scraping m²/hr per worker'],['lpwRate','LP wash m²/hr'],['towerDay','Scaffold tower £/day'],['towerErect','Tower erect (h per position)'],['towerDismantle','Tower dismantle (h per position)']]],
  ['Ancillary time (hours)',[['cx_hose','Long hose/reel run'],['cx_water','No outside tap'],['cx_steps','Steps / slopes'],['cx_move','Moving cars / furniture'],['cx_weeds','Heavy weeds'],['cx_stain','Oil / rust / gum spots'],['cx_narrow','Narrow side access'],['cx_parking','Restricted parking'],['cx_gtCons','Gutters over conservatory'],['cx_gtHeavy','Heavy gutter blockage'],['cx_ind','Site induction'],['cx_bar','Barriers / pedestrians']]]
];
const SURF = {block:['Block paving','sf_block',1],concrete:['Concrete','sf_concrete',0],tarmac:['Tarmac','sf_tarmac',0],stone:['Natural stone / Indian sandstone','sf_stone',1],imprint:['Imprinted concrete','sf_imprint',0],porcelain:['Porcelain','sf_porcelain',1],deck:['Decking','sf_deck',0]};
const CX = [
  ['cx_hose','Hose / reel run over 30 m from van'],['cx_parking','Restricted parking / unloading'],['cx_narrow','Narrow or gated side access'],['cx_steps','Steps, slopes or levels'],
  ['cx_move','Cars, furniture or pots to move'],['cx_weeds','Heavy weeds to remove first'],['cx_stain','Oil, rust or gum spot treatment'],['cx_water','No outside tap (bring water)']
];
const WIN_NAMES = {T:'Terrace',S:'Semi-detached',D:'Detached'};
const BASE = {name:'26 Anlaby Park Road South, HU4 7BJ', lat:53.726587, lng:-0.416505};
const $ = id => document.getElementById(id);
const gbp = n => (n<0?'-':'') + '£' + Math.abs(Math.round(n*100)/100).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const num = id => { const v = parseFloat($(id).value); return isNaN(v) ? 0 : v; };
const esc = s => String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const normPc = s => String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const fmtPc = s => { const n = normPc(s); return n.length>=5 ? n.slice(0,-3)+' '+n.slice(-3) : n; };

const COST_KEYS = ['labourPaid','targetMargin','sandBag','sandMarkup','vanMpg','rigLph','waterCost'];
const clone = x => JSON.parse(JSON.stringify(x));
let R = clone(DEF), ROLE = null, ME = null, ratesDirty = false, removedChems = [];
function markRatesDirty(){ ratesDirty = true; const b=$('saveRates'); if(b) b.disabled = false; }

let ctype = 'res';
let pwRows = [{name:'Driveway',surf:'block',sqm:0,soil:'normal',sand:true,chem:''}];

/* ---------- postcode data ---------- */
let PC = null; const pcCache = {};
let loc = null; // {pc, lat, lng}
fetch('postcodes.json').then(r=>r.json()).then(d=>{ PC = d; resolvePc(); render(); }).catch(()=>{ $('locBox').innerHTML = '<span class="chip off">Postcode list did not load. Enter miles manually.</span>'; });
function outward(o){
  if(!PC || !PC.pc[o]) return null;
  if(pcCache[o]) return pcCache[o];
  const m = {}; PC.pc[o].split(';').forEach(e=>{ if(!e) return; const i=e.slice(0,3); const [a,b]=e.slice(3).split(','); m[i]=[PC.base[0]+(+a)/1e4, PC.base[1]+(+b)/1e4]; });
  return pcCache[o]=m;
}
function lookupPc(s){ const n = normPc(s); if(n.length<5) return null; const o=n.slice(0,-3), i=n.slice(-3); const m=outward(o); return m && m[i] ? {pc:o+' '+i, lat:m[i][0], lng:m[i][1]} : null; }
function resolvePc(){ loc = lookupPc($('pc').value); }
function haversine(a,b,c,d){ const p=Math.PI/180, R0=3958.8; const x=Math.sin((c-a)*p/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2; return 2*R0*Math.asin(Math.sqrt(x)); }
function travel(){
  const ov = num('milesOv');
  if(ov>0) return {miles:ov, src:'manual'};
  if(loc) return {miles: Math.round(haversine(BASE.lat,BASE.lng,loc.lat,loc.lng)*R.roadFactor*10)/10, src:'pc'};
  return {miles:0, src:'none'};
}

let addresses = [], quotes = [], staff = [];
let fuel = {diesel:1.992, petrol:1.741, date:'2026-10-26', source:'starting price'};
function showFuel(){
  if(!fuel || !fuel.date) return;
  const d = new Date(fuel.date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const st = fuel.status;
  let t = fuel.auto ? `Updated automatically each morning: ${d}, ${fuel.source}. Anything you type here is replaced at the next morning update.`
                    : `Last set ${d} (${fuel.source||'admin'}). Updates automatically each morning once the daily fuel job is running.`;
  if(st && st.ok===false) t += ` Last automatic update failed (${new Date(st.at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}): ${st.message}`;
  $('fuelSrc').textContent = t;
  $('fuelSrc').className = (st && st.ok===false) ? 'note w' : 'hint';
}

/* suggestion dropdowns */
function suggest(input, box, itemsFn){
  let act = -1, items = [];
  const close = ()=>{ box.hidden = true; act = -1; };
  const draw = ()=>{
    items = itemsFn(input.value);
    if(!items.length || document.activeElement!==input){ close(); return; }
    box.innerHTML = items.map((it,i)=>`<button type="button" data-k="${i}" class="${i===act?'act':''}"><b>${esc(it.label)}</b>${it.sub?`<small>${esc(it.sub)}</small>`:''}</button>`).join('');
    box.hidden = false;
  };
  input.addEventListener('input', ()=>{ act=-1; draw(); });
  input.addEventListener('focus', draw);
  input.addEventListener('blur', ()=> setTimeout(close, 180));
  input.addEventListener('keydown', e=>{
    if(box.hidden) return;
    if(e.key==='ArrowDown'){ act=Math.min(items.length-1,act+1); draw(); e.preventDefault(); }
    else if(e.key==='ArrowUp'){ act=Math.max(0,act-1); draw(); e.preventDefault(); }
    else if(e.key==='Enter' && act>=0){ items[act].pick(); close(); e.preventDefault(); }
    else if(e.key==='Escape') close();
  });
  box.addEventListener('mousedown', e=>{ const b=e.target.closest('button'); if(!b) return; e.preventDefault(); items[+b.dataset.k].pick(); close(); });
}
function pickAddress(a){
  $('addr').value = a.line||''; $('pc').value = a.postcode||''; $('cust').value = a.customer||''; $('phone').value = a.phone||''; $('jobNotes').value = a.notes||'';
  resolvePc(); render();
}
const PC_LIKE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*(\d[A-Za-z]{0,2})?$/;
function setPostcode(c, fromAddr){
  $('pc').value = c; resolvePc();
  if(fromAddr){ $('addr').value = ''; $('addr').placeholder = `House number and street, ${c}`; $('addr').focus(); }
  render();
}
suggest($('addr'), $('addrSugg'), q=>{
  const t = q.trim(); if(t.length<2) return [];
  const tl = t.toLowerCase();
  const saved = addresses.filter(a=>[a.line,a.postcode,a.customer].join(' ').toLowerCase().includes(tl) || (PC_LIKE.test(t) && normPc(a.postcode).startsWith(normPc(t)))).slice(0,6)
    .map(a=>({label:a.line, sub:`${a.postcode||''}${a.customer?' · '+a.customer:''}${a.lastQuoted?' · last quoted '+new Date(a.lastQuoted).toLocaleDateString('en-GB'):''}`, pick:()=>pickAddress(a)}));
  if(!PC_LIKE.test(t)) return saved;
  return [...saved, ...pcItems(t, $('addr'), true)];
});
suggest($('pc'), $('pcSugg'), q=>{
  const n = normPc(q); if(n.length<2) return [];
  const saved = addresses.filter(a=>normPc(a.postcode).startsWith(n)).slice(0,4).map(a=>({label:a.line, sub:`Saved · ${a.postcode}${a.customer?' · '+a.customer:''}`, pick:()=>pickAddress(a)}));
  return [...saved, ...pcItems(q, $('pc'), false)];
});
function pcItems(q, input, fromAddr){
  const n = normPc(q); if(n.length<2 || !PC) return [];
  let codes = [];
  const outs = Object.keys(PC.pc);
  const exactOut = outs.filter(o=>n.startsWith(o) && n.length>o.length);
  if(exactOut.length){
    exactOut.forEach(o=>{ const inw = n.slice(o.length); const m = outward(o); Object.keys(m).filter(i=>i.startsWith(inw)).slice(0,8).forEach(i=>codes.push(o+' '+i)); });
  }
  if(!codes.length) codes = outs.filter(o=>o.startsWith(n)).sort((a,b)=>a.length-b.length||a.localeCompare(b,undefined,{numeric:true})).slice(0,8).map(o=>o+' …');
  return codes.slice(0,8).map(c=>{
    if(c.endsWith('…')) return {label:c.replace(' …',''), sub:'Postcode district · keep typing', pick:()=>{ input.value = c.replace(' …','')+' '; input.focus(); setTimeout(()=>input.dispatchEvent(new Event('input')),0); }};
    const l = lookupPc(c); const mi = l ? haversine(BASE.lat,BASE.lng,l.lat,l.lng)*R.roadFactor : 0;
    return {label:c, sub:`Postcode · approx ${mi.toFixed(1)} miles from base`, pick:()=>setPostcode(c, fromAddr)};
  });
}
// a full postcode typed at the end of the address moves into the postcode box
$('addr').addEventListener('blur', ()=>{
  const v = $('addr').value; const m = v.match(/[,\s]*([A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2})\s*$/);
  if(m && lookupPc(m[1])){ $('addr').value = v.slice(0, m.index).trim(); setPostcode(fmtPc(m[1]), false); }
});

/* ---------- rendering of editable bits ---------- */
function renderRates(){
  if(ROLE!=='admin'){ document.querySelectorAll('[data-r]').forEach(el=> el.textContent = R[el.dataset.r] ?? ''); return; }
  const box = $('ratesBox'); box.innerHTML = '';
  RATE_GROUPS.forEach(([g, items])=>{
    const sec = document.createElement('section'); sec.className = 'card';
    sec.innerHTML = `<h2>${esc(g)}</h2><div class="svc-body"><div class="rgrid">${items.map(([k,l])=>`<label class="f">${l}<input type="number" step="any" id="r_${k}" data-rk="${k}" value="${R[k]}"></label>`).join('')}</div></div>`;
    box.appendChild(sec);
  });
  renderChems();
  document.querySelectorAll('[data-r]').forEach(el=> el.textContent = R[el.dataset.r]);
}
function renderChems(){
  $('chemBody').innerHTML = R.chems.map((c,i)=>`<tr>
    <td><input id="ch_n_${c.id}" data-ci="${i}" data-cf="name" value="${esc(c.name)}"></td>
    <td><input id="ch_c_${c.id}" type="number" step="any" data-ci="${i}" data-cf="cost" value="${c.cost}"></td>
    <td><input id="ch_v_${c.id}" type="number" step="any" data-ci="${i}" data-cf="cover" value="${c.cover}"></td>
    <td><input id="ch_m_${c.id}" type="number" step="any" data-ci="${i}" data-cf="markup" value="${c.markup}"></td>
    <td><button class="btn sm" type="button" data-delchem="${i}">Remove</button></td></tr>`).join('');
  refreshChemSelects();
}
function chemOptions(sel){ return `<option value="">None</option>` + R.chems.map(c=>`<option value="${c.id}" ${c.id===sel?'selected':''}>${esc(c.name)}</option>`).join(''); }
function refreshChemSelects(){
  const rf = $('rfChem'); const cur = rf.dataset.init ? rf.value : 'c2'; rf.innerHTML = chemOptions(cur); rf.dataset.init = 1;
  document.querySelectorAll('select[data-f="chem"]').forEach(s=>{ const i=+s.dataset.i; s.innerHTML = chemOptions(pwRows[i].chem); });
}
function renderPw(){
  $('pwRows').innerHTML = pwRows.map((r,i)=>`<div class="arow">
    <label class="f">Area<input id="pw_n_${i}" data-i="${i}" data-f="name" value="${esc(r.name)}"></label>
    <label class="f">Surface<select id="pw_s_${i}" data-i="${i}" data-f="surf">${Object.entries(SURF).map(([k,v])=>`<option value="${k}" ${k===r.surf?'selected':''}>${v[0]}</option>`).join('')}</select></label>
    <label class="f">Size (m²)<input id="pw_q_${i}" type="number" min="0" data-i="${i}" data-f="sqm" value="${r.sqm}"></label>
    <label class="f">Soiling<select id="pw_o_${i}" data-i="${i}" data-f="soil">${['light','normal','heavy'].map(v=>`<option value="${v}" ${v===r.soil?'selected':''}>${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label>
    <label class="f">Chemical<select id="pw_c_${i}" data-i="${i}" data-f="chem">${chemOptions(r.chem)}</select></label>
    <label class="ck" style="align-self:center"><input type="checkbox" id="pw_d_${i}" data-i="${i}" data-f="sand" ${r.sand?'checked':''}>Re-sand joints</label>
    <button class="btn sm rm" type="button" data-rmpw="${i}">Remove</button></div>`).join('') || '<p class="hint">No areas yet.</p>';
}
function renderCx(){
  $('cxList').innerHTML = CX.map(([k,l])=>`<label class="ck"><input type="checkbox" id="${k}" data-cx="${k}">${l} <small>+<span data-r="${k}">${R[k]}</span>h</small></label>`).join('');
}
function syncSvc(){ document.querySelectorAll('.svc').forEach(s=>{ s.closest('section').querySelector('.svc-body').hidden = !s.checked; }); }

/* ---------- calculation ---------- */
const TASKW = {wSetup:'Set-up & pack-down', wCx:'Access extras', wTower:'Scaffold tower', wPw:'Pressure washing', wGt:'Gutters', wWn:'Windows', wRf:'Roof cleaning'};
function calc(){
  const crew = Math.max(1, Math.round(num('workers')));
  const L = R.labour;
  const o = {groups:[], tasks:[], rigH:0, setupT:0, crew, cost:{sand:0, chem:0, water:0}, warn:[], notes:[]};
  const want = (id, def) => {
    const raw = String($(id).value).trim(); const v = raw==='' ? def : Math.max(1, Math.round(+raw)||1);
    if(v>crew) o.warn.push(['w', id==='wTower' ? `The scaffold tower needs ${v} people to put up and take down (PASMA guidance) but the crew is ${crew}.` : `${TASKW[id]} is set to ${v} people but the crew is ${crew}. Planned with ${crew}.`]);
    return Math.min(v, crew);
  };
  const grp = name => { const g={name,lines:[]}; o.groups.push(g); return g; };
  const line = (g,label,amt,detail='') => { if(amt) g.lines.push({label,amt,detail}); };
  const bill = (g,label,h,w,fold) => { if(h>0){ line(g,label,h*w*L,`${+h.toFixed(2)}h × ${w} worker${w>1?'s':''} × ${gbp(L)}`); if(fold && g.lines.length) g.lines[g.lines.length-1].fold = true; } };
  const task = (id,label,dur,w,pri,after=[]) => { if(dur>0.0001) o.tasks.push({id,label,dur,w,pri,after}); };
  const chemCharge = (g, id, area, what) => {
    const c = R.chems.find(x=>x.id===id); if(!c || !area) return 0;
    const litres = area / (c.cover||1);
    const mat = litres * (c.cost||0);
    o.cost.chem += mat;
    const sell = c.sell!=null ? litres*c.sell : mat*(1+(c.markup||0)/100);
    line(g, `${c.name}: ${what}`, sell + area*R.chemLabour, `${litres.toFixed(1)} L over ${area} m² + application ${area} m² × ${gbp(R.chemLabour)}`);
    if(!(c.sell||c.cost)) o.warn.push(['w', ROLE==='admin' ? `${c.name} has no price yet. Add it under Admin → Chemicals.` : `${c.name} has no price yet. Ask for it to be added before sending this quote.`]);
    return area / R.chemApp; // worker-hours
  };
  const wSet = want('wSetup', crew), wCx = want('wCx', crew);

  // Pressure washing
  if($('on-pw').checked && pwRows.some(r=>+r.sqm>0)){
    const g = grp('Pressure washing');
    const w = want('wPw', crew);
    o.setupT += R.pwSetupTime;
    bill(g, 'Set-up & pack-down', R.pwSetup, wSet, true);
    let washSum = 0, rig = 0, wh = 0;
    pwRows.forEach(r=>{
      const s = SURF[r.surf]; const sqm = +r.sqm||0; if(!sqm) return;
      let t = sqm / R[s[1]];
      line(g, `${r.name}: ${s[0]} wash & slurry removal`, sqm*R.pwRate, `${sqm} m² × ${gbp(R.pwRate)}`); washSum += sqm*R.pwRate;
      if(r.soil==='heavy'){ t *= 1.35; line(g, `${r.name}: heavy soiling`, sqm*R.heavySoil, `${sqm} m² × ${gbp(R.heavySoil)}`); washSum += sqm*R.heavySoil; }
      rig += t;
      if(r.sand){
        const bags = Math.ceil(sqm / R.sandCover); const matc = bags*(R.sandBag||0); const sellBag = R.sandBagSell!=null ? R.sandBagSell : (R.sandBag||0)*(1+(R.sandMarkup||0)/100); const sH = sqm/R.sandRate;
        o.cost.sand += matc; wh += sH;
        line(g, `${r.name}: kiln sand re-fill`, bags*sellBag + sH*L, `${bags} × 25kg bags at ${gbp(sellBag)} + ${sH.toFixed(1)}h brushing in`);
        if(!s[2]) o.warn.push(['w', `${r.name}: re-sanding is unusual on ${s[0].toLowerCase()}. Check it has sanded joints.`]);
      }
      if(r.chem) wh += chemCharge(g, r.chem, sqm, r.name);
      if(r.surf==='tarmac') o.notes.push('Tarmac is washed at reduced pressure to avoid lifting the surface.');
      if(r.surf==='imprint') o.notes.push('Imprinted concrete may need resealing after cleaning; quoted separately on request.');
    });
    o.rigH += rig;
    task('pw', 'Pressure washing', rig + wh/w, w, 3);
    if(washSum>0 && washSum<R.pwMin) line(g, 'Minimum pressure washing charge', R.pwMin-washSum, `Wash total ${gbp(washSum)} topped up to ${gbp(R.pwMin)}`);
    if($('cx_water').checked) o.warn.push(['b','No outside tap: the rig uses about 21 L/min and the 240 L buffer tank lasts roughly 11 minutes. Arrange water before booking.']);
  }

  // Gutters
  if($('on-gt').checked){
    const g = grp('Gutters');
    const w = want('wGt', crew);
    const m = num('gtM'), st = +$('gtSt').value;
    const rate = st>=3 ? R.gutRate3 : R.gutRate;
    let d = 0;
    if(m){
      const base = m*rate;
      line(g, `Gutter survey & clear (${m} m, ${st>=4?'4+':st} storey)`, Math.max(base, R.gutMin), base<R.gutMin ? `Minimum gutter charge (${m} m × ${gbp(rate)} = ${gbp(base)})` : `${m} m × ${gbp(rate)}`);
      o.setupT += R.gutSetup;
      bill(g, 'Set-up & pack-down', R.gutSetup, wSet, true);
      d += m/(st>=3?R.gutSpeed3:R.gutSpeed);
      o.notes.push('Gutter price covers a camera survey and full clear only. Any repairs we find will be photographed and quoted separately before any work goes ahead.');
    }
    const gq = num('gtGuard'); if(gq){ line(g, `Downpipe guards × ${gq}`, gq*R.guard, `${gq} × ${gbp(R.guard)}`); d += gq*0.05; }
    const fm = num('gtFas'); if(fm){ line(g, `Fascia & soffit clean (${fm} m)`, fm*R.fascia, `${fm} m × ${gbp(R.fascia)}`); d += fm/R.fasSpeed; }
    const rep = num('gtRep'); if(rep) line(g, `Known repairs${$('gtRepD').value?': '+$('gtRepD').value:''}`, rep, 'Agreed before the visit');
    if($('gtCons').checked){ bill(g,'Working over conservatory / extension', R.cx_gtCons, w); d += R.cx_gtCons; }
    if($('gtHeavy').checked){ bill(g,'Heavy blockage / plant growth', R.cx_gtHeavy, w); d += R.cx_gtHeavy; }
    task('gt', 'Gutters', d, w, 3);
    if(st>=4) o.warn.push(['b','Gutters above 3 storeys are beyond the 12 m SkyVac pole. Needs a site visit and access equipment.']);
  }

  // Windows
  if($('on-wn').checked){
    const g = grp('Windows');
    const w = want('wWn', crew);
    const mode = $('wnMode').value, t = $('wnType').value, n = num('wnCount'), st = +$('wnSt').value;
    let base;
    if(mode==='type'){
      const std = R['std'+t]; const extra = Math.max(0, n-std);
      base = R['price'+t] + extra*R.perWin;
      line(g, `${WIN_NAMES[t]} window clean`, R['price'+t], `Standard ${WIN_NAMES[t].toLowerCase()} up to ${std} windows`);
      if(extra) line(g, `Extra windows × ${extra}`, extra*R.perWin, `${extra} × ${gbp(R.perWin)} over standard`);
      $('wnHint').textContent = `Standard ${WIN_NAMES[t].toLowerCase()} covers up to ${std} windows; extras charged at ${gbp(R.perWin)} each.`;
    } else {
      base = n*R.perWin;
      line(g, `Window clean, ${n} windows`, base, `${n} × ${gbp(R.perWin)}`);
      $('wnHint').textContent = 'Per-window pricing suits commercial frontages and non-standard properties. Property size sets the sills & doors price.';
    }
    if($('wnSills').checked) line(g, 'Sills & doors', R['sill'+t], WIN_NAMES[t]);
    if($('wnFirst').checked) line(g, 'First clean uplift', (base + ($('wnSills').checked?R['sill'+t]:0))*R.firstClean/100, `+${R.firstClean}% for build-up on first visit`);
    const cons = num('wnCons'); if(cons) line(g, 'Conservatory roof', cons);
    const litres = n*R.waterPerWin*($('wnSills').checked?1.3:1)*($('wnFirst').checked?1.5:1);
    o.cost.water += litres*R.waterCost;
    if(n){ o.setupT += R.winSetup/60; task('wn', 'Windows', n*R.winMins*($('wnFirst').checked?1.5:1)/60, w, 3); }
    if(litres > 350) o.warn.push(['w', `About ${Math.round(litres)} L of pure water needed, more than one 350 L tank. Plan a refill at Spotless.`]);
    if(st>=4) o.warn.push(['b','The 30 ft pole reaches 3 storeys. Windows above that need other access.']);
  }

  // Roof
  const rfW = [];
  if($('on-rf').checked){
    const g = grp('Roof cleaning');
    const a = num('rfA'), m = $('rfM').value, ty = $('rfT').value, st = +$('rfSt').value;
    const pitch = $('rfP').value, moss = $('rfMoss').value;
    if(a){
      const w = want('wRf', crew);
      let t = 0, price = 0;
      if(m!=='lpw'){ line(g, `Roof scrape & moss removal (${a} m²)`, a*R.scrape, `${a} m² × ${gbp(R.scrape)}`); price += a*R.scrape; t += a/(R.scrapeRate*w); }
      if(m!=='scrape'){ line(g, `Roof low pressure wash (${a} m²)`, a*R.lpw, `${a} m² × ${gbp(R.lpw)} · 8" surface cleaner`); price += a*R.lpw; const lt = a/R.lpwRate; t += lt; o.rigH += lt; }
      const up = (pitch==='steep'?R.steepUp:0) + (moss==='moderate'?R.mossModUp:moss==='heavy'?R.mossHeavyUp:0);
      if(up) line(g, `${pitch==='steep'?'Steep pitch':''}${pitch==='steep'&&moss!=='light'?' + ':''}${moss!=='light'?moss+' moss':''} uplift`, price*up/100, `+${up}% on roof price`);
      t *= (pitch==='steep'?1.3:1) * ({light:1,moderate:1.2,heavy:1.45}[moss]);
      o.setupT += R.roofSetup;
      bill(g, 'Set-up & pack-down', R.roofSetup, wSet, true);
      if($('rfChem').value) t += chemCharge(g, $('rfChem').value, a, 'roof treatment') / w;
      const tw = $('rfTw').value; const towerUsed = tw==='yes' || (tw==='auto' && st>1);
      if(towerUsed){
        const wt = want('wTower', 2);
        const pos = Math.max(1, num('rfPos'));
        const eH = pos*R.towerErect, dH = pos*R.towerDismantle;
        bill(g, `Scaffold tower erect & dismantle (${pos} position${pos>1?'s':''})`, eH+dH, wt);
        const days = Math.ceil((R.roofSetup + t + eH + dH) / R.dayHours);
        line(g, `Scaffold tower use (${days} day${days>1?'s':''})`, days*R.towerDay, `${days} × ${gbp(R.towerDay)}`);
        task('te', 'Tower erect', eH, wt, 2);
        task('rf', 'Roof cleaning', t, w, 3, ['te']);
        task('td', 'Tower dismantle', dH, wt, 4, ['rf']);
      } else {
        task('rf', 'Roof cleaning', t, w, 3);
        if(st>1) rfW.push(['b','Roof is over one storey but the tower is switched off. Our rule is tower for anything above one storey.']);
      }
      if((ty==='slate'||ty==='clay') && m!=='scrape') rfW.push(['w','Low pressure washing is not advised on slate or clay. Consider hand scrape plus biocide soft wash.']);
      if(ty==='flat' && m!=='lpw') rfW.push(['w','Scraping is not suitable for felt or membrane roofs. Use a low pressure or soft wash.']);
      if(st>=3) rfW.push(['w','Three storey roof: confirm tower height and ground conditions on site, or price for scaffold hire.']);
      o.notes.push('Roof cleaning creates debris in the gutters. We recommend a gutter clear on the same visit.');
    }
  }
  $('rfWarn').innerHTML = rfW.map(([c,t])=>`<div class="note ${c}">${t}</div>`).join('');
  o.warn.push(...rfW);

  // Conditions
  const cg = grp('Access & site conditions');
  CX.forEach(([k,l])=>{ if($(k).checked){ bill(cg, l, R[k], wCx); task(k, l, R[k], wCx, 1); } });
  if(num('cxOther')){ const l = $('cxOtherD').value || 'Other ancillary time'; bill(cg, l, num('cxOther'), wCx); task('cxo', l, num('cxOther'), wCx, 1); }

  // Fold set-up & pack-down into the first service line of each group (not shown separately to the customer)
  o.groups.forEach(g=>{
    const f = g.lines.filter(l=>l.fold); if(!f.length) return;
    const amt = f.reduce((s,l)=>s+l.amt,0);
    g.lines = g.lines.filter(l=>!l.fold);
    const main = g.lines[0];
    if(main){ main.amt += amt; main.detail += ` · incl. ${gbp(amt)} set-up & pack-down`; }
    else g.lines.push({label:g.name, amt, detail:'Set-up & pack-down'});
  });

  // Commercial
  const servicesSub = o.groups.reduce((s,g)=>s+g.lines.reduce((a,b)=>a+b.amt,0),0);
  if(ctype==='com'){
    const g = grp('Commercial');
    if($('coInd').checked){ bill(g,'Site induction', R.cx_ind, crew); task('ind','Site induction', R.cx_ind, crew, 1); }
    if($('coBar').checked){ bill(g,'Barriers / pedestrian management', R.cx_bar, wCx); task('bar','Barriers', R.cx_bar, wCx, 1); }
    if($('coOoh').checked) line(g, 'Out of hours uplift', servicesSub*R.ooh/100, `+${R.ooh}% on service work`);
    if($('coRams').checked) line(g, 'RAMS / method statement', R.rams);
    const p = num('coPerm'); if(p) line(g,'Permits / traffic management', p);
  }

  // Schedule: set-up first, pack-down last, everything else on the first free people
  task('su', 'Set-up', o.setupT/2, wSet, 0);
  task('pd', 'Pack-down', o.setupT/2, wSet, 5, o.tasks.map(t=>t.id));
  const free = Array(crew).fill(0), busy = Array(crew).fill(0), ends = {};
  o.tasks.sort((a,b)=>a.pri-b.pri).forEach(t=>{
    const earliest = Math.max(0, ...t.after.map(a=>ends[a]||0));
    const who = free.map((f,i)=>[f,i]).sort((a,b)=>Math.max(a[0],earliest)-Math.max(b[0],earliest) || a[1]-b[1]).slice(0, t.w).map(x=>x[1]).sort((a,b)=>a-b);
    t.start = Math.max(earliest, ...who.map(i=>free[i]));
    t.end = t.start + t.dur; t.who = who;
    who.forEach(i=>{ free[i] = t.end; busy[i] += t.dur; });
    ends[t.id] = t.end;
  });
  o.hours = Math.max(0, ...o.tasks.map(t=>t.end));
  o.busy = busy;
  o.idle = busy.map(b=>Math.max(0, o.hours-b));

  // Travel
  const tv = travel(); o.tv = tv;
  const tg = grp('Travel');
  const ex = Math.max(0, tv.miles - R.freeMiles);
  if(ex) line(tg, `Travel (${tv.miles} miles from base, ${R.freeMiles} free)`, ex*R.perMile, `${ex.toFixed(1)} miles × ${gbp(R.perMile)}`);
  if(tv.src==='none') o.warn.push(['w','No location yet. Enter a postcode from the list, or a miles override, so travel and diesel are counted.']);
  o.travelH = tv.miles / R.avgMph; // one way

  let sub = o.groups.reduce((s,g)=>s+g.lines.reduce((a,b)=>a+b.amt,0),0);
  const adj = num('adj');
  const ag = grp('Adjustments');
  if(adj) line(ag, adj<0?'Discount':'Adjustment', adj);
  sub += adj;
  const min = ctype==='com'?R.minCom:R.minRes;
  if(sub>0 && sub<min){ line(ag, 'Minimum charge top-up', min-sub, `Minimum ${ctype==='com'?'commercial':'residential'} job ${gbp(min)}`); sub = min; }
  o.sub = sub;
  o.vat = $('vatOn').checked ? sub*R.vat/100 : 0;
  o.total = sub + o.vat;
  o.W = crew;

  o.jobHours = o.hours + o.travelH*2;
  if(ROLE!=='admin'){ o.costs=[]; o.costTotal=0; o.profit=0; o.margin=0; return o; }
  // Costs
  const P = R.labourPaid;
  const wh = ids => o.tasks.filter(t=>ids.includes(t.id)).reduce((s,t)=>s+t.dur*t.w,0);
  const setWH = wh(['su','pd']);
  const workWH = o.tasks.filter(t=>t.id!=='su'&&t.id!=='pd').reduce((s,t)=>s+t.dur*t.w,0);
  const idleH = o.idle.reduce((s,x)=>s+x,0);
  const diesel = num('diesel'), petrol = num('petrol');
  const c = [];
  c.push(['Labour: set-up & pack-down', setWH*P, `${setWH.toFixed(2)} worker-hours × ${gbp(P)}`]);
  c.push(['Labour: cleaning & ancillary work', workWH*P, `${workWH.toFixed(1)} worker-hours × ${gbp(P)}`]);
  c.push(['Labour: idle on site', idleH*P, o.idle.map((x,i)=>x>0.01?`Worker ${i+1} ${fmtH(x)}`:'').filter(Boolean).join(' · ')]);
  c.push(['Labour travelling', o.travelH*2*crew*P, `${Math.round(o.travelH*120)} min return × ${crew} × ${gbp(P)}`]);
  const vanL = tv.miles*2 / R.vanMpg * 4.546;
  c.push(['Van diesel', vanL*diesel, `${(tv.miles*2).toFixed(1)} miles return · ${vanL.toFixed(1)} L at ${gbp(diesel)}`]);
  c.push(['Pressure washer petrol', o.rigH*R.rigLph*petrol, `${o.rigH.toFixed(1)}h × ${R.rigLph} L/h at ${gbp(petrol)}`]);
  c.push(['Kiln sand', o.cost.sand, '']);
  c.push(['Chemicals', o.cost.chem, '']);
  c.push(['Pure water', o.cost.water, `at ${gbp(R.waterCost)}/L`]);
  c.push(['Other job costs', num('otherCost'), '']);
  o.costs = c.filter(x=>x[1]>0.005);
  o.costTotal = o.costs.reduce((s,x)=>s+x[1],0);
  o.profit = sub - o.costTotal;
  o.margin = sub>0 ? o.profit/sub*100 : 0;
  o.jobHours = o.hours + o.travelH*2;
  return o;
}
function fmtH(h){ const m = Math.round(h*60); return `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`; }

/* ---------- output ---------- */
let refStr = '';
function makeRef(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); refStr = `PQ-${String(d.getFullYear()).slice(2)}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${initials()}`; editing = null; syncEditing(); }
function initials(){ const n = (ME && ME.name) || 'X'; return n.split(/[\s._-]+/).filter(Boolean).map(w=>w[0]).join('').slice(0,3).toUpperCase() || 'X'; }
let last = null;
function render(){
  const o = calc(); last = o;
  $('qref').textContent = `${refStr} · ${ctype==='com'?'Commercial':'Residential'}`; $('qrefTop').textContent = refStr;
  $('tTotal').innerHTML = gbp(o.total) + `<small>${$('vatOn').checked?'inc VAT':'no VAT'}</small>`;
  $('tSub').textContent = $('vatOn').checked ? `${gbp(o.sub)} + VAT ${gbp(o.vat)}` : 'VAT not added';
  let rows = '';
  o.groups.forEach(g=>{ if(!g.lines.length) return;
    rows += `<tr class="grp"><td colspan="2">${g.name}</td></tr>`;
    g.lines.forEach(l=> rows += `<tr><td>${esc(l.label)}${l.detail?`<span class="d">${esc(l.detail)}</span>`:''}</td><td class="a">${gbp(l.amt)}</td></tr>`);
  });
  rows += `<tr class="sum"><td>Price ex VAT</td><td class="a">${gbp(o.sub)}</td></tr>`;
  if(o.vat) rows += `<tr><td>VAT ${R.vat}%</td><td class="a">${gbp(o.vat)}</td></tr>`;
  $('tLines').innerHTML = rows;
  if(ROLE==='admin'){
  $('cLines').innerHTML = o.costs.map(([l,v,d])=>`<tr class="neg"><td>${esc(l)}${d?`<span class="d">${esc(d)}</span>`:''}</td><td class="a">${gbp(-v)}</td></tr>`).join('')
    + `<tr class="sum"><td>Total costs</td><td class="a">${gbp(o.costTotal)}</td></tr>`;
  $('pAmt').textContent = gbp(o.profit);
  $('pPct').textContent = o.margin.toFixed(0)+'%';
  $('pBox').className = 'profit ' + (o.margin>=R.targetMargin?'ok':o.margin>=R.targetMargin*0.6?'mid':'lo');
  }
  $('tWarn').innerHTML = o.warn.map(([c,t])=>`<div class="note ${c}">${esc(t)}</div>`).join('');
  $('sHrs').textContent = o.hours.toFixed(1)+'h';
  $('sTrv').textContent = Math.round(o.travelH*120)+' min';
  if(ROLE==='admin') $('sPph').textContent = o.jobHours ? gbp(o.profit/o.jobHours) : '£0.00';
  $('sDays').textContent = o.hours ? (o.hours/R.dayHours).toFixed(1) : '0';
  $('planBox').innerHTML = o.tasks.length ? `<h3>Job plan</h3><table class="lines"><tbody>${o.tasks.slice().sort((a,b)=>a.start-b.start||a.pri-b.pri).map(t=>`<tr><td>${esc(t.label)}<span class="d">${t.who.map(i=>'Worker '+(i+1)).join(', ')}</span></td><td class="a">${fmtH(t.start)}–${fmtH(t.end)}</td></tr>`).join('')}</tbody></table>`
    + o.idle.map((x,i)=>x>0.05?`<div class="note w">Worker ${i+1} idle ${fmtH(x)}${ROLE==='admin'?` (${gbp(x*R.labourPaid)} paid with nothing assigned)`:''}. Drop them off, give them another task, or accept it.</div>`:'').join('') : '';
  // location chips
  const tv = o.tv;
  let lb = '';
  if(loc) lb += `<span class="chip">${esc(loc.pc)}</span>`;
  else if(normPc($('pc').value).length>=5 && PC) lb += `<span class="chip off">Postcode not in list</span>`;
  if(tv.miles) lb += `<span class="chip">${tv.miles} miles ${tv.src==='manual'?'(manual)':'by road, est.'}</span><span class="chip">${Math.round(o.travelH*60)} min each way</span>`;
  if(PC || tv.src==='manual') $('locBox').innerHTML = lb;
  renderCustomerQuote(o);
}
/* ---------- customer quote: table preview, rich copy and plain text ---------- */
function quoteModel(o){
  const groups = o.groups.filter(g=>g.lines.length).map(g=>({name:g.name, lines:g.lines.map(l=>({label:l.label, amt:l.amt})), sub:g.lines.reduce((s,l)=>s+l.amt,0)}));
  const notes = [...new Set(o.notes)];
  notes.push('Quote valid for 30 days. Price based on the information provided; we will confirm on arrival before starting.');
  return {
    ref:refStr, date:new Date().toLocaleDateString('en-GB'),
    customer:$('cust').value.trim(), address:[$('addr').value.trim(), fmtPc($('pc').value)].filter(Boolean).join(', '),
    groups, sub:o.sub, vat:o.vat, vatRate:R.vat, total:o.total,
    annual: (ctype==='com' && num('coFreq')>1) ? {visits:num('coFreq'), total:o.total*num('coFreq')} : null,
    notes
  };
}
function quoteHTML(m){
  // inline styles so the table survives being pasted into an email
  const F = "font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;";
  const td = 'padding:6px 10px;border-bottom:1px solid #d4e4ee;vertical-align:top;';
  const num = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;';
  let h = `<div style="${F}color:#132f47;font-size:14px;line-height:1.45;max-width:640px">`;
  h += `<div style="font-size:18px;font-weight:800;letter-spacing:-.01em">Purgō exterior cleaning</div>`;
  h += `<div style="color:#53708a;font-size:13px;margin:2px 0 12px">Quote ${esc(m.ref)} &nbsp;·&nbsp; ${esc(m.date)}</div>`;
  if(m.customer || m.address) h += `<div style="margin-bottom:12px">${m.customer?`<b>${esc(m.customer)}</b><br>`:''}${esc(m.address)}</div>`;
  h += `<table style="${F}border-collapse:collapse;width:100%;font-size:14px;color:#132f47">`;
  h += `<thead><tr><th style="${td}text-align:left;background:#132f47;color:#fff;font-weight:700">Item</th><th style="${td}${num}background:#132f47;color:#fff;font-weight:700">Price</th></tr></thead><tbody>`;
  m.groups.forEach(g=>{
    h += `<tr><td colspan="2" style="${td}background:#e2eff7;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#326986">${esc(g.name)}</td></tr>`;
    g.lines.forEach(l=>{ h += `<tr><td style="${td}">${esc(l.label)}</td><td style="${td}${num}">${gbp(l.amt)}</td></tr>`; });
    h += `<tr><td style="${td}text-align:right;font-weight:700">${esc(g.name)} subtotal</td><td style="${td}${num}font-weight:700">${gbp(g.sub)}</td></tr>`;
  });
  h += `</tbody><tfoot>`;
  h += `<tr><td style="${td}text-align:right">Subtotal</td><td style="${td}${num}">${gbp(m.sub)}</td></tr>`;
  if(m.vat) h += `<tr><td style="${td}text-align:right">VAT ${m.vatRate}%</td><td style="${td}${num}">${gbp(m.vat)}</td></tr>`;
  h += `<tr><td style="padding:10px;text-align:right;font-weight:800;background:#132f47;color:#fff">Total${m.vat?'':' (no VAT)'}</td><td style="padding:10px;${num}font-weight:800;font-size:16px;background:#132f47;color:#fff">${gbp(m.total)}</td></tr>`;
  h += `</tfoot></table>`;
  if(m.annual) h += `<p style="margin:10px 0 0">Price per visit. ${m.annual.visits} visits per year = <b>${gbp(m.annual.total)}</b> a year.</p>`;
  h += `<div style="margin-top:14px;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#326986">Notes</div><ul style="margin:6px 0 0;padding-left:18px">${m.notes.map(n=>`<li style="margin:3px 0">${esc(n)}</li>`).join('')}</ul>`;
  h += `<p style="margin:14px 0 0;color:#53708a">Purgō, family run exterior cleaning<br>Tel 07930 877034 · www.purgo-clean.com</p></div>`;
  return h;
}
function quoteText(m){
  const W = 54, pad = (l,a) => { const s = gbp(a); const t = l.length > W-s.length-1 ? l.slice(0, W-s.length-2)+'…' : l; return t + ' '.repeat(Math.max(1, W - t.length - s.length)) + s; };
  const rule = '-'.repeat(W);
  const L = ['PURGŌ EXTERIOR CLEANING', `Quote ${m.ref} · ${m.date}`, ''];
  if(m.customer) L.push(m.customer); if(m.address) L.push(m.address); if(m.customer||m.address) L.push('');
  m.groups.forEach(g=>{ L.push(g.name.toUpperCase()); g.lines.forEach(l=>L.push(pad(l.label,l.amt))); L.push(pad(`${g.name} subtotal`, g.sub)); L.push(''); });
  L.push(rule, pad('Subtotal', m.sub)); if(m.vat) L.push(pad(`VAT ${m.vatRate}%`, m.vat)); L.push(pad(m.vat?'TOTAL':'TOTAL (no VAT)', m.total), rule, '');
  if(m.annual) L.push(`Price per visit. ${m.annual.visits} visits per year = ${gbp(m.annual.total)} a year.`, '');
  L.push('NOTES'); m.notes.forEach(n=>L.push('- '+n));
  L.push('', 'Purgō, family run exterior cleaning', 'Tel 07930 877034 · www.purgo-clean.com');
  return L.join('\n');
}
let lastQuoteModel = null;
function renderCustomerQuote(o){
  lastQuoteModel = quoteModel(o);
  $('qPreview').innerHTML = quoteHTML(lastQuoteModel);
}

/* ---------- save / load ---------- */
const FORM_SKIP = /^(r_|ch_|pw_)/;
function snapshot(){
  const f = {};
  document.querySelectorAll('.col input[id], .col select[id]').forEach(el=>{ if(FORM_SKIP.test(el.id)) return; f[el.id] = el.type==='checkbox' ? el.checked : el.value; });
  return {form:f, pwRows:JSON.parse(JSON.stringify(pwRows)), ctype};
}
function restore(s){
  ctype = s.ctype||'res';
  document.querySelectorAll('#ctype button').forEach(x=>x.classList.toggle('on', x.dataset.v===ctype));
  $('comBox').hidden = ctype!=='com';
  pwRows = s.pwRows||[];
  renderPw();
  Object.entries(s.form||{}).forEach(([id,v])=>{ const el=$(id); if(!el) return; if(el.type==='checkbox') el.checked=!!v; else el.value=v; });
  syncSvc(); resolvePc(); render();
}
function slug(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) || 'x'; }
function flash(t){ const m=$('toast'); m.textContent=t; m.hidden=false; clearTimeout(flash.t); flash.t=setTimeout(()=>m.hidden=true,3500); }
/* ---------- events ---------- */
document.addEventListener('input', e=>{
  const t = e.target;
  if(t.dataset.rk){ const v=parseFloat(t.value); if(!isNaN(v)){ R[t.dataset.rk]=v; markRatesDirty(); document.querySelectorAll(`[data-r="${t.dataset.rk}"]`).forEach(el=>el.textContent=v); } }
  else if(t.dataset.cf){ const c=R.chems[+t.dataset.ci]; c[t.dataset.cf] = t.dataset.cf==='name' ? t.value : (parseFloat(t.value)||0); markRatesDirty(); if(t.dataset.cf==='name') refreshChemSelects(); }
  else if(t.dataset.f){ const r=pwRows[+t.dataset.i]; r[t.dataset.f] = t.type==='checkbox' ? t.checked : t.value; }
  if(t.id==='pc') resolvePc();
  if(t.id==='diesel'||t.id==='petrol') markRatesDirty();
  render();
});
document.addEventListener('change', e=>{ if(e.target.dataset.f){ const i=+e.target.dataset.i; const r=pwRows[i]; r[e.target.dataset.f] = e.target.type==='checkbox'?e.target.checked:e.target.value; if(e.target.dataset.f==='surf' && r.surf==='block'){ r.sand = true; const cb=$('pw_d_'+i); if(cb) cb.checked = true; } } if(e.target.classList.contains('svc')) syncSvc(); render(); });
document.addEventListener('click', e=>{
  const t = e.target;
  if(t.dataset.rmpw!==undefined){ pwRows.splice(+t.dataset.rmpw,1); renderPw(); render(); }
  if(t.dataset.delchem!==undefined){ const id=R.chems[+t.dataset.delchem].id; removedChems.push(id); R.chems.splice(+t.dataset.delchem,1); pwRows.forEach(r=>{if(r.chem===id) r.chem='';}); markRatesDirty(); renderChems(); renderPw(); render(); }
});
$('pc').addEventListener('blur', ()=>{ const v=$('pc').value; if(normPc(v).length>=5){ $('pc').value = fmtPc(v); resolvePc(); render(); } });
$('addPw').onclick = ()=>{ pwRows.push({name:'Area '+(pwRows.length+1),surf:'block',sqm:0,soil:'normal',sand:true,chem:''}); renderPw(); render(); };
$('addChem').onclick = ()=>{ R.chems.push({id:'c'+Date.now(),name:'New chemical',cost:0,cover:10,markup:0}); markRatesDirty(); renderChems(); render(); };
$('resetRates').onclick = ()=>{ const keep = R.chems; R = Object.assign(clone(DEF), {chems:keep}); markRatesDirty(); renderRates(); renderPw(); render(); };
document.querySelectorAll('#ctype button').forEach(b=> b.onclick = ()=>{
  ctype = b.dataset.v; document.querySelectorAll('#ctype button').forEach(x=>x.classList.toggle('on', x===b));
  $('comBox').hidden = ctype!=='com';
  if(ctype==='com'){ $('wnMode').value='count'; }
  render();
});
$('copyQ').onclick = async ()=>{
  const m = lastQuoteModel || quoteModel(last || calc());
  const html = quoteHTML(m), text = quoteText(m);
  const done = msg => { $('copied').textContent = msg; $('copied').hidden = false; setTimeout(()=>$('copied').hidden = true, 2500); };
  try{
    if(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write){
      await navigator.clipboard.write([new ClipboardItem({'text/html': new Blob([html], {type:'text/html'}), 'text/plain': new Blob([text], {type:'text/plain'})})]);
      return done('Copied. Paste into an email to keep the table.');
    }
    await navigator.clipboard.writeText(text); done('Copied');
  }catch(e){
    try{ await navigator.clipboard.writeText(text); done('Copied'); }
    catch(e2){ const r = document.createRange(); r.selectNodeContents($('qPreview')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); done('Selected. Press copy on your keyboard.'); }
  }
};
$('newJob').onclick = ()=>{
  ['cust','addr','pc','phone','jobNotes','gtRepD','cxOtherD','milesOv'].forEach(id=>$(id).value='');
  ['adj','gtM','gtGuard','gtFas','gtRep','wnCount','wnCons','rfA','cxOther','coPerm','otherCost'].forEach(id=>$(id).value=0);
  $('workers').value=1; ['wSetup','wCx','wPw','wGt','wWn','wRf','wTower'].forEach(id=>$(id).value=''); $('rfPos').value=1; $('coFreq').value=1;
  document.querySelectorAll('#cxList input, #gtCons, #gtHeavy, #wnFirst, #coOoh, #coInd, #coBar').forEach(c=>c.checked=false);
  pwRows=[{name:'Driveway',surf:'block',sqm:0,soil:'normal',sand:true,chem:''}];
  loc = null; makeRef(); renderPw(); render();
};



/* =====================================================================
   Hosted app: sign-in, shared price list, saved quotes, admin, offline
   ===================================================================== */
const CFG = window.PURGO_CONFIG || {};
const sb = (CFG.url && CFG.key && window.supabase) ? window.supabase.createClient(CFG.url, CFG.key, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}}) : null;
const LS = {
  get(k,d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
let editing = null; // {id, ref} of the saved quote currently open
const round2 = n => Math.round((+n||0)*100)/100;
const VIEWS = ['login','quote','quotes','admin'];
const isNetErr = e => !navigator.onLine || /fetch|network|Failed to fetch|Load failed/i.test(String(e && (e.message||e)));

function syncEditing(){
  const b = $('saveCopy'); if(b) b.hidden = !editing;
  const s = $('saveQ'); if(s) s.textContent = editing ? 'Update quote' : 'Save quote';
}
function show(view){
  if(view==='admin' && ROLE!=='admin') view = 'quote';
  if(!ME && view!=='login') view = 'login';
  VIEWS.forEach(v=> $('view-'+v).hidden = v!==view);
  document.querySelectorAll('.nav button[data-view]').forEach(b=>b.classList.toggle('on', b.dataset.view===view));
  $('nav').hidden = !ME; $('tbUser').hidden = !ME;
  if(view!=='login' && location.hash!=='#'+view) history.replaceState(null,'','#'+view);
  if(view==='quotes') loadQuotes();
  if(view==='admin') loadStaff();
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav button[data-view]').forEach(b=> b.onclick = ()=>{
  if(b.dataset.view==='admin' && ratesDirty===false) renderRates();
  show(b.dataset.view);
});
window.addEventListener('hashchange', ()=>{ const v = location.hash.slice(1); if(VIEWS.includes(v) && v!=='login') show(v); });

/* ---------- network status & offline outbox ---------- */
function outbox(){ return LS.get('purgoOutbox:'+(ME&&ME.id), []); }
function setOutbox(a){ LS.set('purgoOutbox:'+(ME&&ME.id), a); updateNet(); }
function updateNet(){
  const n = $('net'); if(!n) return;
  const q = ME ? outbox().length : 0;
  n.classList.toggle('off', !navigator.onLine);
  n.textContent = navigator.onLine ? (q ? `${q} to upload` : 'Online') : (q ? `Offline · ${q} waiting` : 'Offline');
}
window.addEventListener('online', ()=>{ updateNet(); flushOutbox(); if(ME) loadPriceBook().catch(()=>{}); });
window.addEventListener('offline', updateNet);
async function flushOutbox(){
  if(!sb || !ME || !navigator.onLine) return;
  let box = outbox(); if(!box.length) return;
  const left = []; let stop = false;
  for(const item of box){
    if(stop){ left.push(item); continue; }
    try{ await pushQuote(item.rec, item.addr, item.costs); }
    catch(e){ left.push(item); if(isNetErr(e)) stop = true; }
  }
  setOutbox(left);
  if(left.length < box.length) flash(`Uploaded ${box.length-left.length} saved quote${box.length-left.length>1?'s':''}`);
}

/* ---------- sign-in ---------- */
function loginMsg(err, msg){ $('lgErr').hidden = !err; $('lgErr').textContent = err||''; $('lgMsg').hidden = !msg; $('lgMsg').textContent = msg||''; }
$('loginForm').addEventListener('submit', async e=>{
  e.preventDefault(); if(!sb) return;
  loginMsg(); $('lgBtn').disabled = true; $('lgBtn').textContent = 'Signing in…';
  const {data, error} = await sb.auth.signInWithPassword({email:$('lgEmail').value.trim(), password:$('lgPass').value});
  $('lgBtn').disabled = false; $('lgBtn').textContent = 'Sign in';
  if(error){ loginMsg(/invalid/i.test(error.message) ? 'That email and password do not match. Check them and try again.' : error.message); return; }
  $('lgPass').value = '';
  await enter(data.user);
});
$('lgForgot').onclick = async ()=>{
  const email = $('lgEmail').value.trim();
  if(!email){ loginMsg('Enter your email address first, then press Forgotten your password.'); return; }
  const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
  loginMsg(error ? error.message : '', error ? '' : 'Check your email for a link to set a new password.');
};
$('resetForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const {error} = await sb.auth.updateUser({password:$('rsPass').value});
  if(error){ loginMsg(error.message); return; }
  $('resetForm').hidden = true; $('loginForm').hidden = false; loginMsg('', 'Password saved.');
  const {data:{session}} = await sb.auth.getSession(); if(session) await enter(session.user);
});
$('signOut').onclick = async ()=>{
  if(outbox().length && !confirmInline('signOut', 'Quotes are still waiting to upload. Tap Sign out again to sign out anyway.')) return;
  if(ME) LS.del('purgoPB:'+ME.id);
  LS.del('purgoAddr'); LS.del('purgoQuotes'); quotes = []; addresses = []; quotesLoaded = false;
  $('newJob').click(); $('on-gt').checked = false; $('on-wn').checked = false; $('on-rf').checked = false; $('on-pw').checked = true; syncSvc();
  await sb.auth.signOut().catch(()=>{});
  ME = null; ROLE = null; document.body.classList.remove('is-admin');
  show('login');
};
const _confirm = {};
function confirmInline(key, msg){ if(_confirm[key] && Date.now()-_confirm[key] < 6000){ delete _confirm[key]; return true; } _confirm[key] = Date.now(); flash(msg); return false; }

async function enter(user){
  ME = {id:user.id, email:user.email, name:user.email.split('@')[0]};
  let prof = null;
  try{
    const {data, error} = await sb.from('profiles').select('name,role,active').eq('id', user.id).maybeSingle();
    if(error) throw error; prof = data; if(prof) LS.set('purgoMe:'+user.id, prof);
  }catch(e){ prof = LS.get('purgoMe:'+user.id, null); }
  if(prof && !prof.active){ await sb.auth.signOut(); ME = null; show('login'); loginMsg('Your account is switched off. Ask Purgō to switch it back on.'); return; }
  if(prof && prof.name) ME.name = prof.name;
  $('who').textContent = ME.name;
  try{ await loadPriceBook(); }
  catch(e){ ME = null; show('login'); loginMsg(e.message || 'Could not load the price list.'); return; }
  loadAddresses();
  updateNet(); flushOutbox();
  makeRef();
  const v = location.hash.slice(1);
  show(VIEWS.includes(v) && v!=='login' ? v : 'quote');
  render();
}

/* ---------- price list ---------- */
async function loadPriceBook(){
  let pb;
  try{
    const {data, error} = await sb.rpc('price_book');
    if(error) throw error;
    pb = data; LS.set('purgoPB:'+ME.id, pb);
  }catch(e){
    pb = LS.get('purgoPB:'+ME.id, null);
    if(!pb) throw new Error(isNetErr(e) ? 'You need a connection the first time you sign in on this device.' : (e.message||'Could not load the price list.'));
  }
  applyPB(pb);
}
function applyPB(pb){
  ROLE = pb.role;
  document.body.classList.toggle('is-admin', ROLE==='admin');
  const base = clone(DEF); delete base.chems;
  if(ROLE!=='admin') COST_KEYS.forEach(k=>delete base[k]);
  R = Object.assign(base, pb.rates||{});
  R.chems = (pb.chems||[]).map(c=>Object.assign({}, c));
  if(ROLE==='admin' && pb.fuel){ fuel = pb.fuel; $('diesel').value = fuel.diesel; $('petrol').value = fuel.petrol; showFuel(); }
  ratesDirty = false; removedChems = []; $('saveRates').disabled = true;
  renderRates(); refreshChemSelects(); renderPw(); render();
}
$('saveRates').onclick = async ()=>{
  const btn = $('saveRates'); btn.disabled = true; btn.textContent = 'Saving…';
  try{
    const rates = {}; Object.keys(DEF).forEach(k=>{ if(k!=='chems') rates[k] = R[k]; });
    let r = await sb.from('settings').upsert({key:'rates', value:rates, updated_at:new Date().toISOString()}); if(r.error) throw r.error;
    const d = num('diesel'), p = num('petrol');
    if(d!==fuel.diesel || p!==fuel.petrol){
      fuel = {diesel:d, petrol:p, date:new Date().toISOString().slice(0,10), source:'set by '+ME.name};
      r = await sb.from('settings').upsert({key:'fuel', value:{diesel:d, petrol:p, date:fuel.date, source:fuel.source}, updated_at:new Date().toISOString()}); if(r.error) throw r.error;
    }
    if(R.chems.length){
      r = await sb.from('chemicals').upsert(R.chems.map((c,i)=>({id:c.id, name:c.name||'Chemical', cost:+c.cost||0, cover:+c.cover||1, markup:+c.markup||0, sort:i, active:true}))); if(r.error) throw r.error;
    }
    if(removedChems.length){ r = await sb.from('chemicals').update({active:false}).in('id', removedChems); if(r.error) throw r.error; }
    await loadPriceBook();
    rateFlash('Price list saved. Staff get it next time they open the app.');
  }catch(e){ btn.disabled = false; rateFlash('Not saved: ' + (isNetErr(e) ? 'no connection. Try again when you are online.' : e.message)); }
  btn.textContent = 'Save price list';
};
function rateFlash(t){ const m=$('rateMsg'); m.textContent=t; m.hidden=false; clearTimeout(rateFlash.t); rateFlash.t=setTimeout(()=>m.hidden=true,5000); }
window.addEventListener('beforeunload', e=>{ if(ratesDirty && ROLE==='admin'){ e.preventDefault(); e.returnValue=''; } });

/* ---------- address library ---------- */
async function loadAddresses(){
  addresses = LS.get('purgoAddr', []);
  try{
    const {data, error} = await sb.from('addresses').select('line,postcode,customer,phone,notes,last_quoted').order('last_quoted', {ascending:false, nullsFirst:false}).limit(3000);
    if(error) throw error;
    addresses = data.map(a=>({line:a.line, postcode:a.postcode, customer:a.customer, phone:a.phone, notes:a.notes, lastQuoted:a.last_quoted}));
    LS.set('purgoAddr', addresses);
  }catch(e){}
}

/* ---------- save quote ---------- */
function buildRecord(o, ref){
  const line = $('addr').value.trim(), pc = fmtPc($('pc').value);
  const now = new Date().toISOString();
  const rec = {ref, customer:$('cust').value.trim(), address:line, postcode:pc, phone:$('phone').value.trim(), job_type:ctype,
    sub:round2(o.sub), vat:round2(o.vat), total:round2(o.total),
    lines:o.groups.filter(g=>g.lines.length).map(g=>({name:g.name, lines:g.lines.map(l=>({label:l.label, amt:round2(l.amt)}))})),
    state:snapshot(), created_by_name:ME.name};
  const addr = {key:slug(normPc(pc)+'-'+line), line, postcode:pc, customer:rec.customer, phone:rec.phone, notes:$('jobNotes').value.trim(), lat:loc?loc.lat:null, lng:loc?loc.lng:null, last_quoted:now};
  const costs = ROLE==='admin' ? costRecord(o) : null;
  return {rec, addr, costs};
}
function costRecord(o){ return {cost_total:round2(o.costTotal), profit:round2(o.profit), margin:Math.round(o.margin*10)/10, costs:{lines:o.costs.map(([l,v,d])=>({label:l, amt:round2(v), detail:d})), diesel:num('diesel'), petrol:num('petrol'), crew:o.crew, hours:Math.round(o.hours*100)/100}, computed_at:new Date().toISOString()}; }
async function pushQuote(rec, addr, costs){
  const {data, error} = await sb.from('quotes').upsert(rec, {onConflict:'ref'}).select('id').single();
  if(error) throw error;
  if(addr.line || addr.postcode) await sb.from('addresses').upsert(addr, {onConflict:'key'});
  if(costs){ const r = await sb.from('quote_costs').upsert(Object.assign({quote_id:data.id}, costs)); if(r.error) throw r.error; }
  return data.id;
}
async function saveQuote(asNew){
  const o = last || calc();
  if(!$('addr').value.trim() && !normPc($('pc').value)){ flash('Add an address or postcode first'); return; }
  if(!(o.sub>0)){ flash('Nothing priced yet'); return; }
  if(asNew) makeRef();
  const item = buildRecord(o, refStr); item.queuedAt = new Date().toISOString();
  const btn = $('saveQ'); btn.disabled = true;
  try{
    if(!navigator.onLine) throw new Error('offline');
    const id = await pushQuote(item.rec, item.addr, item.costs);
    editing = {id, ref:refStr}; syncEditing();
    flash(`Saved ${refStr}`);
    loadAddresses();
  }catch(e){
    if(isNetErr(e) || e.message==='offline'){
      setOutbox(outbox().filter(x=>x.rec.ref!==item.rec.ref).concat([item]));
      flash('Saved on this device. It will upload when you are back online.');
    } else flash('Could not save: ' + e.message);
  }
  btn.disabled = false;
}
$('saveQ').onclick = ()=> saveQuote(false);
$('saveCopy').onclick = ()=> saveQuote(true);

/* ---------- saved quotes list ---------- */
let quotesLoaded = false;
async function loadQuotes(){
  renderQuoteList();
  if(!sb || !navigator.onLine){ if(!quotesLoaded) quotes = LS.get('purgoQuotes', []); renderQuoteList(); return; }
  try{
    const sel = 'id,ref,status,customer,address,postcode,total,created_at,created_by,created_by_name' + (ROLE==='admin' ? ',quote_costs(profit,margin)' : '');
    const {data, error} = await sb.from('quotes').select(sel).order('created_at', {ascending:false}).limit(500);
    if(error) throw error;
    quotes = data; quotesLoaded = true; LS.set('purgoQuotes', quotes);
  }catch(e){ if(!quotesLoaded) quotes = LS.get('purgoQuotes', []); }
  const by = $('qBy'), cur = by.value;
  const names = [...new Set(quotes.map(q=>q.created_by_name).filter(Boolean))].sort();
  by.innerHTML = '<option value="">Anyone</option>' + names.map(n=>`<option ${n===cur?'selected':''}>${esc(n)}</option>`).join('');
  renderQuoteList();
}
function renderQuoteList(){
  const q = $('qSearch').value.trim().toLowerCase(), st = $('qStatus').value, by = $('qBy').value;
  const queued = ME ? outbox().map(x=>Object.assign({queued:true, status:'draft', created_at:x.queuedAt}, x.rec)) : [];
  const list = queued.concat(quotes).filter(x=>
    (!q || [x.customer,x.address,x.postcode,x.ref].join(' ').toLowerCase().includes(q)) &&
    (!st || x.status===st) && (!by || x.created_by_name===by));
  $('qSub').textContent = `${quotes.length} saved${queued.length?` · ${queued.length} waiting to upload`:''}`;
  $('qList').innerHTML = list.length ? list.slice(0,200).map(x=>{
    const qc = Array.isArray(x.quote_costs) ? x.quote_costs[0] : x.quote_costs;
    const prof = ROLE==='admin' ? (qc ? `<small style="display:block;color:var(--muted);font-size:.72rem">${gbp(qc.profit)} · ${qc.margin}%</small>` : `<small style="display:block;color:var(--muted);font-size:.72rem">open for profit</small>`) : '';
    const status = x.queued ? '<span class="pill queued">Waiting</span>' :
      `<select data-status="${x.id}" aria-label="Status">${['draft','sent','accepted','declined'].map(s=>`<option value="${s}" ${s===x.status?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select>`;
    return `<div class="qitem"><div class="m"><b>${esc(x.customer||x.address||x.ref)}</b><small>${esc(x.address||'')}${x.postcode?' · '+esc(x.postcode):''}</small><small>${esc(x.ref)} · ${x.created_at?new Date(x.created_at).toLocaleDateString('en-GB'):''} · ${esc(x.created_by_name||'')}</small></div>${status}<div class="v">${gbp(x.total||0)}${prof}</div><button class="btn sm" type="button" ${x.queued?`data-openq-local="${esc(x.ref)}"`:`data-openq="${x.id}"`}>Open</button></div>`;
  }).join('') : `<p class="hint">${quotes.length ? 'No quotes match.' : 'No saved quotes yet. Quotes appear here once someone saves one.'}</p>`;
}
['qSearch','qStatus','qBy'].forEach(id=> $(id).addEventListener('input', renderQuoteList));
$('qRefresh').onclick = loadQuotes;
document.addEventListener('change', async e=>{
  const id = e.target.dataset && e.target.dataset.status; if(!id) return;
  const {error} = await sb.from('quotes').update({status:e.target.value}).eq('id', id);
  if(error){ flash('Status not changed: ' + (isNetErr(error)?'no connection':error.message)); loadQuotes(); return; }
  const q = quotes.find(x=>x.id===id); if(q) q.status = e.target.value;
});
document.addEventListener('click', async e=>{
  const b = e.target.closest('[data-openq],[data-openq-local]'); if(!b) return;
  if(b.dataset.openqLocal){
    const it = outbox().find(x=>x.rec.ref===b.dataset.openqLocal); if(!it) return;
    refStr = it.rec.ref; restore(it.rec.state); editing = null; syncEditing(); show('quote'); return;
  }
  b.disabled = true;
  const {data, error} = await sb.from('quotes').select('id,ref,state,quote_costs(quote_id)').eq('id', b.dataset.openq).maybeSingle();
  b.disabled = false;
  if(error || !data){ flash('Could not open: ' + (error ? (isNetErr(error)?'no connection':error.message) : 'quote not found')); return; }
  refStr = data.ref; restore(data.state); editing = {id:data.id, ref:data.ref}; syncEditing();
  show('quote'); flash(`Opened ${data.ref}`);
  if(ROLE==='admin' && !(data.quote_costs && (Array.isArray(data.quote_costs) ? data.quote_costs.length : true))){
    sb.from('quote_costs').upsert(Object.assign({quote_id:data.id}, costRecord(last||calc()))).then(()=>{});
  }
});

/* ---------- staff admin ---------- */
async function loadStaff(){
  if(ROLE!=='admin') return;
  const {data, error} = await sb.from('profiles').select('id,email,name,role,active,created_at').order('created_at');
  if(error){ $('staffList').innerHTML = `<p class="note w">Could not load staff: ${esc(error.message)}</p>`; return; }
  staff = data;
  $('staffList').innerHTML = data.map(p=>{
    const me = p.id===ME.id;
    return `<div class="qitem"><div class="m"><input data-sname="${p.id}" value="${esc(p.name||'')}" aria-label="Name" style="max-width:220px"><small>${esc(p.email)}${me?' · you':''}</small></div>
      <select data-srole="${p.id}" ${me?'disabled':''} aria-label="Role"><option value="staff" ${p.role==='staff'?'selected':''}>Staff</option><option value="admin" ${p.role==='admin'?'selected':''}>Admin</option></select>
      <label class="switch">${p.active?'On':'Off'}<input type="checkbox" data-sactive="${p.id}" ${p.active?'checked':''} ${me?'disabled':''}></label><span></span></div>`;
  }).join('');
}
document.addEventListener('change', async e=>{
  const t = e.target, d = t.dataset || {};
  let id, patch;
  if(d.srole){ id = d.srole; patch = {role:t.value}; }
  else if(d.sactive){ id = d.sactive; patch = {active:t.checked}; }
  else if(d.sname){ id = d.sname; patch = {name:t.value.trim()}; }
  else return;
  const {error} = await sb.from('profiles').update(patch).eq('id', id);
  if(error) rateFlash('Not saved: ' + error.message); else { rateFlash('Staff updated'); if(d.sactive) loadStaff(); }
});

/* ---------- service worker (offline + updates) ---------- */
if('serviceWorker' in navigator && location.protocol!=='file:'){
  navigator.serviceWorker.register('sw.js').then(reg=>{ setInterval(()=>reg.update().catch(()=>{}), 60*60*1000); }).catch(()=>{});
}

/* ---------- start ---------- */
async function boot(){
  renderCx(); renderRates(); renderPw(); syncSvc(); render(); updateNet();
  if(!sb){ show('login'); $('loginForm').hidden = true; loginMsg('This app is not connected to its database yet. Add the Supabase details to config.js.'); return; }
  sb.auth.onAuthStateChange((ev, session)=>{
    if(ev==='PASSWORD_RECOVERY'){ show('login'); $('loginForm').hidden = true; $('resetForm').hidden = false; loginMsg(); }
    if(ev==='SIGNED_OUT' && ME){ ME = null; ROLE = null; document.body.classList.remove('is-admin'); show('login'); }
  });
  const {data:{session}} = await sb.auth.getSession();
  if(session && !/type=recovery/.test(location.hash)) await enter(session.user);
  else if(!/type=recovery/.test(location.hash)) show('login');
}
boot();
