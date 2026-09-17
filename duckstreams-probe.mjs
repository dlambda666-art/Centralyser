const BASE = String(process.env.DUCKSTREAMS_URL || "https://lambda666-duckstreams.hf.space").replace(/\/$/, "");
const TEST_ID = process.env.TEST_MOVIE_ID || "tt1375666";

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${text.slice(0, 300)}`);
  return data;
}

const manifest = await getJson(`${BASE}/manifest.json`);
const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
const hasStream = resources.some(r => r === "stream" || (r && typeof r === "object" && r.name === "stream"));

console.log(`Manifest: ${manifest.name || manifest.id || "unknown"}`);
console.log(`Resources: ${resources.map(r => typeof r === "string" ? r : r?.name).filter(Boolean).join(", ") || "none"}`);
if (!hasStream) throw new Error("Le manifest DuckStreams ne déclare pas la ressource stream.");

const streamUrl = `${BASE}/stream/movie/${encodeURIComponent(TEST_ID)}.json`;
const result = await getJson(streamUrl);
const streams = Array.isArray(result?.streams) ? result.streams : [];
console.log(`Stream endpoint: OK`);
console.log(`Streams returned for ${TEST_ID}: ${streams.length}`);
console.log("DuckStreams compatibility probe: PASS");
