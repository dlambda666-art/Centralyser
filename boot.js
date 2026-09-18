import { readFile, writeFile } from 'node:fs/promises';

try {
  const p = './server-fixed.js';
  let s = await readFile(p, 'utf8');

  // Keep upstream manifest reads resilient to transient 429/502/503/504 errors.
  const fetchStart = s.indexOf('async function fetchJson(url, timeout = MANIFEST_TIMEOUT) {');
  const fetchEnd = s.indexOf('\n}\nfunction validManifest', fetchStart);
  if (fetchStart !== -1 && fetchEnd !== -1) {
    const fetchReplacement = [
      'async function fetchJson(url, timeout = MANIFEST_TIMEOUT) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    const controller = new AbortController();',
      '    const timer = setTimeout(() => controller.abort(), timeout);',
      '    try {',
      '      const r = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: controller.signal });',
      '      if (r.ok) return await r.json();',
      '      if (![429, 502, 503, 504].includes(r.status) || attempt === 2) throw new Error(String(r.status) + " " + r.statusText);',
      '      const retryAfter = Number(r.headers.get("retry-after") || 0);',
      '      const delay = Math.min(Math.max(retryAfter * 1000, 1200 * (attempt + 1)), 6000);',
      '      await new Promise(resolve => setTimeout(resolve, delay));',
      '    } catch (e) {',
      '      if (e?.name === "AbortError") {',
      '        if (attempt === 2) throw new Error("Délai dépassé après " + (timeout / 1000) + "s");',
      '      } else if (attempt === 2) throw e;',
      '    } finally { clearTimeout(timer); }',
      '  }',
      '}',
      ''
    ].join('\n');
    s = s.slice(0, fetchStart) + fetchReplacement + s.slice(fetchEnd + 2);
  }

  // Short in-memory cache absorbs duplicate catalog/meta bursts from Nuvio
  // without freezing addon data. FrenchPulse therefore remains live/dynamic.
  if (!s.includes('const responseCache = new Map();')) {
    s = s.replace('const cache = new Map();', 'const cache = new Map();\nconst responseCache = new Map();\nconst inflightCache = new Map();\nconst RESPONSE_TTL = 20000;\nconst RESPONSE_STALE_TTL = 300000;');
  } else if (!s.includes('const inflightCache = new Map();')) {
    s = s.replace('const responseCache = new Map();', 'const responseCache = new Map();\nconst inflightCache = new Map();');
  }

  const catMarker = "if(p[0]==='catalog'&&p.length===3&&p[2].endsWith('.json')){";
  if (s.includes(catMarker) && !s.includes('inflightCache.get(cacheKey)')) {
    s = s.replace(
      catMarker,
      "if(p[0]==='catalog'&&p.length===3&&p[2].endsWith('.json')){const cacheKey=`catalog:${p[1]}:${p[2]}:${u.search}`;const cached=responseCache.get(cacheKey);if(cached&&Date.now()-cached.time<RESPONSE_TTL)return json(res,200,cached.data);const pending=inflightCache.get(cacheKey);if(pending)return json(res,200,await pending);"
    );
    s = s.replace(
      "return json(res,200,better(await fetchJson(endpoint(a,'catalog',p[1],m[2],u.searchParams),15000)))",
      "const pendingRequest=(async()=>{const data=better(await fetchJson(endpoint(a,'catalog',p[1],m[2],u.searchParams),15000));responseCache.set(cacheKey,{time:Date.now(),data});return data})();inflightCache.set(cacheKey,pendingRequest);try{return json(res,200,await pendingRequest)}catch(e){const stale=responseCache.get(cacheKey);if(stale&&Date.now()-stale.time<RESPONSE_STALE_TTL&&/^(429|502|503|504)\b/.test(e.message)){console.error('[catalog] upstream transient error; serving stale cache:',e.message);return json(res,200,stale.data)}return json(res,502,{error:e.message})}finally{inflightCache.delete(cacheKey)}"
    );
  }

  const metaMarker = "if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){";
  if (s.includes(metaMarker) && !s.includes('responseCache.get(`meta:`')) {
    s = s.replace(
      metaMarker,
      "if(p[0]==='meta'&&p.length===3&&p[2].endsWith('.json')){const cacheKey=`meta:${p[1]}:${p[2]}:${u.search}`;const cached=responseCache.get(cacheKey);if(cached&&Date.now()-cached.time<RESPONSE_TTL)return json(res,200,cached.data);"
    );
    s = s.replace(
      "if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length))return json(res,200,better(d))",
      "if(d?.meta||(Array.isArray(d?.metas)&&d.metas.length)){const data=better(d);responseCache.set(cacheKey,{time:Date.now(),data});return json(res,200,data)}"
    );
  }

  // STREAM_BURST_PATCH: protect the stream proxy from duplicate bursts.
  {
    const streamStart = s.indexOf("if(p[0]==='stream'&&p.length===3&&p[2].endsWith('.json')){");
    const streamEnd = s.indexOf("\n    return json(res,404,{error:'Not found'});", streamStart);
    if (streamStart !== -1 && streamEnd !== -1) {
      const streamReplacement = [
        "if(p[0]==='stream'&&p.length===3&&p[2].endsWith('.json')){const type=p[1],id=decodeURIComponent(p[2].slice(0,-5)),streamKey='stream:'+p[1]+':'+p[2]+':'+u.search,cached=responseCache.get(streamKey);if(cached&&Date.now()-cached.time<RESPONSE_TTL)return json(res,200,cached.data);const pending=inflightCache.get(streamKey);if(pending)return json(res,200,await pending);",
        "const pendingRequest=(async()=>{const streams=[];for(const a of config.addons){if(!a.streamEnabled)continue;try{const m=cache.has(a.id)?cache.get(a.id).data:(a.manifest||await getManifest(a));if(!supportsStream(m))continue;const d=await fetchJson(endpoint(a,'stream',type,id,u.searchParams),STREAM_TIMEOUT);if(Array.isArray(d?.streams))streams.push(...d.streams)}catch(e){console.error('[stream] '+a.name+': '+e.message)}}const seen=new Set(),unique=streams.filter(s=>{const k=String(s?.url||s?.externalUrl||s?.infoHash||s?.name||'');if(!k||seen.has(k))return false;seen.add(k);return true});const data={streams:unique};responseCache.set(streamKey,{time:Date.now(),data});return data})();inflightCache.set(streamKey,pendingRequest);",
        "try{return json(res,200,await pendingRequest)}catch(e){const stale=responseCache.get(streamKey);if(stale&&Date.now()-stale.time<RESPONSE_STALE_TTL&&/^(429|502|503|504)\\b/.test(e.message)){console.error('[stream] upstream transient error; serving stale cache:',e.message);return json(res,200,stale.data)}return json(res,502,{error:e.message})}finally{inflightCache.delete(streamKey)}}\n    "
      ].join('');
      s=s.slice(0,streamStart)+streamReplacement+s.slice(streamEnd);
    }
  }

  // Force a manifest version bump so Nuvio refreshes its cached manifest.
  s = s.replace('version:"1.0.0"', 'version:"1.0.1"');
  s = s.replace('version: "1.0.0"', 'version: "1.0.1"');
  s = s.replace("version:'1.0.0'", "version:'1.0.1'");
  s = s.replace("version: '1.0.0'", "version: '1.0.1'");

  // Add a convenient copy button without changing addon/catalog behavior.
  const manifestBlock = '<p><a href=\"/manifest.json\" target=\"_blank\">/manifest.json</a></p><p class=\"muted\">À installer une seule fois dans Nuvio.</p>';
  const manifestReplacement = '<p><a href=\"/manifest.json\" target=\"_blank\">Voir le manifest JSON</a></p><p><button class=\"primary\" onclick=\"navigator.clipboard.writeText(location.origin+\'/manifest.json\').then(()=>{this.textContent=\'✅ URL copiée pour Nuvio\';setTimeout(()=>this.textContent=\'📋 Copier l’URL pour Nuvio\',1800)}).catch(()=>alert(location.origin+\'/manifest.json\'))\">📋 Copier l’URL pour Nuvio</button></p><p class=\"muted\">Cette URL reste la même : installe Centralyser une seule fois dans Nuvio.</p>';
  if (s.includes(manifestBlock) && !s.includes('Copier l’URL pour Nuvio')) s = s.replace(manifestBlock, manifestReplacement);

  // IMPORTANT: do not rewrite config on startup and do not override
  // server-fixed.js buildManifest. The server already persists and honors
  // the user's selectedCatalogs exactly as saved in /data/centralyser.json.

  await writeFile(p, s);
} catch (e) {
  console.error('[boot] patch skipped:', e.message);
}

await import('./server-fixed.js');
