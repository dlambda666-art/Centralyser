FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server-fixed.js ./

# Remplace le message initial trompeur : aucun addon n'est lancé automatiquement.
RUN sed -i 's/Chargement…/Vérification de la configuration…/g' server-fixed.js

ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
