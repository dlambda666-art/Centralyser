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

console.log(`Manifest: ${manifest.name || manifest.id || "unknown"}`);
console.log(`Manifest keys: ${Object.keys(manifest).join(", ")}`);
console.log(`Resources: ${resources.map(r => typeof r === "string" ? r : r?.name).filter(Boolean).join(", ") || "none"}`);

// Do not assume resources[] is present: the first probe showed that the
// AIOStreams manifest served by DuckStreams has a different shape.
const streamUrl = `${BASE}/stream/movie/${encodeURIComponent(TEST_ID)}.json`;
console.log(`Testing stream endpoint: ${streamUrl}`);

const result = await getJson(streamUrl);
const streams = Array.isArray(result?.streams) ? result.streams : [];
console.log("Stream endpoint: OK");
console.log(`Streams returned for ${TEST_ID}: ${streams.length}`);
if (streams.length) console.log(`First stream fields: ${Object.keys(streams[0] || {}).join(", ")}`);
console.log("DuckStreams compatibility probe: PASS");
