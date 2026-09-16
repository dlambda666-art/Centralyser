import { readFile, writeFile } from 'node:fs/promises';

try {
  const p = './server-fixed.js';
  let s = await readFile(p, 'utf8');

  // Afficher tous les catalogues du manifest : Centralyser ne refait pas une seconde sélection.
  const start = s.indexOf('function render(as){');
  const end = s.indexOf('async function add(){', start);
  if (start !== -1 && end !== -1) {
    const render = "function render(as){const box=document.getElementById('addons');document.getElementById('count').textContent=as.length?'('+as.length+')':'';if(!as.length){box.innerHTML='<p class=\"muted\">Aucun addon configuré pour le moment.</p><p class=\"muted\">Ajoute ton premier addon ci-dessus.</p>';return}box.innerHTML=as.map(a=>{const m=a.manifest||{};const n=(m.catalogs||[]).length;return '<div class=\"addon ok\"><h3>✅ '+esc(a.name||m.name||a.manifestUrl)+'</h3><div class=\"muted\">'+esc(a.manifestUrl)+'</div><p>Manifest lu avec succès · <strong>'+n+' catalogue(s) détecté(s) · '+n+' exposé(s) dans Nuvio.</strong></p><div class=\"row\"><button onclick=\"refresh(\\''+a.id+'\\')\">Actualiser</button><button onclick=\"edit(\\''+a.id+'\\')\">Modifier URL</button><button onclick=\"del(\\''+a.id+'\\')\">Supprimer</button></div></div>'}).join('')}";
    s = s.slice(0,start) + render + '\n' + s.slice(end);
  }

  // À l'ajout, tous les catalogues du manifest deviennent automatiquement exposés.
  s = s.replace('m=validManifest(await fetchJson(url));a.manifest=manifestInfo', 'm=validManifest(await fetchJson(url));a.selectedCatalogs=m.catalogs.map(c=>c.id);a.manifest=manifestInfo');

  // Les addons déjà enregistrés exposent automatiquement tous leurs catalogues après redémarrage.
  const marker = 'await loadConfig();';
  const init = "await loadConfig();\nfor (const a of config.addons) { if (Array.isArray(a.manifest?.catalogs)) a.selectedCatalogs = a.manifest.catalogs.map(c => c.id); }\nif (config.addons.length) await saveConfig();";
  if (s.includes(marker) && !s.includes('a.manifest?.catalogs')) s = s.replace(marker, init);

  // Afficher directement dans Centralyser le lien stable à coller dans Nuvio, avec copie en un clic.
  const manifestBlock = '<p><a href=\"/manifest.json\" target=\"_blank\">/manifest.json</a></p><p class=\"muted\">À installer une seule fois dans Nuvio.</p>';
  const manifestReplacement = '<p><a href=\"/manifest.json\" target=\"_blank\">Voir le manifest JSON</a></p><p><button class=\"primary\" onclick=\"navigator.clipboard.writeText(location.origin+\'/manifest.json\').then(()=>{this.textContent=\'✅ URL copiée pour Nuvio\';setTimeout(()=>this.textContent=\'📋 Copier l’URL pour Nuvio\',1800)}).catch(()=>alert(location.origin+\'/manifest.json\'))\">📋 Copier l’URL pour Nuvio</button></p><p class=\"muted\">Cette URL reste la même : installe Centralyser une seule fois dans Nuvio.</p>';
  if (s.includes(manifestBlock) && !s.includes('Copier l’URL pour Nuvio')) s = s.replace(manifestBlock, manifestReplacement);

  // Stabilité réseau : retries 429/5xx, Retry-After et cache court des réponses catalogues/métadonnées.
  const fetchStart = s.indexOf('async function fetchJson(url, timeout = MANIFEST_TIMEOUT) {');
  const fetchEnd = s.indexOf('\n}\nfunction validManifest', fetchStart);
  if (fetchStart !== -1 && fetchEnd !== -1) {
    const fetchReplacement = `async function fetchJson(url, timeout = MANIFEST_TIMEOUT) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: controller.signal });
      if (r.ok) return await r.json();
      if (![429, 502, 503, 504].includes(r.status) || attempt === 2) throw new Error(\`${r.status} \${r.statusText}\`);
      const retryAfter = Number(r.headers.get("retry-after") || 0);
      const delay = Math.min(Math.max(retryAfter * 1000, 1200 * (attempt + 1)), 6000);
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (e) {
      if (e?.name === "AbortError") {
        if (attempt === 2) throw new Error(\`Délai dépassé après \${timeout / 1000}s\`);
      } else if (attempt === 2) throw e;
    } finally { clearTimeout(timer); }
  }
}`;
    s = s.slice(0, fetchStart) + fetchReplacement + s.slice(fetchEnd + 2);
  }

  // Éviter que plusieurs requêtes identiques de Nuvio frappent simultanément les addons distants.
  if (!s.includes('const responseCache = new Map();')) {
    s = s.replace('const cache = new Map();', 'const cache = new Map();\nconst responseCache = new Map();\nconst RESPONSE_TTL = 30000;');
  }

  // Cache court des catalogues : les données dynamiques restent fraîches, mais les rafales de Nuvio sont absorbées.
  const catMarker = "if(p[0]==='catalog'&&p.length===3&&p[2].endsWith('.json')){";
  if (s.includes(catMarker) && !s.includes('responseCache.get(`catalog:`')) {
    s = s.replace(catMarker, "if(p[0]==='catalog'&&p.length===3&&p[2].endsWith('.json')){const cacheKey=`catalog:${p[1]}:${p[2]}:${u.search}`;const cached=responseCache.get(cacheKey);if(cached&&Date.now()-cached.time<RESPONSE_TTL)return json(res,200,cached.data);");
    s = s.replace("return json(res,200,better(await fetchJson(endpoint(a,'catalog',p[1],m[2],u.searchParams),15000)))", "const data=better(await fetchJson(endpoint(a,'catalog',p[1],m[2],u.searchParams),15000));responseCache.set(cacheKey,{time:Date.now(),data});return json(res,200,data)");
  }

  // Cache court des métadonnées : évite les doubles/triples appels quand Nuvio ouvre une fiche.
  const metaMarker = "if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){";
  if (s.includes(metaMarker) && !s.includes('responseCache.get(`meta:`')) {
    s = s.replace(metaMarker, "if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){const cacheKey=`meta:${p[1]}:${p[2]}:${u.search}`;const cached=responseCache.get(cacheKey);if(cached&&Date.now()-cached.time<RESPONSE_TTL)return json(res,200,cached.data);");
    s = s.replace("if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length))return json(res,200,better(d))", "if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length)){const data=better(d);responseCache.set(cacheKey,{time:Date.now(),data});return json(res,200,data)}");
  }

  // CORRECTION CRITIQUE : le manifest public ne dépend plus de selectedCatalogs.
  // On remplace la dernière fonction du fichier, ce qui évite toute ambiguïté sur les accolades.
  const bmStart = s.indexOf('async function buildManifest(){');
  if (bmStart !== -1) {
    const buildManifest = `async function buildManifest(){
  const catalogs=[];
  const types=new Set();
  for(const addon of config.addons){
    try{
      const m=cache.has(addon.id)?cache.get(addon.id).data:(addon.manifest||await getManifest(addon));
      (m.types||[]).forEach(t=>types.add(t));
      for(const c of m.catalogs||[]) catalogs.push({...c,id:\`centralyser__\${addon.id}__\${c.id}\`});
    }catch(e){console.error(\`[manifest] \${addon.name}: \${e.message}\`)}
  }
  return {id:'com.dlambda.centralyser',version:'1.0.0',name:'Centralyser',description:'Hub personnel configurable de catalogues Stremio.',resources:['catalog','meta'],types:[...types],catalogs};
}`;
    s = s.slice(0,bmStart) + buildManifest + '\n';
  }

  await writeFile(p, s);
} catch (e) {
  console.error('[boot] patch skipped:', e.message);
}

await import('./server-fixed.js');
