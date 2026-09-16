import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';

// Preserve the Hugging Face request token when Centralyser proxies requests
// to other *.hf.space addons. Nuvio sends x-ip-token to Centralyser, and
// downstream HF Spaces may require the same token.
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
