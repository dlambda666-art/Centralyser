import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 7860);
const MANIFEST_TTL = 60_000;

const SOURCES = [
  {
    key: "franken",
    name: "FrankenStream",
    manifestUrl:
      process.env.FRANKEN_MANIFEST_URL ||
      "https://lambda666-frankenstream.hf.space/manifest.json",
  },
  {
    key: "frenchstream",
    name: "French Stream Enhanced",
    manifestUrl:
      process.env.FRENCH_STREAM_MANIFEST_URL ||
      "https://addon-stremio-fs-public.stremio-fs-public.workers.dev/manifest.json",
  },
  ...(process.env.AIOMETA_MANIFEST_URL
    ? [
        {
          key: "aiometa",
          name: "AIOMeta",
          manifestUrl: process.env.AIOMETA_MANIFEST_URL,
        },
      ]
    : []),
];

const manifestCache = new Map();

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function getSourceManifest(source) {
  const cached = manifestCache.get(source.key);
  if (cached && Date.now() - cached.time < MANIFEST_TTL) return cached.data;

  const data = await fetchJson(source.manifestUrl);
  manifestCache.set(source.key, { time: Date.now(), data });
  return data;
}

function sourceBaseUrl(source) {
  return new URL(source.manifestUrl).origin;
}

function sourceCatalogUrl(source, type, catalogId, query) {
  const url = new URL(`${sourceBaseUrl(source)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}.json`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url.toString();
}

function sourceMetaUrl(source, type, id, query) {
  const url = new URL(`${sourceBaseUrl(source)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url.toString();
}

async function buildManifest() {
  const sourceResults = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        return { source, manifest: await getSourceManifest(source) };
      } catch (error) {
        console.error(`[manifest] ${source.name}: ${error.message}`);
        return { source, manifest: null };
      }
    }),
  );

  const catalogs = [];
  const types = new Set();

  for (const { source, manifest } of sourceResults) {
    if (!manifest) continue;
    for (const type of manifest.types || []) types.add(type);

    for (const catalog of manifest.catalogs || []) {
      if (!catalog?.id || !catalog?.type) continue;
      catalogs.push({
        ...catalog,
        id: `centralyser__${source.key}__${catalog.id}`,
      });
    }
  }

  return {
    id: "com.dlambda.centralyser",
    version: "1.0.0",
    name: "Centralyser",
    description: "Agrégateur dynamique de catalogues Stremio.",
    logo: "https://raw.githubusercontent.com/dlambda666-art/Centralyser/main/logo.png",
    resources: ["catalog", "meta"],
    types: [...types],
    catalogs,
  };
}

function parseCentralyserCatalogId(id) {
  const match = /^centralyser__([^_]+)__(.+)$/.exec(id);
  if (!match) return null;
  return { sourceKey: match[1], catalogId: match[2] };
}

async function handleCatalog(type, catalogId, query) {
  const parsed = parseCentralyserCatalogId(catalogId);
  if (!parsed) throw new Error("Unknown Centralyser catalog");

  const source = SOURCES.find((item) => item.key === parsed.sourceKey);
  if (!source) throw new Error("Unknown source");

  const url = sourceCatalogUrl(source, type, parsed.catalogId, query);
  return fetchJson(url);
}

async function handleMeta(type, id, query) {
  for (const source of SOURCES) {
    try {
      const data = await fetchJson(sourceMetaUrl(source, type, id, query));
      if (data?.meta) return data;
      if (Array.isArray(data?.metas) && data.metas.length) return data;
    } catch (error) {
      console.error(`[meta] ${source.name}: ${error.message}`);
    }
  }
  return { meta: null };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = requestUrl.pathname.split("/").filter(Boolean);

  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });

    if (requestUrl.pathname === "/health") {
      return sendJson(res, 200, { status: "ok", addon: "Centralyser" });
    }

    if (requestUrl.pathname === "/manifest.json") {
      return sendJson(res, 200, await buildManifest());
    }

    if (parts[0] === "catalog" && parts.length === 3 && parts[2].endsWith(".json")) {
      const type = parts[1];
      const catalogId = decodeURIComponent(parts[2].slice(0, -5));
      return sendJson(res, 200, await handleCatalog(type, catalogId, requestUrl.searchParams));
    }

    if (parts[0] === "meta" && parts.length === 3 && parts[2].endsWith(".json")) {
      const type = parts[1];
      const id = decodeURIComponent(parts[2].slice(0, -5));
      return sendJson(res, 200, await handleMeta(type, id, requestUrl.searchParams));
    }

    return sendJson(res, 404, {
      error: "Not found",
      routes: ["/manifest.json", "/catalog/:type/:id.json", "/meta/:type/:id.json", "/health"],
    });
  } catch (error) {
    console.error(error);
    return sendJson(res, 502, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Centralyser listening on ${PORT}`);
});
