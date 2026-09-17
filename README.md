---
title: Centralyser
emoji: 🧩
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# Centralyser

Hub personnel configurable pour les addons de catalogues Stremio.

Centralyser démarre vide : tu ajoutes toi-même les URLs de manifest des addons, tu consultes leurs catalogues et tu choisis ceux que tu veux exposer dans Nuvio. Tu peux ensuite modifier l'URL, actualiser les catalogues, supprimer un addon ou en ajouter d'autres sans réinstaller Centralyser dans Nuvio.

## BetterPoster

BetterPoster est intégré automatiquement. Lorsqu'une fiche contient un identifiant IMDb (`tt...`), Centralyser utilise automatiquement :

`https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=fr`

Aucune installation séparée de BetterPoster comme Custom Art n'est nécessaire pour les catalogues relayés par Centralyser.

## Utilisation

1. Ouvre la page d'accueil de Centralyser.
2. Colle l'URL `/manifest.json` d'un addon.
3. Ajoute l'addon.
4. Sélectionne les catalogues à exposer.
5. Installe **une seule fois** l'URL `/manifest.json` de Centralyser dans Nuvio.

Aucun addon n'est imposé ou préconfiguré.

## Données

La configuration est enregistrée dans `CENTRALYSER_DATA_DIR` (par défaut `/data/centralyser.json`). Pour une configuration conservée lors des reconstructions du Space, utiliser un stockage persistant Hugging Face monté sur `/data`.

Pour protéger la page de configuration d'un Space public, définir le secret `CENTRALYSER_ADMIN_KEY`. Si ce secret n'est pas défini, l'interface reste utilisable sans clé.

## Routes

- `/` — interface de configuration
- `/manifest.json` — manifest Stremio unique à installer dans Nuvio
- `/catalog/:type/:catalogId.json` — relais des catalogues sélectionnés avec BetterPoster automatique
- `/meta/:type/:id.json` — relais des métadonnées avec BetterPoster automatique
- `/health` — état du service
- `/api/addons` — gestion de la configuration

Les données des addons sont conservées, avec uniquement le champ `poster` remplacé automatiquement lorsqu'un identifiant IMDb exploitable est présent.
