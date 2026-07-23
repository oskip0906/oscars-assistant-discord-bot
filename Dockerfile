# Panda Discord bot image. SearXNG runs as its own official image alongside this
# one (see docker-compose.deploy.yml) — this Dockerfile builds only the bot.
FROM node:22-bookworm-slim

# ca-certificates: for the postinstall binary downloads (ffmpeg-static, yt-dlp).
# python3/make/g++: node-gyp fallback in case a native dep has no prebuilt binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install deps first for layer caching. npm ci runs postinstall scripts
# (ffmpeg-static + youtube-dl-exec fetch their binaries here).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source + persona files (context/ is read at runtime).
COPY src ./src
COPY context ./context

# Runtime state (transcripts, private-mode flag) lives here; mount a volume over it.
RUN mkdir -p data/context && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
