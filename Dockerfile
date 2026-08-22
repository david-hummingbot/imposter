FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy application source.
#
# Deliberately a glob rather than a hand-listed set of files: this image shipped
# broken for a while because persistence.js was added to the app and nobody
# updated a `COPY server.js game.js words.js` line, so the container crashed on
# startup with "Cannot find module './persistence'". A glob cannot forget.
COPY *.js words.json ./
COPY public ./public

# Room snapshots live outside the source tree so a bind- or named-volume can
# keep active games alive across a restart or redeploy.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Cheap liveness probe — no extra dependency, just the runtime we already have.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
