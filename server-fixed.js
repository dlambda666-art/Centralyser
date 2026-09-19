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
const STREAM_TIMEOUT = 15000;
const cache = new Map();
let config = { addons: [] };

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.addons)) config = parsed;
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`[config] ${e.message}`);
  }
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
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Centralyser/1.0"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!r.ok) {
      const retryAfter = r.headers.get("retry-after");
      if (r.status === 429) console.warn(`[fetch] 429 Too Many Requests for ${url}${retryAfter ? `; retry-after=${retryAfter}` : ""}`);
      throw new Error(`${r.status} ${r.statusText}`);
    }
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
  return { id: m.id || null, name: m.name || addon.name, version: m.version || null, description: m.description || "", types: m.types || [], resources: m.resources || [], catalogs: m.catalogs || [], idPrefixes: m.idPrefixes || [] };
}
function supportsStream(m) {
  if (Array.isArray(m?.resources) && m.resources.some(r => r === "stream" || (r && typeof r === "object" && r.name === "stream"))) return true;
  const name = String(m?.name || "").toLowerCase();
  const shortName = String(m?.short_name || "").toLowerCase();
  return name.includes("aiostream") || shortName.includes("aiostream") || name.includes("duckstreams") || shortName.includes("duckstreams");
}
async function getManifest(addon, force = false) {
  const hit = cache.get(addon.id);
  if (!force && hit && Date.now() - hit.time < 60000) return hit.data;
  const data = validManifest(await fetchJson(addon.manifestUrl));
  cache.set(addon.id, { time: Date.now(), data });
  addon.manifest = manifestInfo(data, addon);
  addon.manifest.streamSupported = supportsStream(data);
  return data;
}
function baseUrl(manifestUrl) {
  const u = new URL(manifestUrl);
  u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  u.search = ""; u.hash = "";
  return u.toString().replace(/\/$/, "");
}
function endpoint(addon, kind, type, id, search) {
  const entries = [...search];
  const extra = kind === 'catalog' && entries.length
    ? '/' + entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') + '.json'
    : '.json';
  const u = new URL(baseUrl(addon.manifestUrl) + '/' + kind + '/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + extra);
  // Preserve configuration/auth query parameters carried by personalized manifests.
  const manifestUrl = new URL(addon.manifestUrl);
  for (const [k, v] of manifestUrl.searchParams) u.searchParams.set(k, v);
  // Non-catalog resources may still carry query parameters.
  if (kind !== 'catalog') for (const [k, v] of entries) u.searchParams.set(k, v);
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
function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-centralyser-key" });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1000000) req.destroy(new Error("Request too large")); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("JSON invalide")); } });
    req.on("error", reject);
  });
}

const APP_JS = String.raw`const key=localStorage.getItem('centralyserKey')||'';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opts={}){opts.headers={...(opts.headers||{}),'content-type':'application/json','x-centralyser-key':key};const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),15000);opts.signal=ctl.signal;try{const r=await fetch(path,opts);let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||r.statusText);return d}catch(e){if(e.name==='AbortError')throw new Error('La requête a pris trop de temps.');throw e}finally{clearTimeout(timer)}}
async function load(){const box=document.getElementById('addons');box.textContent='Chargement de la configuration…';try{const d=await api('/api/addons');render(d.addons||[])}catch(e){box.innerHTML='<p>⚠️ Erreur de chargement : '+esc(e.message)+'</p><button onclick="load()">Réessayer</button>'}}
function render(as){const box=document.getElementById('addons');document.getElementById('count').textContent=as.length?'('+as.length+')':'';if(!as.length){box.innerHTML='<p class="muted">Aucun addon configuré pour le moment.</p><p class="muted">Ajoute ton premier addon ci-dessus.</p>';return}box.innerHTML=as.map(a=>{const m=a.manifest||{};const sel=new Set(a.selectedCatalogs||[]);const cats=(m.catalogs||[]).map(c=>'<label class="catalog"><input type="checkbox" '+(sel.has(c.id)?'checked':'')+' onchange="toggle(\''+a.id+'\',\''+esc(c.id)+'\',this.checked)"> '+esc(c.name||c.title||c.id)+' <span class="muted">('+esc(c.type||'')+')</span></label>').join('');const stream=m.streamSupported?'<label class="stream"><input type="checkbox" '+(a.streamEnabled?'checked':'')+' onchange="toggleStream(\''+a.id+'\',this.checked)"> ▶️ Utiliser pour les flux</label>':'';return '<div class="addon ok"><h3>✅ '+esc(a.name||m.name||a.manifestUrl)+'</h3><div class="muted">'+esc(a.manifestUrl)+'</div><p>Manifest lu avec succès · '+((m.catalogs||[]).length)+' catalogue(s) détecté(s).</p><div class="row"><button onclick="all(\''+a.id+'\',true)">Tout sélectionner</button><button onclick="all(\''+a.id+'\',false)">Tout désélectionner</button><button onclick="refresh(\''+a.id+'\')">Actualiser</button><button onclick="edit(\''+a.id+'\')">Modifier URL</button><button onclick="del(\''+a.id+'\')">Supprimer</button></div>'+cats+stream+'</div>'}).join('')}
async function add(){const btn=document.getElementById('addBtn'),status=document.getElementById('addStatus'),url=document.getElementById('url').value.trim(),name=document.getElementById('name').value.trim();status.className='status';status.textContent='';if(!url){status.className='status err';status.textContent='❌ Entre une URL de manifest.';return}btn.disabled=true;btn.textContent='Lecture du manifest…';status.className='status wait';status.textContent='⏳ Lecture du manifest depuis ton navigateur…';try{let manifest=null;try{const mr=await fetch(url,{headers:{accept:'application/json'},redirect:'follow'});if(!mr.ok)throw new Error('HTTP '+mr.status);manifest=await mr.json()}catch(e){throw new Error('Le manifest est accessible dans le navigateur mais le serveur Centralyser est limité par le fournisseur (429). Réessaie après quelques secondes.')}const r=await api('/api/addons',{method:'POST',body:JSON.stringify({url,name,manifest})});document.getElementById('url').value='';document.getElementById('name').value='';status.className='status ok';status.textContent='✅ '+(r.name||name||'Addon')+' a bien été ajouté sans requête serveur vers le manifest.';await load()}catch(e){status.className='status err';status.textContent='❌ Ajout impossible : '+e.message}finally{btn.disabled=false;btn.textContent='Ajouter un autre addon'}}
async function toggle(id,c,on){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const s=new Set(a.selectedCatalogs||[]);on?s.add(c):s.delete(c);await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:[...s]})});load()}catch(e){alert('Impossible de modifier le catalogue : '+e.message)}}
async function toggleStream(id,on){try{await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({streamEnabled:on})});load()}catch(e){alert('Impossible de modifier le fournisseur de flux : '+e.message)}}
async function all(id,on){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const ids=on?(a.manifest.catalogs||[]).map(c=>c.id):[];await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:ids})});load()}catch(e){alert(e.message)}}
async function refresh(id){try{await api('/api/addons/'+id+'/refresh',{method:'POST'});load()}catch(e){alert('Actualisation impossible : '+e.message)}}
async function edit(id){try{const a=(await api('/api/addons')).addons.find(x=>x.id===id);const u=prompt('Nouvelle URL du manifest',a.manifestUrl);if(u&&u!==a.manifestUrl)await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({url:u})});load()}catch(e){alert('Modification impossible : '+e.message)}}
async function del(id){if(confirm('Supprimer cet addon ?'))try{await api('/api/addons/'+id,{method:'DELETE'});load()}catch(e){alert('Suppression impossible : '+e.message)}}
window.addEventListener('DOMContentLoaded',()=>{load()});`;

function page() {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>Centralyser</title><style>body{font-family:system-ui;margin:0;background:#111827;color:#f9fafb}main{max-width:900px;margin:auto;padding:24px}section{background:#1f2937;border-radius:14px;padding:18px;margin:16px 0}input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:white;margin:6px 0 12px}button{padding:10px 14px;border:0;border-radius:8px;cursor:pointer;margin:3px}button.primary{background:#60a5fa;color:#08111f;font-weight:700}button:disabled{opacity:.55;cursor:wait}.status{margin-top:12px;padding:12px;border-radius:9px;display:none}.status.ok{display:block;background:#123b2a;color:#b8f5d0}.status.err{display:block;background:#4a1d24;color:#ffd0d5}.status.wait{display:block;background:#243047;color:#dbeafe}.addon{border:1px solid #374151;border-radius:10px;padding:14px;margin:10px 0}.addon.ok{border-color:#25634a}.catalog,.stream{display:block;padding:8px 0;border-top:1px solid #374151}.stream{font-weight:700;color:#bfdbfe}.muted{color:#9ca3af}.row{display:flex;gap:8px;flex-wrap:wrap}a{color:#93c5fd}.count{font-size:.8em;color:#93c5fd;font-weight:500}</style></head><body><main><h1>🧩 Centralyser</h1><p class="muted">Ajoute tes addons, choisis les catalogues à exposer dans Nuvio, puis modifie-les quand tu veux.</p><section><h2>Ajouter un addon</h2><label>Nom (facultatif)</label><input id="name" placeholder="Ex. FrankenStream"><label>URL du manifest</label><input id="url" placeholder="https://... ou https://.../manifest.json"><button id="addBtn" class="primary" onclick="add()">Ajouter et lire le manifest</button><div id="addStatus" class="status"></div></section><section id="addonsSection"><h2>Mes addons <span id="count" class="count"></span></h2><div id="addons">Chargement de la configuration…</div></section><section><h2>BetterPoster</h2><p class="muted">Activé automatiquement pour les fiches possédant un identifiant IMDb.</p></section><section><h2>Manifest Centralyser</h2><p><a href="/manifest.json" target="_blank">/manifest.json</a></p><p class="muted">À installer une seule fois dans Nuvio.</p></section></main><script src="/app.js?v=2" defer></script></body></html>`;
}

await loadConfig();
http.createServer(async (req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||"localhost"}`),p=u.pathname.split('/').filter(Boolean);
  try {
    if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'content-type,x-centralyser-key'});return res.end()}
    if(u.pathname==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page())}
    if(u.pathname==='/app.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store'});return res.end(APP_JS)}
    if(u.pathname==='/health'&&req.method==='GET')return json(res,200,{status:'ok',addon:'Centralyser',configuredAddons:config.addons.length,betterPoster:true,streamProviders:config.addons.filter(a=>a.streamEnabled).length})
    if(u.pathname==='/manifest.json'&&req.method==='GET')return json(res,200,await buildManifest())
    if(p[0]==='api'&&p[1]==='addons'){
      if(!allowed(req,u))return json(res,401,{error:'Admin key required'});
      if(req.method==='GET'&&p.length===2)return json(res,200,{addons:config.addons.map(a=>({...a,manifest:a.manifest||{id:null,name:a.name,version:null,description:'',types:[],resources:[],catalogs:[],streamSupported:false},error:null}))});
      if(req.method==='POST'&&p.length===2){const b=await body(req),url=normalizeManifestUrl(b.url),a={id:randomUUID().replaceAll('-','').slice(0,12),name:String(b.name||'').trim()||url,manifestUrl:url,selectedCatalogs:[],streamEnabled:false},m=validManifest(b.manifest&&typeof b.manifest==='object'?b.manifest:await fetchJson(url));a.manifest=manifestInfo(m,a);a.manifest.streamSupported=supportsStream(m);cache.set(a.id,{time:Date.now(),data:m});config.addons.push(a);await saveConfig();return json(res,201,{...a,error:null})}
      if(p.length>=3){const id=p[2],a=findAddon(id);if(!a)return json(res,404,{error:'Addon introuvable'});if(req.method==='DELETE'&&p.length===3){config.addons=config.addons.filter(x=>x.id!==id);cache.delete(id);await saveConfig();return json(res,200,{ok:true})}if(req.method==='POST'&&p[3]==='refresh'){const m=validManifest(await fetchJson(a.manifestUrl));a.manifest=manifestInfo(m,a);a.manifest.streamSupported=supportsStream(m);cache.set(id,{time:Date.now(),data:m});a.selectedCatalogs=(a.selectedCatalogs||[]).filter(x=>m.catalogs.some(c=>c.id===x));if(!a.manifest.streamSupported)a.streamEnabled=false;await saveConfig();return json(res,200,{...a,error:null})}if(req.method==='PUT'&&p.length===3){const b=await body(req);if(b.name!==undefined)a.name=String(b.name||a.name);if(b.url!==undefined){a.manifestUrl=normalizeManifestUrl(b.url);a.manifest=undefined;cache.delete(id);const m=validManifest(await fetchJson(a.manifestUrl));a.manifest=manifestInfo(m,a);a.manifest.streamSupported=supportsStream(m);if(!a.manifest.streamSupported)a.streamEnabled=false;cache.set(id,{time:Date.now(),data:m})}if(Array.isArray(b.selectedCatalogs))a.selectedCatalogs=[...new Set(b.selectedCatalogs.map(String))];if(b.streamEnabled!==undefined)a.streamEnabled=Boolean(b.streamEnabled)&&Boolean(a.manifest?.streamSupported);await saveConfig();return json(res,200,{...a,error:null})}}
      return json(res,404,{error:'Route API inconnue'});
    }
    if(req.method!=='GET')return json(res,405,{error:'Méthode non autorisée'});
    if(p[0]==='catalog'&&p.length>=3){
      const type=decodeURIComponent(p[1]||'');
      const catalogToken=decodeURIComponent(p[2]||'');
      const dot=catalogToken.lastIndexOf('.json');
      // Stremio search routes use /catalog/type/catalogId/search=query.json:
      // the catalog id itself has no .json suffix in that form.
      const rawId=dot>=0?catalogToken.slice(0,dot):catalogToken;
      const sep=rawId.indexOf('__');
      const sep2=sep<0?-1:rawId.indexOf('__',sep+2);
      if(!rawId.startsWith('centralyser__')||sep2<0)return json(res,404,{error:'Catalogue inconnu'});
      const addonId=rawId.slice('centralyser__'.length,sep2);
      const catalogId=rawId.slice(sep2+2);
      const a=findAddon(addonId);
      if(!a)return json(res,404,{error:'Addon inconnu'});
      const extra=new URLSearchParams(u.searchParams);
      for(const segment of p.slice(3)){
        const s=decodeURIComponent(segment);
        if(!s.endsWith('.json'))continue;
        for(const [k,v] of new URLSearchParams(s.slice(0,-5)))extra.set(k,v);
      }
      const searchText=extra.get('search')?.trim()||'';
      const requested=await fetchJson(endpoint(a,'catalog',type,catalogId,extra),15000);
      if(searchText&&Array.isArray(requested?.metas)){
        const q=searchText.toLocaleLowerCase().split(/\\s+/).filter(Boolean);
        const direct=requested.metas.filter(m=>{
          const hay=String(m?.name||'').toLocaleLowerCase();
          return q.every(word=>hay.includes(word));
        });
        // Frank/FSE may return only the newest matching title. Only in that
        // case, scan a few older pages of this same catalog for saga entries.
        if(direct.length<=1){
          const merged=[]; const seen=new Set();
          const add=items=>{for(const m of items||[]){const k=String(m?.id||m?.name||'');if(!k||seen.has(k))continue;seen.add(k);merged.push(m)}};
          add(direct);
          for(const skip of [100,200,300]){
            try{
              const page=await fetchJson(endpoint(a,'catalog',type,catalogId,new URLSearchParams([['skip',String(skip)]])),12000);
              const hits=Array.isArray(page?.metas)?page.metas.filter(m=>{
                const hay=String(m?.name||'').toLocaleLowerCase();
                return q.every(word=>hay.includes(word));
              }):[];
              add(hits);
              if(merged.length>=10)break;
            }catch(e){
              console.error(`[catalog-search] ${a.name}/${catalogId} skip=${skip}: ${e.message}`);
              break;
            }
          }
          return json(res,200,better({...requested,metas:merged}));
        }
        return json(res,200,better({...requested,metas:direct}));
      }
      return json(res,200,better(requested));
    }
    if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){const type=p[1],id=decodeURIComponent(p[2].slice(0,-5));for(const a of config.addons){try{const m=cache.has(a.id)?cache.get(a.id).data:(a.manifest||await getManifest(a)),prefixes=m.idPrefixes||[];if(prefixes.length&&!prefixes.some(x=>id.startsWith(x)))continue;const d=await fetchJson(endpoint(a,'meta',type,id,u.searchParams),15000);if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length))return json(res,200,better(d))}catch(e){console.error(`[meta] ${a.name}: ${e.message}`)}}return json(res,200,{meta:null})}
    if(p[0]==='stream'&&p.length===3&&p[2].endsWith('.json')){const type=p[1],id=decodeURIComponent(p[2].slice(0,-5)),streams=[];for(const a of config.addons){if(!a.streamEnabled)continue;try{const m=cache.has(a.id)?cache.get(a.id).data:(a.manifest||await getManifest(a));if(!supportsStream(m))continue;const d=await fetchJson(endpoint(a,'stream',type,id,u.searchParams),STREAM_TIMEOUT);if(Array.isArray(d?.streams))streams.push(...d.streams)}catch(e){console.error(`[stream] ${a.name}: ${e.message}`)}}const seen=new Set(),unique=streams.filter(s=>{const k=String(s?.url||s?.externalUrl||s?.infoHash||s?.name||'');if(!k||seen.has(k))return false;seen.add(k);return true});return json(res,200,{streams:unique})}
    return json(res,404,{error:'Not found'});
  } catch(e){console.error(e);return json(res,502,{error:e.message})}
}).listen(PORT,'0.0.0.0',()=>console.log(`Centralyser listening on ${PORT}`));

async function buildManifest(){const catalogs=[],types=new Set();let hasStream=false;for(const addon of config.addons){try{const m=cache.has(addon.id)?cache.get(addon.id).data:(addon.manifest||await getManifest(addon));(m.types||[]).forEach(t=>types.add(t));for(const c of m.catalogs||[])if((addon.selectedCatalogs||[]).includes(c.id)){const extra=Array.isArray(c.extra)?[...c.extra]:[];if(!extra.some(e=>e&&e.name==='search'))extra.push({name:'search',isRequired:false});catalogs.push({...c,extra,id:`centralyser__${addon.id}__${c.id}`});}if(addon.streamEnabled&&supportsStream(m))hasStream=true}catch(e){console.error(`[manifest] ${addon.name}: ${e.message}`)}}return{id:'com.dlambda.centralyser',version:'1.0.2',name:'Centralyser',description:'Hub personnel configurable de catalogues et flux Stremio.',resources:hasStream?['catalog','meta','stream']:['catalog','meta'],types:[...types],catalogs}}