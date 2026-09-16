import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile } from 'node:fs/promises';

// Pass-through du x-ip-token pour les appels vers les Spaces HF.
const als = new AsyncLocalStorage();
const originalCreateServer = http.createServer.bind(http);
http.createServer = function (...args) {
  if (typeof args[1] === 'function') {
    const listener = args[1];
    args[1] = (req, res) => als.run({ xIpToken: req.headers['x-ip-token'] || '' }, () => listener(req, res));
  }
  return originalCreateServer(...args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname.endsWith('.hf.space')) {
      const token = als.getStore()?.xIpToken;
      if (token) {
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        headers.set('x-ip-token', token);
        init = { ...init, headers };
      }
    }
  } catch {}
  return originalFetch(input, init);
};

// Correctif client : les boutons "Tout sélectionner / Tout désélectionner"
// travaillent directement sur les cases visibles, puis sauvegardent la sélection.
// Le patch est idempotent et ne modifie pas FrankenStream.
try {
  const p = './server-fixed.js';
  let s = await readFile(p, 'utf8');
  const marker = "data-addon-id=\\\"'+esc(a.id)+'\\\"";
  if (!s.includes(marker)) {
    s = s.replace(/return '<div class=\\\"addon ok\\\"><h3>/, "return '<div class=\\\"addon ok\\\" data-addon-id=\\\"'+esc(a.id)+'\\\"><h3>");
  }
  const replacement = "async function all(id,on){try{const card=document.querySelector('.addon[data-addon-id=\\\"'+CSS.escape(id)+'\\\"]');if(!card)throw new Error('Addon introuvable dans la page');const boxes=[...card.querySelectorAll('input[type=checkbox]')];boxes.forEach(b=>{b.checked=on});const ids=on?boxes.map(b=>{const m=(b.getAttribute('onchange')||'').match(/toggle\\(\\'[^\\']+\\',\\'([^\\']+)\\'/);return m?m[1]:null}).filter(Boolean):[];await api('/api/addons/'+id,{method:'PUT',body:JSON.stringify({selectedCatalogs:ids})});const status=document.createElement('p');status.className='muted bulk-status';status.textContent=on?'✅ Tous les catalogues sont sélectionnés.':'✅ Tous les catalogues sont désélectionnés.';const previous=card.querySelector('.bulk-status');if(previous)previous.remove();card.querySelector('.row').after(status)}catch(e){alert('Sélection impossible : '+e.message)}}";
  if (!s.includes("const boxes=[...card.querySelectorAll('input[type=checkbox]')];")) {
    s = s.replace(/async function all\(id,on\)\{.*?\}\nasync function refresh/s, replacement + '\nasync function refresh');
  }
  await writeFile(p, s);
} catch (e) {
  console.error('[boot] UI patch skipped:', e.message);
}

await import('./server-fixed.js');
