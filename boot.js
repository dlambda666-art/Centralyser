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

  await writeFile(p, s);
} catch (e) {
  console.error('[boot] patch skipped:', e.message);
}

await import('./server-fixed.js');
