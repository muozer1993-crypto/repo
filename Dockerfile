# KOYDUM sunucusu — tek imaj (monorepo kökünden build edin: docker build -t koydum .)
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace packages/shared --workspace apps/server --include-workspace-root --omit=dev=false --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0 DATA_DIR=/data UPLOAD_DIR=/data/uploads
VOLUME ["/data"]
EXPOSE 4000
CMD ["npm", "start", "-w", "apps/server"]
