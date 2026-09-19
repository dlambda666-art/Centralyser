const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const JUSTWATCH_PARTNER_TOKEN = process.env.JUSTWATCH_PARTNER_TOKEN || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const JW_BASE = "https://apis.justwatch.com/contentpartner/v2/content";
const JW_LOCALE = process.env.JUSTWATCH_LOCALE || "fr_FR";
const REGION = process.env.JUSTWATCH_REGION || "FR";
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

async function justwatchNewTitleDates(title) {
  const query = `
    query GetNewTitleDates(
      $country: Country!,
      $filter: TitleFilter,
      $first: Int!,
      $bucketSize: Int!
    ) {
      newTitleBuckets(
        country: $country,
        filter: $filter,
        first: $first,
        bucketSize: $bucketSize,
        priceDrops: false,
        pageType: NEW,
        groupBy: DATE_PACKAGE
      ) {
        edges {
          key {
            ... on DatePackageAggregationKey {
              date
              package {
                clearName
                shortName
              }
            }
          }
        }
      }
    }
  `;
  const body = {
    operationName: "GetNewTitleDates",
    variables: {
      country: "FR",
      first: 30,
      bucketSize: 8,
      filter: {
        searchQuery: title,
        objectTypes: ["MOVIE"]
      }
    },
    query
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch("https://apis.justwatch.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Nuvio-JustWatch-Dates/0.2"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`JustWatch new-title GraphQL ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (Array.isArray(data?.errors) && data.errors.length) {
      throw new Error(data.errors.map(error => error.message).join("; "));
    }
    return (data?.data?.newTitleBuckets?.edges || [])
      .map(edge => ({
        date: edge?.key?.date,
        service: edge?.key?.package?.clearName || edge?.key?.package?.shortName || null
      }))
      .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || "")))
      .map(item => ({ date: String(item.date), service: item.service }));
  } finally {
    clearTimeout(timer);
  }
}

async function justwatchPublicGraphql(title, tmdbId) {
  const query = `
    query GetTitleForReleaseDate(
      $country: Country!,
      $language: Language!,
      $first: Int!,
      $filter: TitleFilter
    ) {
      popularTitles(
        country: $country,
        filter: $filter,
        first: $first,
        sortBy: POPULAR,
        sortRandomSeed: 0
      ) {
        edges {
          node {
            id
            objectType
            objectId
            content(country: $country, language: $language) {
              title
              originalReleaseYear
              externalIds {
                tmdbId
              }
              fullPath
              upcomingReleases {
                releaseDate
                package {
                  shortName
                  clearName
                }
              }
            }
          }
        }
      }
    }
  `;
  const body = {
    operationName: "GetTitleForReleaseDate",
    variables: {
      country: REGION,
      language: "fr",
      first: 10,
      filter: {
        searchQuery: title,
        objectTypes: ["MOVIE"]
      }
    },
    query
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch("https://apis.justwatch.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Nuvio-JustWatch-Dates/0.1"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`JustWatch GraphQL ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (Array.isArray(data?.errors) && data.errors.length) {
      throw new Error(data.errors.map(error => error.message).join("; "));
    }
    const edges = data?.data?.popularTitles?.edges || [];
    const matches = edges
      .map(edge => edge?.node)
      .filter(node => node?.objectType === "MOVIE")
      .filter(node => String(node?.content?.externalIds?.tmdbId || "") === String(tmdbId));
    return matches[0] || null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichMovie(movie, outputId = null) {
  let digitalReleaseDate = null;
  let justWatchPath = null;
  let dateSource = "TMDB";
  let dateService = null;
  let dateCountry = null;
  let jw = null;

  if (JUSTWATCH_PARTNER_TOKEN) {
    try {
      jw = await justwatch(movie.id);
      digitalReleaseDate = extractJwDigitalDate(jw);
      justWatchPath = extractJwPath(jw);
      if (digitalReleaseDate) dateSource = "JustWatch Partner";
    } catch (error) {
      console.error(`[justwatch-partner] ${movie.id}: ${error.message}`);
    }
  }

  if (!digitalReleaseDate) {
    try {
      const publicJw = await justwatchPublicGraphql(
        movie.title || movie.original_title || "",
        movie.id
      );
      const releases = publicJw?.content?.upcomingReleases || [];
      const dates = releases
        .map(item => ({
          date: String(item?.releaseDate || "").slice(0, 10),
          service: item?.package?.clearName || item?.package?.shortName || null
        }))
        .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
        .sort((a, b) => a.date.localeCompare(b.date));
      digitalReleaseDate = dates[0]?.date || null;
      dateService = dates[0]?.service || null;
      dateCountry = digitalReleaseDate ? REGION : null;
      justWatchPath = publicJw?.content?.fullPath || justWatchPath;
      if (digitalReleaseDate) dateSource = "JustWatch public";
    } catch (error) {
      console.error(`[justwatch-public] ${movie.id}: ${error.message}`);
    }
  }

  if (!digitalReleaseDate) {
    try {
      const dates = await justwatchNewTitleDates(
        movie.title || movie.original_title || ""
      );
      const sortedDates = dates
        .map(item => ({
          date: item.date,
          service: item.service
        }))
        .map(item => ({ ...item, time: new Date(item.date).getTime() }))
        .filter(item => !Number.isNaN(item.time))
        .sort((a, b) => Math.abs(a.time - Date.now()) - Math.abs(b.time - Date.now()));
      digitalReleaseDate = sortedDates[0]?.date || null;
      dateService = sortedDates[0]?.service || null;
      dateCountry = digitalReleaseDate ? "FR" : null;
      if (digitalReleaseDate) dateSource = "JustWatch new titles";
    } catch (error) {
      console.error(`[justwatch-new-titles] ${movie.id}: ${error.message}`);
    }
  }

  if (!digitalReleaseDate) {
    try {
      digitalReleaseDate = pickDigitalDate(await tmdb(`/movie/${movie.id}/release_dates`));
      dateCountry = digitalReleaseDate ? REGION : dateCountry;
    } catch (error) {
      console.error(`[tmdb-release] ${movie.id}: ${error.message}`);
    }
  }

  const title = movie.title || movie.original_title || "Titre inconnu";
  const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
  const jwUrl = justWatchPath
    ? (justWatchPath.startsWith("http") ? justWatchPath : `https://www.justwatch.com${justWatchPath}`)
    : justwatchSearchUrl(title, year);
  const dateContext = [dateService, dateCountry === "FR" ? "France" : dateCountry]
    .filter(Boolean)
    .join(" — ");
  const releaseLabel = digitalReleaseDate
    ? `Sortie numérique : ${digitalReleaseDate}${dateContext ? ` — ${dateContext}` : ""}`
    : "Sortie numérique : date inconnue";

  return {
    id: outputId || `jwd:tmdb:${movie.id}`,
    type: "movie",
    name: title,
    poster: poster(movie.poster_path),
    description: movie.overview || "",
    releaseInfo: digitalReleaseDate
      ? `${year} • Numérique : ${digitalReleaseDate}`
      : year,
    released: movie.release_date ? `${movie.release_date}T00:00:00.000Z` : undefined,
    description: [
      releaseLabel,
      movie.overview || ""
    ].filter(Boolean).join("\n\n"),
    website: jwUrl,
    links: [
      {
        name: releaseLabel,
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
  version: "0.2.0",
  name: "JustWatch — Dates numériques",
  description: "Ajoute les informations JustWatch à la fiche des films, avec la date de sortie numérique et les offres disponibles.",
  resources: ["catalog", "meta"],
  types: ["movie"],
  idPrefixes: [],
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
  let tmdbId = null;

  const tmdbMatch = /^(?:jwd:tmdb:|tmdb:)(\d+)$/.exec(raw);
  if (tmdbMatch) {
    tmdbId = tmdbMatch[1];
  } else if (/^tt\d+$/.test(raw)) {
    const found = await tmdb(`/find/${raw}`, {
      external_source: "imdb_id",
      language: LANGUAGE
    });
    tmdbId = found?.movie_results?.[0]?.id ? String(found.movie_results[0].id) : null;
  }

  if (!tmdbId) return { meta: null };

  const movie = await tmdb(`/movie/${tmdbId}`, {
    language: LANGUAGE,
    append_to_response: "external_ids"
  });

  // The detail request must stay responsive. Optional JustWatch enrichment
  // is allowed to time out; the basic TMDB fiche must still be returned.
  const basicMeta = {
    id: raw,
    type: "movie",
    name: movie.title || movie.original_title || "Titre inconnu",
    poster: poster(movie.poster_path),
    description: movie.overview || "",
    releaseInfo: movie.release_date ? movie.release_date.slice(0, 4) : undefined,
    released: movie.release_date ? `${movie.release_date}T00:00:00.000Z` : undefined,
    website: justwatchSearchUrl(
      movie.title || movie.original_title || "",
      movie.release_date ? movie.release_date.slice(0, 4) : ""
    ),
    links: []
  };

  try {
    const enriched = await Promise.race([
      enrichMovie(movie, raw),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000))
    ]);
    return { meta: enriched || basicMeta };
  } catch (error) {
    console.error(`[meta] ${raw}: ${error.message}`);
    return { meta: basicMeta };
  }
}
