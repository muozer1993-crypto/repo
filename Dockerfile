# KOYDUM server. Build from the repository root:
#   docker build -t koydum .
#   docker run -p 4000:4000 -v koydum-data:/data -e PUBLIC_URL=http://<your-host>:4000 koydum
FROM node:22-alpine

# better-sqlite3 falls back to compiling from source when there is no prebuilt
# binary for this platform
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install with the lockfile first so Docker can cache this layer. Every
# workspace package.json is copied because npm validates the whole workspace
# graph against the lockfile, even when installing a subset.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --include-workspace-root --workspace packages/shared --workspace apps/server \
    && npm cache clean --force

# The server runs the TypeScript sources through tsx, and imports
# @koydum/shared as source, so both are copied as-is.
COPY packages/shared packages/shared
COPY apps/server apps/server

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads

VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start", "-w", "apps/server"]
