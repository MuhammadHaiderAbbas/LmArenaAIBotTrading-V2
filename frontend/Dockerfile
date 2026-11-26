FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 2.11 (Caddy v2.11.x on Alpine 3.24): 2.10 shipped Go/stdlib, grpc and smallstep CVEs flagged by Trivy.
FROM caddy:2.11-alpine
# Pick up OS security fixes (e.g. OpenSSL) published after the base image was built.
RUN apk upgrade --no-cache
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
