import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const DUCK = "https://lambda666-duckstreams.hf.space";
const DATA = "/tmp/centralyser-test-data";
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const manifestUrl = `${DUCK}/manifest.json`;

await mkdir(DATA, { recursive: true });
await writeFile(`${DATA}/centralyser.json`, JSON.stringify({
  addons: [{
    id: "ducktest",
    name: "DuckStreams Test",
    manifestUrl,
    selectedCatalogs: [],
    streamEnabled: true,
    manifest: { id: "ducktest", name: "DuckStreams Test", resources: ["stream"], types: ["movie"], catalogs: [], idPrefixes: [] }
  }]
}, null, 2));

const child = spawn(process.execPath, ["server-fixed.js"], {
  env: { ...process.env, PORT: String(PORT), CENTRALYSER_DATA_DIR: DATA, CENTRALYSER_ADMIN_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", d => { logs += d.toString(); });
child.stderr.on("data", d => { logs += d.toString(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error(`Serveur Centralyser inaccessible: ${logs}`);
}
try {
  const health = await get("/health");
  if (health.status !== "ok" || health.streamProviders !== 1) throw new Error(`Health inattendu: ${JSON.stringify(health)}`);
  console.log("Centralyser health: OK");
  const manifest = await get("/manifest.json");
  if (!Array.isArray(manifest.resources) || !manifest.resources.includes("stream")) throw new Error(`Manifest Centralyser sans stream: ${JSON.stringify(manifest)}`);
  console.log(`Centralyser manifest: OK (${manifest.resources.join(", ")})`);
  const data = await get("/stream/movie/tt1375666.json");
  if (!Array.isArray(data?.streams) || data.streams.length === 0) throw new Error("Le proxy Centralyser n'a retourné aucun flux");
  console.log(`Centralyser proxy stream: OK (${data.streams.length} flux)`);
  console.log(`Premier flux proxy: ${data.streams[0].name || "sans nom"}`);
  console.log("DuckStreams -> Centralyser -> stream endpoint: PASS");
} finally {
  child.kill("SIGTERM");
}
