import http from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 7860);
const MANIFEST_TTL = 60_000;
const FETCH_TIMEOUT = 15_000;
const DATA_DIR = process.env.CENTRALYSER_DATA_DIR || "/data";
const CONFIG_FILE = join(DATA_DIR, "centralyser.json");
const ADMIN_KEY = process.env.CENTRALYSER_ADMIN_KEY || "";
const BETTERPOSTER_URL = "https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=fr";

const manifestCache = new Map();
let config = { addons: [] };

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.addons)) config = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`[config] ${error.message}`);
  }
}

async function saveConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2), "utf8");
  await rename(temp, CONFIG_FILE);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Timeout after ${FETCH_TIMEOUT / 1000}s for ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeManifestUrl(value) {
  const url = new URL(String(value).trim());
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/manifest.json";
  else if (url.pathname.endsWith("/")) url.pathname += "manifest.json";
  return url.toString();
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid manifest");
  if (!Array.isArray(manifest.catalogs)) manifest.catalogs = [];
  if (!Array.isArray(manifest.types)) manifest.types = [];
  return manifest;
}

async function getAddonManifest(addon, force = false) {
  const cached = manifestCache.get(addon.id);
  if (!force && cached && Date.now() - cached.time < MANIFEST_TTL) return cached.data;
  const data = validateManifest(await fetchJson(addon.manifestUrl));
  manifestCache.set(addon.id, { time: Date.now(), data });
  return data;
}

function sourceBaseUrl(manifestUrl) {
  const url = new URL(manifestUrl);
  const pathname = url.pathname.endsWith("/") ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  return new URL(pathname || "/", url.origin).toString().replace(/\/$/, "");
}

function sourceCatalogUrl(addon, type, catalogId, query) {
  const url = new URL(`${sourceBaseUrl(addon.manifestUrl)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}.json`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url.toString();
}

function sourceMetaUrl(addon, type, id, query) {
  const url = new URL(`${sourceBaseUrl(addon.manifestUrl)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url.toString();
}

function getImdbId(item) {
  if (!item || typeof item !== "object") return null;
  for (const value of [item.imdb_id, item.imdbId, item.imdb, item.imdbid]) {
    const match = String(value || "").match(/tt\d+/i);
    if (match) return match[0].toLowerCase();
  }
  if (typeof item.id === "string") {
    const match = item.id.match(/(?:^|[^a-z0-9])(tt\d+)(?:$|[^a-z0-9])/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function applyBetterPoster(data) {
  if (!data || typeof data !== "object") return data;
  const apply = (item) => {
    const imdb = getImdbId(item);
    if (imdb) item.poster = BETTERPOSTER_URL.replace("{imdb_id}", imdb);
  };
  if (Array.isArray(data.metas)) data.metas.forEach(apply);
  if (data.meta) apply(data.meta);
  return data;
}

function selectedCatalogs(addon, manifest) {
  const selected = new Set(addon.selectedCatalogs || []);
  return (manifest.catalogs || []).filter((catalog) => catalog?.id && catalog?.type && selected.has(catalog.id));
}

async function buildManifest() {
  const catalogs = [];
  const types = new Set();
  for (const addon of config.addons) {
    try {
      const manifest = await getAddonManifest(addon);
      for (const type of manifest.types || []) types.add(type);
      for (const catalog of selectedCatalogs(addon, manifest)) catalogs.push({ ...catalog, id: `centralyser__${addon.id}__${catalog.id}` });
    } catch (error) { console.error(`[manifest] ${addon.name}: ${error.message}`); }
  }
  return {
    id: "com.dlambda.centralyser",
    version: "1.0.0",
    name: "Centralyser",
    description: "Hub personnel configurable de catalogues Stremio.",
    resources: ["catalog", "meta"],
    types: [...types],
    catalogs,
  };
}

function parseCentralyserCatalogId(id) {
  const match = /^centralyser__([^_]+)__(.+)$/.exec(id);
  return match ? { addonId: match[1], catalogId: match[2] } : null;
}
function findAddon(id) { return config.addons.find((addon) => addon.id === id); }
function adminAllowed(req, requestUrl) {
  if (!ADMIN_KEY) return true;
  const supplied = req.headers["x-centralyser-key"] || requestUrl.searchParams.get("key") || "";
  return supplied === ADMIN_KEY;
}
function safeAddon(addon) { return { ...addon, manifest: undefined }; }

async function addonInfo(addon, force = false) {
  try {
    const manifest = await getAddonManifest(addon, force);
    return { ...safeAddon(addon), manifest: {
      id: manifest.id || null, name: manifest.name || addon.name, version: manifest.version || null,
      description: manifest.description || "", types: manifest.types || [], resources: manifest.resources || [], catalogs: manifest.catalogs || [],
    }};
  } catch (error) {
    return { ...safeAddon(addon), manifest: {
      id: null, name: addon.name, version: null,
      description: `Impossible de lire le manifest: ${error.message}`,
      types: [], resources: [], catalogs: [],
    }, error: error.message };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(new Error("Request too large")); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-centralyser-key", "cache-control": "no-store" });
  res.end(body);
}
function sendHtml(res) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Centralyser</title><style>body{font-family:system-ui;margin:0;background:#111827;color:#f9fafb}main{max-width:900px;margin:auto;padding:24px}section{background:#1f2937;border-radius:14px;padding:18px;margin:16px 0}input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #4b5563;background:#111827;color:white;margin:6px 0 12px}button{padding:9px 13px;border:0;border-radius:8px;cursor:pointer;margin:3px}button.primary{background:#60a5fa;color:#111827}.addon{border:1px solid #374151;border-radius:10px;padding:14px;margin:10px 0}.catalog{padding:8px 0;border-top:1px solid #374151}.muted{color:#9ca3af}.row{display:flex;gap:8px;flex-wrap:wrap}a{color:#93c5fd}</style></head><body><main><h1>🧩 Centralyser</h1><p class="muted">Ajoute tes addons, choisis les catalogues à exposer dans Nuvio, puis modifie-les quand tu veux.</p><section><h2>Ajouter un addon</h2><label>Nom (facultatif)</label><input id="name" placeholder="Ex. FrankenStream"><label>URL du manifest</label><input id="url" placeholder="https://.../manifest.json"><button class="primary" onclick="addAddon()">Ajouter et lire le manifest</button><span id="addmsg"></span></section><section><h2>Mes addons</h2><div id="addons">Chargement…</div></section><section><h2>BetterPoster</h2><p class="muted">Activé automatiquement pour les fiches possédant un identifiant IMDb. Les posters BetterPoster sont injectés par Centralyser.</p></section><section><h2>Manifest Centralyser</h2><p><a href="/manifest.json" target="_blank">/manifest.json</a></p><p class="muted">Cette URL est celle à installer une seule fois dans Nuvio.</p></section></main><script>
const key=localStorage.getItem('centralyserKey')||'';
async function api(path,opt={}){opt.headers={...(opt.headers||{}),'content-type':'application/json','x-centralyser-key':key};const r=await fetch(path,opt);const d=await r.json();if(!r.ok)throw Error(d.error||r.statusText);return d}
async function load(){try{const d=await api('/api/addons');render(d.addons)}catch(e){document.getElementById('addons').innerHTML='<p>Erreur: '+esc(e.message)+'</p>'}}
function esc(s){return String(s??'').replace(/[&<>\\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\':'&#92;','"':'&quot;'}[c]))}
function render(addons){if(!addons.length){document.getElementById('addons').innerHTML='<p class="muted">Aucun addon configuré. Ajoute ton premier manifest ci-dessus.</p>';return}document.getElementById('addons').innerHTML=addons.map(a=>{const m=a.manifest||{};const cats=m.catalogs||[];const selected=new Set(a.selectedCatalogs||[]);const error=a.error?'<p>⚠️ '+esc(a.error)+'</p>':'';return '<div class="addon"><h3>'+esc(a.name||m.name||a.manifestUrl)+'</h3><div class="muted">'+esc(a.manifestUrl)+'</div><p>'+esc(m.description||'')+'</p>'+error+'<div class="row"><button onclick="selectAll(\''+a.id+'\',true)">Tout sélectionner</button><button onclick="selectAll(\''+a.id+'\',false)">Tout désélectionner</button><button onclick="refresh(\''+a.id+'\')">Actualiser</button><button onclick="edit(\''+a.id+'\')">Modifier URL</button><button onclick="removeAddon(\''+a.id+'\')">Supprimer</button></div>'+cats.map(c=>'<label class="catalog"><input type="checkbox" '+(selected.has(c.id)?'checked':'')+' onchange="toggle(\''+a.id+'\',\''+esc(c.id)+'\',this.checked)"> '+esc(c.name||c.title||c.id)+' <span class="muted">('+esc(c.type)+')</span></label>').join('')+'</div>'}).join('')}
async function addAddon(){const url=document.getElementById('url').value.trim();const name=document.getElementById('name').value.trim();if(!url)return alert('Entre une URL de manifest.');try{await api('/api/addons',{method:'POST',body:JSON.stringify({url,name})});document.getElementById('url').value='';document.getElementById('name').value='';document.getElementById('addmsg').textContent=' ✓';load()}catch(e){alert(e.message)}}
async function toggle(id,catalog,checked){const a=(await api('/api/addons')).addons.find(x=>x.id===id);const s=new Set(a.selectedCatalogs||[]);checked?s.add(catalog):s.delete(catalog);await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:[...s]})});load()}
async function selectAll(id,yes){const a=(await api('/api/addons')).addons.find(x=>x.id===id);const ids=yes?(a.manifest.catalogs||[]).map(c=>c.id):[];await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:ids})});load()}
async function refresh(id){await api('/api/addons/'+id+'/refresh',{method:'POST'});load()}
async function edit(id){const a=(await api('/api/addons')).addons.find(x=>x.id===id);const url=prompt('Nouvelle URL du manifest',a.manifestUrl);if(url&&url!==a.manifestUrl){await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({url})});load()}}
async function removeAddon(id){if(confirm('Supprimer cet addon de Centralyser ?')){await api('/api/addons/'+id,{method:'DELETE'});load()}}
load();
</script></body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html);
}

async function handleApi(req, res, parts, requestUrl) {
  if (!adminAllowed(req, requestUrl)) return sendJson(res, 401, { error: "Admin key required" });
  if (req.method === "GET" && parts.length === 2) return sendJson(res, 200, { addons: await Promise.all(config.addons.map((a) => addonInfo(a))) });
  if (req.method === "POST" && parts.length === 2) {
    const body = await readBody(req); const rawUrl = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(rawUrl)) throw new Error("Manifest URL must start with http:// or https://");
    const manifestUrl = normalizeManifestUrl(rawUrl);
    const addon = { id: randomUUID().replaceAll("-", "").slice(0, 12), name: String(body.name || "").trim() || manifestUrl, manifestUrl, selectedCatalogs: [] };
    const manifest = validateManifest(await fetchJson(manifestUrl)); config.addons.push(addon); manifestCache.set(addon.id, { time: Date.now(), data: manifest }); await saveConfig();
    return sendJson(res, 201, await addonInfo(addon));
  }
  if (parts.length >= 3) {
    const addonId = parts[2]; const addon = findAddon(addonId); if (!addon) return sendJson(res, 404, { error: "Addon not found" });
    if (req.method === "DELETE" && parts.length === 3) { config.addons = config.addons.filter((a) => a.id !== addonId); manifestCache.delete(addonId); await saveConfig(); return sendJson(res, 200, { ok: true }); }
    if (req.method === "POST" && parts[3] === "refresh") { const manifest = validateManifest(await fetchJson(addon.manifestUrl)); const valid = new Set((manifest.catalogs || []).map((c) => c.id)); addon.selectedCatalogs = (addon.selectedCatalogs || []).filter((id) => valid.has(id)); manifestCache.set(addon.id, { time: Date.now(), data: manifest }); await saveConfig(); return sendJson(res, 200, await addonInfo(addon, true)); }
    if (req.method === "PUT" && parts.length === 3) {
      const body = await readBody(req); if (body.name !== undefined) addon.name = String(body.name || addon.name);
      if (body.url !== undefined) { const rawUrl = String(body.url || "").trim(); if (!/^https?:\/\//i.test(rawUrl)) throw new Error("Manifest URL must start with http:// or https://"); addon.manifestUrl = normalizeManifestUrl(rawUrl); manifestCache.delete(addon.id); await getAddonManifest(addon, true); }
      if (Array.isArray(body.selectedCatalogs)) addon.selectedCatalogs = [...new Set(body.selectedCatalogs.map(String))]; await saveConfig(); return sendJson(res, 200, await addonInfo(addon));
    }
  }
  return sendJson(res, 404, { error: "Unknown API route" });
}

await loadConfig();
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,x-centralyser-key" }); return res.end(); }
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`); const parts = requestUrl.pathname.split("/").filter(Boolean);
  try {
    if (requestUrl.pathname === "/" && req.method === "GET") return sendHtml(res);
    if (requestUrl.pathname === "/health" && req.method === "GET") return sendJson(res, 200, { status: "ok", addon: "Centralyser", configuredAddons: config.addons.length, betterPoster: true });
    if (requestUrl.pathname === "/manifest.json" && req.method === "GET") return sendJson(res, 200, await buildManifest());
    if (parts[0] === "api" && parts[1] === "addons") return handleApi(req, res, parts, requestUrl);
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
    if (parts[0] === "catalog" && parts.length >= 3 && parts[2].endsWith(".json")) {
      const type = parts[1];
      const parsed = parseCentralyserCatalogId(decodeURIComponent(parts[2].slice(0, -5)));
      if (!parsed) return sendJson(res, 404, { error: "Unknown Centralyser catalog" });
      const addon = findAddon(parsed.addonId);
      if (!addon) return sendJson(res, 404, { error: "Unknown addon" });

      // Stremio/Nuvio sends catalog extras (notably search) in the path:
      // /catalog/movie/<id>/search=avatar.json
      // Forward those extras to the source addon as query parameters.
      const forwardedQuery = new URLSearchParams(requestUrl.searchParams);
      if (parts.length > 3) {
        const extraPath = parts.slice(3).join("&").replace(/\.json$/, "");
        const extraQuery = new URLSearchParams(extraPath);
        for (const [key, value] of extraQuery) forwardedQuery.set(key, value);
      }

      return sendJson(res, 200, applyBetterPoster(await fetchJson(
        sourceCatalogUrl(addon, type, parsed.catalogId, forwardedQuery)
      )));
    }
    if (parts[0] === "meta" && parts.length === 3 && parts[2].endsWith(".json")) {
      const type = parts[1]; const id = decodeURIComponent(parts[2].slice(0, -5));
      for (const addon of config.addons) {
        try {
          const manifest = await getAddonManifest(addon); const prefixes = manifest.idPrefixes || [];
          if (prefixes.length && !prefixes.some((prefix) => id.startsWith(prefix))) continue;
          const data = await fetchJson(sourceMetaUrl(addon, type, id, requestUrl.searchParams));
          if (data?.meta || (Array.isArray(data?.metas) && data.metas.length)) return sendJson(res, 200, applyBetterPoster(data));
        } catch (error) { console.error(`[meta] ${addon.name}: ${error.message}`); }
      }
      return sendJson(res, 200, { meta: null });
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) { console.error(error); return sendJson(res, 502, { error: error.message }); }
});
server.listen(PORT, "0.0.0.0", () => console.log(`Centralyser listening on ${PORT}`));
