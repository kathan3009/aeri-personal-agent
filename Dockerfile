FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --no-audit --no-fund
COPY apps/api apps/api
COPY packages/core packages/core
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@personal-agent/api"]
