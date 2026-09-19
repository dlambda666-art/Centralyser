import http from "node:http";
import { URL } from "node:url";
import { manifest, catalog, meta } from "./justwatch-dates.js";

const PORT = Number(process.env.PORT || 7860);

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, {"content-type":"text/html; charset=utf-8"});
      return res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JustWatch — Dates numériques</title><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px;background:#111827;color:#f9fafb"><h1>🎬 JustWatch — Dates numériques</h1><p>Addon Nuvio pour rechercher un film et consulter sa sortie numérique en Belgique.</p><p><a style="color:#93c5fd" href="/manifest.json">Installer le manifest dans Nuvio</a></p><p><a style="color:#93c5fd" href="/health">État du service</a></p></body></html>`);
    }
    if (url.pathname === "/manifest.json" && req.method === "GET") {
      return json(res, 200, {...manifest, endpoint: `${url.origin}`});
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return json(res, 200, {
        status: "ok",
        addon: manifest.id,
        tmdbConfigured: Boolean(process.env.TMDB_API_KEY),
        justWatchPartnerConfigured: Boolean(process.env.JUSTWATCH_PARTNER_TOKEN)
      });
    }
    if (parts[0] === "catalog" && parts[1] === "movie" && parts.length >= 3 && parts[parts.length - 1].endsWith(".json")) {
      const catalogId = decodeURIComponent(parts[2].replace(/\.json$/, ""));
      const extra = Object.fromEntries(url.searchParams.entries());
      const extraParts = parts.slice(3);
      if (extraParts.length) {
        const last = extraParts.length - 1;
        extraParts.forEach((raw, index) => {
          const segment = index === last ? raw.slice(0, -5) : raw;
          for (const pair of segment.split("&")) {
            const eq = pair.indexOf("=");
            if (eq > 0) extra[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
          }
        });
      }
      return json(res, 200, await catalog(catalogId, extra));
    }
    if (parts[0] === "meta" && parts[1] === "movie" && parts.length === 3 && parts[2].endsWith(".json")) {
      const id = decodeURIComponent(parts[2].slice(0, -5));
      return json(res, 200, await meta(id));
    }
    return json(res, 404, {error:"Not found"});
  } catch (error) {
    console.error(error);
    return json(res, 502, {error:error.message});
  }
}).listen(PORT, "0.0.0.0", () => console.log(`JustWatch Dates listening on ${PORT}`));
