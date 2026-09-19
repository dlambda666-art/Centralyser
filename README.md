---
title: JustWatch — Dates numériques
emoji: 🎬
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# JustWatch — Dates numériques

Addon Stremio/Nuvio orienté consultation :

- recherche de films ;
- catalogue des sorties numériques à venir en Belgique ;
- date de sortie numérique ;
- lien JustWatch Belgique.

Les dates sont lues depuis TMDB par défaut. Si un token partenaire JustWatch officiel est configuré, le module tente d'utiliser les données JustWatch en priorité.

Secrets recommandés dans le Space :

- `TMDB_API_KEY` — nécessaire pour la recherche et les dates de secours ;
- `JUSTWATCH_PARTNER_TOKEN` — optionnel, uniquement si un accès officiel JustWatch Partner est disponible.
