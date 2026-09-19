FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY justwatch-dates.js ./
COPY justwatch-server.js ./
ENV PORT=7860
EXPOSE 7860
CMD ["npm","start"]
