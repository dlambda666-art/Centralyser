---
title: Centralyser
emoji: 🧩
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# Centralyser

Agrégateur dynamique de catalogues Stremio.

Centralyser récupère les manifestes des addons configurés et expose leurs catalogues derrière un seul manifest Stremio.

## Sources

- FrankenStream
- French Stream Enhanced
- AIOMeta (optionnel via `AIOMETA_MANIFEST_URL`)

## Routes

- `/manifest.json`
- `/catalog/:type/:catalogId.json`
- `/meta/:type/:id.json`
- `/health`

Les réponses de catalogue et de métadonnées des sources sont relayées sans réécriture des objets `meta`, afin de préserver notamment les posters BetterPoster.

<!-- deployment trigger -->
