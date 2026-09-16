import http from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 7860);
const DATA_DIR = process.env.CENTRALYSER_DATA_DIR || "/data";
const CONFIG_FILE = join(DATA_DIR, "centralyser.json");
const ADMIN_KEY = process.env.CENTRALYSER_ADMIN_KEY || "";
const BETTERPOSTER = "https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=fr";
const MANIFEST_TIMEOUT = 8000;
const cache = new Map();
let config = { addons: [] };

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.addons)) config = parsed;
  } catch (e) { if (e.code !== "ENOENT") console.error(`[config] ${e.message}`); }
}
async function saveConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2));
  await rename(tmp, CONFIG_FILE);
}
function normalizeManifestUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error("L'URL doit commencer par http:// ou https://");
  const url = new URL(raw);
  if (!url.pathname || url.pathname === "/") url.pathname = "/manifest.json";
  else if (!url.pathname.endsWith(".json")) url.pathname = `${url.pathname.replace(/\/$/, "")}/manifest.json`;
  return url.toString();
}
async function fetchJson(url, timeout = MANIFEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: controller.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Délai dépassé après ${timeout / 1000}s en lisant le manifest`);
    throw e;
  } finally { clearTimeout(timer); }
}
function validManifest(m) {
  if (!m || typeof m !== "object") throw new Error("Manifest invalide");
  return { ...m, catalogs: Array.isArray(m.catalogs) ? m.catalogs : [], types: Array.isArray(m.types) ? m.types : [] };
}
function manifestInfo(m, addon) {
  return { id:m.id||null, name:m.name||addon.name, version:m.version||null, description:m.description||"", types:m.types||[], resources:m.resources||[], catalogs:m.catalogs||[] };
}
async function getManifest(addon, force = false) {
  const hit = cache.get(addon.id);
  if (!force && hit && Date.now() - hit.time < 60000) return hit.data;
  const data = validManifest(await fetchJson(addon.manifestUrl));
  cache.set(addon.id, { time: Date.now(), data });
  addon.manifest = manifestInfo(data, addon);
  return data;
}
function baseUrl(manifestUrl) {
  const u = new URL(manifestUrl);
  u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  u.search = ""; u.hash = "";
  return u.toString().replace(/\/$/, "");
}
function endpoint(addon, kind, type, id, search) {
  const u = new URL(`${baseUrl(addon.manifestUrl)}/${kind}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  for (const [k, v] of search) u.searchParams.set(k, v);
  return u.toString();
}
function imdbId(item) {
  if (!item || typeof item !== "object") return null;
  for (const v of [item.imdb_id, item.imdbId, item.imdb, item.imdbid, item.id]) {
    const m = String(v || "").match(/tt\d+/i);
    if (m) return m[0].toLowerCase();
  }
  return null;
}
function better(data) {
  const patch = (x) => { const id = imdbId(x); if (id) x.poster = BETTERPOSTER.replace("{imdb_id}", id); };
  if (Array.isArray(data?.metas)) data.metas.forEach(patch);
  if (data?.meta && typeof data.meta === "object") patch(data.meta);
  return data;
}
function findAddon(id) { return config.addons.find(a => a.id === id); }
function allowed(req, u) { return !ADMIN_KEY || req.headers["x-centralyser-key"] === ADMIN_KEY || u.searchParams.get("key") === ADMIN_KEY; }
function json(res, status, data) { const b = JSON.stringify(data); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-centralyser-key" }); res.end(b); }
function body(req) { return new Promise((resolve, reject) => { let s=""; req.on("data", c => { s += c; if (s.length > 1000000) req.destroy(new Error("Request too large")); }); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("JSON invalide")); } }); req.on("error", reject); }); }
async function info(addon) {
  if (addon.manifest && Array.isArray(addon.manifest.catalogs)) {
    return { ...addon, manifest: addon.manifest, error:null };
  }
  try {
    const m = await getManifest(addon);
    return { ...addon, manifest: manifestInfo(m, addon), error:null };
  } catch (e) {
    return { ...addon, manifest: { id:null, name:addon.name, version:null, description:"", types:[], resources:[], catalogs:[] }, error:e.message };
  }
}
async function buildManifest() {
  const catalogs=[]; const types=new Set();
  for (const addon of config.addons) {
    try {
      const m=cache.has(addon.id) ? cache.get(addon.id).data : (addon.manifest || await getManifest(addon));
      (m.types||[]).forEach(t=>types.add(t));
      for(const c of (m.catalogs||[])) if((addon.selectedCatalogs||[]).includes(c.id)) catalogs.push({...c,id:`centralyser__${addon.id}__${c.id}`});
    } catch(e){ console.error(`[manifest] ${addon.name}: ${e.message}`); }
  }
  return { id:"com.dlambda.centralyser", version:"1.0.0", name:"Centralyser", description:"Hub personnel configurable de catalogues Stremio.", resources:["catalog","meta"], types:[...types], catalogs };
}
function parseCat(id) { const m=/^centralyser__([^_]+)__(.+)$/.exec(id); return m ? {addonId:m[1], catalogId:m[2]} : null; }
function page() { return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Centralyser</title><style>body{font-family:system-ui;margin:0;background:#111827;color:#f9fafb}main{max-width:900px;margin:auto;padding:24px}section{background:#1f2937;border-radius:14px;padding:18px;margin:16px 0}input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:white;margin:6px 0 12px}button{padding:10px 14px;border:0;border-radius:8px;cursor:pointer;margin:3px}button.primary{background:#60a5fa;color:#08111f;font-weight:700}button:disabled{opacity:.55;cursor:wait}.status{margin-top:12px;padding:12px;border-radius:9px;display:none}.status.ok{display:block;background:#123b2a;color:#b8f5d0}.status.err{display:block;background:#4a1d24;color:#ffd0d5}.status.wait{display:block;background:#243047;color:#dbeafe}.addon{border:1px solid #374151;border-radius:10px;padding:14px;margin:10px 0}.addon.ok{border-color:#25634a}.catalog{display:block;padding:8px 0;border-top:1px solid #374151}.muted{color:#9ca3af}.row{display:flex;gap:8px;flex-wrap:wrap}a{color:#93c5fd}.count{font-size:.8em;color:#93c5fd;font-weight:500}</style></head><body><main><h1>🧩 Centralyser</h1><p class="muted">Ajoute tes addons, choisis les catalogues à exposer dans Nuvio, puis modifie-les quand tu veux.</p><section><h2>Ajouter un addon</h2><label>Nom (facultatif)</label><input id="name" placeholder="Ex. FrankenStream"><label>URL du manifest</label><input id="url" placeholder="https://... ou https://.../manifest.json"><button id="addBtn" class="primary" onclick="add()">Ajouter et lire le manifest</button><div id="addStatus" class="status"></div></section><section id="addonsSection"><h2>Mes addons <span id="count" class="count"></span></h2><div id="addons">Vérification de la configuration…</div></section><section><h2>BetterPoster</h2><p class="muted">Activé automatiquement pour les fiches possédant un identifiant IMDb.</p></section><section><h2>Manifest Centralyser</h2><p><a href="/manifest.json" target="_blank">/manifest.json</a></p><p class="muted">À installer une seule fois dans Nuvio.</p></section></main><script>
const key=localStorage.getItem('centralyserKey')||'';const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(p,o={}){o.headers={...(o.headers||{}),'content-type':'application/json','x-centralyser-key':key};const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),15000);o.signal=ctl.signal;try{const r=await fetch(p,o);let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||r.statusText);return d}catch(e){if(e.name==='AbortError')throw Error('La requête a pris trop de temps.');throw e}finally{clearTimeout(t)}}
async function load(){const box=document.getElementById('addons');box.textContent='Vérification de la configuration…';try{const d=await api('/api/addons');render(d.addons||[])}catch(e){box.innerHTML='<p>⚠️ Erreur de chargement : '+esc(e.message)+'</p><button onclick="load()">Réessayer</button>'}}
function render(as){const box=document.getElementById('addons');document.getElementById('count').textContent=as.length?'('+as.length+')':'';if(!as.length){box.innerHTML='<p class="muted">Aucun addon configuré pour le moment.</p><p class="muted">Ajoute ton premier addon ci-dessus. Une fois confirmé, le formulaire reste disponible pour en ajouter un deuxième, troisième, etc.</p>';return}box.innerHTML=as.map(a=>{const m=a.manifest||{};const sel=new Set(a.selectedCatalogs||[]);return '<div class="addon ok"><h3>✅ '+esc(a.name||m.name||a.manifestUrl)+'</h3><div class="muted">'+esc(a.manifestUrl)+'</div>'+(a.error?'<p>⚠️ '+esc(a.error)+'</p>':'<p>Manifest lu avec succès · '+((m.catalogs||[]).length)+' catalogue(s) détecté(s).</p>')+'<div class="row"><button onclick="all(\''+a.id+'\',true)">Tout sélectionner</button><button onclick="all(\''+a.id+'\',false)">Tout désélectionner</button><button onclick="refresh(\''+a.id+'\')">Actualiser</button><button onclick="edit(\''+a.id+'\')">Modifier URL</button><button onclick="del(\''+a.id+'\')">Supprimer</button></div>'+((m.catalogs||[]).map(c=>'<label class="catalog"><input type="checkbox" '+(sel.has(c.id)?'checked':'')+' onchange="toggle(\''+a.id+'\',\''+esc(c.id)+'\',this.checked)"> '+esc(c.name||c.title||c.id)+' <span class="muted">('+esc(c.type)+')</span></label>').join(''))+'</div>'}).join('')}
async function add(){const btn=document.getElementById('addBtn'),status=document.getElementById('addStatus');const url=document.getElementById('url').value.trim();const name=document.getElementById('name').value.trim();status.className='status';status.textContent='';if(!url){status.className='status err';status.textContent='❌ Entre une URL de manifest.';return}btn.disabled=true;btn.textContent='Ajout en cours…';status.className='status wait';status.textContent='⏳ Lecture et validation du manifest…';try{const result=await api('/api/addons',{method:'POST',body:JSON.stringify({url,name})});document.getElementById('url').value='';document.getElementById('name').value='';status.className='status ok';status.textContent='✅ '+(result.name||name||'Addon')+' a bien été ajouté et son manifest a été lu. Tu peux maintenant en ajouter un autre.';await load();document.getElementById('addonsSection').scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>document.getElementById('name').focus(),500)}catch(e){status.className='status err';status.textContent='❌ Ajout impossible : '+e.message}finally{btn.disabled=false;btn.textContent='Ajouter un autre addon';}}
async function toggle(id,c,on){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const s=new Set(a.selectedCatalogs||[]);on?s.add(c):s.delete(c);await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:[...s]})});load()}catch(e){alert('Impossible de modifier le catalogue : '+e.message)}}
async function all(id,on){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const ids=on?(a.manifest.catalogs||[]).map(c=>c.id):[];await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:ids})});load()}catch(e){alert(e.message)}}
async function refresh(id){try{await api('/api/addons/'+id+'/refresh',{method:'POST'});load()}catch(e){alert('Actualisation impossible : '+e.message)}}
async function edit(id){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const u=prompt('Nouvelle URL du manifest',a.manifestUrl);if(u&&u!==a.manifestUrl){await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({url:u})});load()}}catch(e){alert('Modification impossible : '+e.message)}}
async function del(id){if(confirm('Supprimer cet addon ?')){try{await api('/api/addons/'+id,{method:'DELETE'});load()}catch(e){alert('Suppression impossible : '+e.message)}}}
load();</script></body></html>`; }

await loadConfig();
http.createServer(async (req,res)=>{const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);const p=u.pathname.split('/').filter(Boolean);try{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'content-type,x-centralyser-key'});return res.end()}
  if(u.pathname==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page())}
  if(u.pathname==='/health'&&req.method==='GET')return json(res,200,{status:'ok',addon:'Centralyser',configuredAddons:config.addons.length,betterPoster:true});
  if(u.pathname==='/manifest.json'&&req.method==='GET')return json(res,200,await buildManifest());
  if(p[0]==='api'&&p[1]==='addons'){
    if(!allowed(req,u))return json(res,401,{error:'Admin key required'});
    if(req.method==='GET'&&p.length===2)return json(res,200,{addons:config.addons.map(a=>({...a,manifest:a.manifest||{id:null,name:a.name,version:null,description:'',types:[],resources:[],catalogs:[]},error:null}))});
    if(req.method==='POST'&&p.length===2){const b=await body(req);const url=normalizeManifestUrl(b.url);const a={id:randomUUID().replaceAll('-','').slice(0,12),name:String(b.name||'').trim()||url,manifestUrl:url,selectedCatalogs:[]};const m=validManifest(await fetchJson(url));a.manifest=manifestInfo(m,a);cache.set(a.id,{time:Date.now(),data:m});config.addons.push(a);await saveConfig();return json(res,201,{...a,error:null});}
    if(p.length>=3){const id=p[2],a=findAddon(id);if(!a)return json(res,404,{error:'Addon introuvable'});if(req.method==='DELETE'&&p.length===3){config.addons=config.addons.filter(x=>x.id!==id);cache.delete(id);await saveConfig();return json(res,200,{ok:true})}if(req.method==='POST'&&p[3]==='refresh'){const m=validManifest(await fetchJson(a.manifestUrl));a.manifest=manifestInfo(m,a);cache.set(id,{time:Date.now(),data:m});a.selectedCatalogs=(a.selectedCatalogs||[]).filter(x=>m.catalogs.some(c=>c.id===x));await saveConfig();return json(res,200,{...a,error:null})}if(req.method==='PUT'&&p.length===3){const b=await body(req);if(b.name!==undefined)a.name=String(b.name||a.name);if(b.url!==undefined){a.manifestUrl=normalizeManifestUrl(b.url);a.manifest=undefined;cache.delete(id);const m=validManifest(await fetchJson(a.manifestUrl));a.manifest=manifestInfo(m,a);cache.set(id,{time:Date.now(),data:m})}if(Array.isArray(b.selectedCatalogs))a.selectedCatalogs=[...new Set(b.selectedCatalogs.map(String))];await saveConfig();return json(res,200,{...a,error:null})}}
    return json(res,404,{error:'Route API inconnue'});
  }
  if(req.method!=='GET')return json(res,405,{error:'Méthode non autorisée'});
  if(p[0]==='catalog'&&p.length===3&&p[2].endsWith('.json')){const q=parseCat(decodeURIComponent(p[2].slice(0,-5)));if(!q)return json(res,404,{error:'Catalogue inconnu'});const a=findAddon(q.addonId);if(!a)return json(res,404,{error:'Addon inconnu'});return json(res,200,better(await fetchJson(endpoint(a,'catalog',p[1],q.catalogId,u.searchParams),15000)))}
  if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){const type=p[1],id=decodeURIComponent(p[2].slice(0,-5));for(const a of config.addons){try{const m=cache.has(a.id)?cache.get(a.id).data:(a.manifest||await getManifest(a));const prefixes=m.idPrefixes||[];if(prefixes.length&&!prefixes.some(x=>id.startsWith(x)))continue;const d=await fetchJson(endpoint(a,'meta',type,id,u.searchParams),15000);if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length))return json(res,200,better(d))}catch(e){console.error(`[meta] ${a.name}: ${e.message}`)}}return json(res,200,{meta:null})}
  return json(res,404,{error:'Not found'});
}catch(e){console.error(e);return json(res,502,{error:e.message})}}).listen(PORT,'0.0.0.0',()=>console.log(`Centralyser listening on ${PORT}`));
