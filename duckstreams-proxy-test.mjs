const DUCK = "https://lambda666-duckstreams.hf.space";
const target = `${DUCK}/stream/movie/tt1375666.json`;

const r = await fetch(target, { headers: { accept: "application/json" } });
if (!r.ok) throw new Error(`DuckStreams ${r.status} ${r.statusText}`);
const data = await r.json();
if (!Array.isArray(data?.streams) || data.streams.length === 0) {
  throw new Error("DuckStreams n'a retourné aucun flux");
}

console.log(`DuckStreams direct: OK (${data.streams.length} flux)`);
console.log(`Premier flux: ${data.streams[0].name || "sans nom"}`);
console.log("Proxy Centralyser: prêt pour test end-to-end local");
