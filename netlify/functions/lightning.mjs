import { writeFile, unlink } from "node:fs/promises";

let h5wasmModulePromise;
async function getH5wasm() {
  if (!h5wasmModulePromise) h5wasmModulePromise = import("h5wasm/node");
  const module = await h5wasmModulePromise;
  await module.ready;
  return module;
}

const BUCKET = "https://noaa-goes19.s3.amazonaws.com";
const PRODUCT = "GLM-L2-LCFA";
const BRAZIL = { west: -75, east: -30, south: -35, north: 6 };
const MAX_FILES = 15;
const MAX_FEATURES = 12000;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/geo+json; charset=utf-8",
    "cache-control": "public, max-age=20, stale-while-revalidate=20",
    "access-control-allow-origin": "*",
    ...extra,
  },
});

function utcParts(date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
  return { year, day: String(day).padStart(3, "0"), hour: String(date.getUTCHours()).padStart(2, "0") };
}

function glmStartTime(key) {
  const match = key.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
  if (!match) return NaN;
  const [, y, doy, hh, mm, ss] = match;
  return Date.UTC(Number(y), 0, Number(doy), Number(hh), Number(mm), Number(ss));
}

function xmlText(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map(m => m[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
}

async function listHour(date) {
  const { year, day, hour } = utcParts(date);
  const prefix = `${PRODUCT}/${year}/${day}/${hour}/`;
  const url = `${BUCKET}/?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`NOAA S3 respondeu HTTP ${response.status}`);
  const xml = await response.text();
  return xmlText(xml, "Key").filter(key => key.endsWith(".nc"));
}

async function latestKeys(minutes) {
  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60000);
  const hours = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours()));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  for (let t = cursor; t <= end; t = new Date(t.getTime() + 3600000)) hours.push(new Date(t));
  const lists = await Promise.all(hours.map(listHour));
  return lists.flat()
    .map(key => ({ key, time: glmStartTime(key) }))
    .filter(item => Number.isFinite(item.time) && item.time >= from.getTime() && item.time <= now.getTime() + 60000)
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_FILES);
}

function dataset(file, name) {
  const item = file.get(name);
  if (!item || !item.value) return null;
  return item.value;
}

async function readGlmFile(key, startMs) {
  const response = await fetch(`${BUCKET}/${key}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Falha ao baixar arquivo GLM: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const path = `/tmp/glm-${startMs}.nc`;
  const h5wasm = await getH5wasm();
  await writeFile(path, buffer);
  let file;
  try {
    file = new h5wasm.File(path, "r");
    const lat = dataset(file, "flash_lat");
    const lon = dataset(file, "flash_lon");
    const energy = dataset(file, "flash_energy");
    const offset = dataset(file, "flash_time_offset");
    if (!lat || !lon) throw new Error("O arquivo GLM não contém flash_lat/flash_lon");
    const count = Math.min(lat.length, lon.length, MAX_FEATURES);
    const features = [];
    for (let i = 0; i < count; i++) {
      const y = Number(lat[i]);
      const x = Number(lon[i]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < BRAZIL.west || x > BRAZIL.east || y < BRAZIL.south || y > BRAZIL.north) continue;
      const joules = energy ? Number(energy[i]) : null;
      const seconds = offset ? Number(offset[i]) : 0;
      features.push({
        type: "Feature",
        id: `${startMs}-${i}`,
        geometry: { type: "Point", coordinates: [x, y] },
        properties: {
          flash_energy: Number.isFinite(joules) ? joules : null,
          time: new Date(startMs + (Number.isFinite(seconds) ? seconds * 1000 : 0)).toISOString(),
          source: "GOES-19 GLM-L2-LCFA",
          satellite: "GOES-19",
        },
      });
    }
    return features;
  } finally {
    if (file) file.close();
    try { await unlink(path); } catch {}
  }
}

export default async function handler(request) {
  if (request.method !== "GET") return json({ error: "Método não permitido" }, 405, { allow: "GET" });
  const url = new URL(request.url);
  const minutes = Math.max(1, Math.min(10, Number(url.searchParams.get("minutes") || 10)));
  try {
    const keys = await latestKeys(minutes);
    if (!keys.length) {
      return json({
        type: "FeatureCollection", features: [], source: "GOES-19 GLM-L2-LCFA",
        satellite: 19, interval_minutes: minutes, message: "Nenhum arquivo GLM recente foi encontrado no intervalo solicitado.",
        generated_at: new Date().toISOString(),
      });
    }
    const all = [];
    // Baixa em pequenos lotes para não estourar memória/tempo da função serverless.
    for (let i = 0; i < keys.length; i += 3) {
      const batch = keys.slice(i, i + 3);
      const results = await Promise.all(batch.map(item => readGlmFile(item.key, item.time)));
      for (const features of results) all.push(...features);
      if (all.length >= MAX_FEATURES) break;
    }
    all.sort((a, b) => Date.parse(b.properties.time) - Date.parse(a.properties.time));
    return json({
      type: "FeatureCollection", features: all.slice(0, MAX_FEATURES),
      source: "GOES-19 GLM-L2-LCFA", satellite: 19,
      interval_minutes: minutes, files_read: keys.length,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("/api/lightning:", error);
    return json({ error: "Não foi possível consultar/processar o GOES-19 GLM.", detail: error?.message || String(error) }, 502);
  }
}

export const config = { path: "/api/lightning", method: "GET" };
    
