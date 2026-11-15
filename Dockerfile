FROM node:24-bookworm-slim
WORKDIR /app
COPY mockup/package*.json ./
RUN npm ci --omit=dev
COPY mockup/ ./
RUN npm run build
COPY LICENSE ./
RUN mkdir /backups && chown node:node /backups
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
