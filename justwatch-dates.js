const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const JUSTWATCH_PARTNER_TOKEN = process.env.JUSTWATCH_PARTNER_TOKEN || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const JW_BASE = "https://apis.justwatch.com/contentpartner/v2/content";
const JW_LOCALE = process.env.JUSTWATCH_LOCALE || "fr_BE";
const REGION = process.env.JUSTWATCH_REGION || "BE";
const LANGUAGE = process.env.JUSTWATCH_LANGUAGE || "fr-FR";
const TIMEOUT = 10000;

async function fetchJson(url, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function requireTmdb() {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY manquante");
}

async function tmdb(path, params = {}) {
  requireTmdb();
  const url = new URL(TMDB_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  url.searchParams.set("api_key", TMDB_API_KEY);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`TMDB ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function poster(id) {
  return id ? `https://image.tmdb.org/t/p/w500${id}` : "";
}

function justwatchSearchUrl(title, year) {
  const query = year ? `${title} ${year}` : title;
  return `https://www.justwatch.com/be/recherche?q=${encodeURIComponent(query)}`;
}

function pickDigitalDate(releaseData) {
  const country = (releaseData.results || []).find(x => x.iso_3166_1 === REGION);
  const releases = country?.release_dates || [];
  const digital = releases
    .filter(x => Number(x.type) === 4 && x.release_date)
    .map(x => x.release_date.slice(0, 10))
    .sort();
  return digital[0] || null;
}

function extractJwDigitalDate(data) {
  const candidates = [];
  const walk = (value, key = "") => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (/(release|available|from|date)/i.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        if (/(release|available|from)/i.test(key + k)) candidates.push(v.slice(0, 10));
      }
      if (typeof v === "object") walk(v, k);
    }
  };
  walk(data);
  return [...new Set(candidates)].sort()[0] || null;
}

function extractJwPath(data) {
  let found = null;
  const walk = (value) => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, v] of Object.entries(value)) {
      if (key === "full_path" && typeof v === "string" && v.includes("/")) {
        found = v;
        return;
      }
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(data);
  return found;
}

async function justwatch(tmdbId) {
  if (!JUSTWATCH_PARTNER_TOKEN) return null;
  const url = new URL(
    `${JW_BASE}/offers/object_type/movie/id_type/tmdb/id/${encodeURIComponent(tmdbId)}/locale/${JW_LOCALE}`
  );
  url.searchParams.set("token", JUSTWATCH_PARTNER_TOKEN);
  return fetchJson(url.toString());
}

async function enrichMovie(movie) {
  let digitalReleaseDate = null;
  let justWatchPath = null;
  let dateSource = "TMDB";
  let jw = null;

  if (JUSTWATCH_PARTNER_TOKEN) {
    try {
      jw = await justwatch(movie.id);
      digitalReleaseDate = extractJwDigitalDate(jw);
      justWatchPath = extractJwPath(jw);
      if (digitalReleaseDate) dateSource = "JustWatch";
    } catch (error) {
      console.error(`[justwatch] ${movie.id}: ${error.message}`);
    }
  }

  if (!digitalReleaseDate) {
    try {
      digitalReleaseDate = pickDigitalDate(await tmdb(`/movie/${movie.id}/release_dates`));
    } catch (error) {
      console.error(`[tmdb-release] ${movie.id}: ${error.message}`);
    }
  }

  const title = movie.title || movie.original_title || "Titre inconnu";
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const jwUrl = justWatchPath
    ? (justWatchPath.startsWith("http") ? justWatchPath : `https://www.justwatch.com${justWatchPath}`)
    : justwatchSearchUrl(title, year);

  return {
    id: `jwd:tmdb:${movie.id}`,
    type: "movie",
    name: title,
    poster: poster(movie.poster_path),
    description: movie.overview || "",
    releaseInfo: digitalReleaseDate
      ? `${year} • Numérique : ${digitalReleaseDate}`
      : year,
    released: movie.release_date ? `${movie.release_date}T00:00:00.000Z` : undefined,
    description: [
      digitalReleaseDate
        ? `Sortie numérique Belgique : ${digitalReleaseDate}`
        : "Sortie numérique Belgique : date inconnue",
      movie.overview || ""
    ].filter(Boolean).join("\n\n"),
    website: jwUrl,
    links: [
      {
        name: digitalReleaseDate
          ? `Sortie numérique : ${digitalReleaseDate}`
          : "Sortie numérique : date inconnue",
        category: "release"
      },
      { name: "JustWatch", category: "external", url: jwUrl }
    ],
    _digitalReleaseDate: digitalReleaseDate,
    _digitalReleaseSource: dateSource
  };
}

export const manifest = {
  id: "com.dlambda.justwatch-dates",
  version: "0.1.2",
  name: "JustWatch — Dates numériques",
  description: "Recherche de films et consultation des dates de sortie numérique en Belgique, avec lien direct vers JustWatch.",
  resources: ["catalog", "meta"],
  types: ["movie"],
  idPrefixes: ["jwd:tmdb:"],
  catalogs: [
    {
      type: "movie",
      id: "dates-numeriques",
      name: "Dates numériques",
      extra: [{ name: "search", isRequired: true }]
    },
    {
      type: "movie",
      id: "a-venir-numerique",
      name: "À venir — numérique"
    }
  ],
  logo: "https://www.justwatch.com/favicon.ico"
};

export async function catalog(catalogId, extra = {}) {
  const search = String(extra.search || "").trim();
  let data;
  if (catalogId === "dates-numeriques" && search) {
    data = await tmdb("/search/movie", {
      query: search,
      language: LANGUAGE,
      region: REGION,
      include_adult: "false",
      page: "1"
    });
  } else if (catalogId === "a-venir-numerique") {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
    data = await tmdb("/discover/movie", {
      language: LANGUAGE,
      region: REGION,
      include_adult: "false",
      include_video: "false",
      sort_by: "release_date.asc",
      "release_date.gte": today,
      "release_date.lte": future,
      with_release_type: "4",
      page: "1"
    });
  } else {
    return { metas: [] };
  }

  const movies = Array.isArray(data?.results) ? data.results.slice(0, 12) : [];
  const metas = [];
  for (const movie of movies) {
    try { metas.push(await enrichMovie(movie)); } catch (error) {
      console.error(`[catalog] ${movie.id}: ${error.message}`);
    }
  }
  return { metas };
}

export async function meta(id) {
  const raw = String(id || "");
  const match = /^jwd:tmdb:(\d+)$/.exec(raw);
  if (!match) return { meta: null };
  const movie = await tmdb(`/movie/${match[1]}`, {
    language: LANGUAGE,
    append_to_response: "external_ids"
  });
  return { meta: await enrichMovie(movie) };
}
