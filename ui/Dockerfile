# The Qvest multiviewer: an Angular app built to static files and served by the
# same caddy:2-alpine the pod used before, so the sidecar's command, ports and
# probes are unchanged — only where /srv comes from.
#
# The Caddyfile is deliberately NOT baked in. It stays a kustomize-generated
# ConfigMap mounted at /etc/caddy (k8s/config/Caddyfile), which keeps the reverse
# proxies to /api, /hls and /webrtc editable through GitOps without rebuilding
# this image.

FROM node:22-alpine AS build
WORKDIR /app

# Copy the manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx ng build --configuration production

FROM caddy:2-alpine
COPY --from=build /app/dist/mxl-multiviewer/browser /srv
