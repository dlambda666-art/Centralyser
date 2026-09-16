FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server-fixed.js ./

ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
