# Qvest MXL multiviewer

The demo's frontend: an Angular app showing what RDMA delivery carries, the
health of the MXL gateways, and the operator's flow inventory with an on-demand
preview per flow.

It is built to static files and served by the `caddy` sidecar of the mediamtx
Deployment (`k8s/mediamtx-deployment.yaml`). Caddy also reverse-proxies the APIs
the app polls, so everything is same-origin:

| Path          | Backend                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `/api/*`      | `demo-metrics` — the Python aggregator (`k8s/metrics/aggregator.py`)                    |
| `/hls/*`      | mediamtx HLS on `:8888`                                                                 |
| `/webrtc/*`   | mediamtx WHEP signalling on `:8889` (ICE media bypasses Caddy via the UDP LoadBalancer) |
| `/stats.json` | the compositor's raw stats server                                                       |

## Prerequisites

Node 22 (`nvm install 22`). The container build pins its own `node:22-alpine`, so
this is only needed for working locally.

## Running against a real cluster

The app has no mock data — it is a window onto a running demo. Point it at one:

```bash
kubectl -n mxl-system port-forward svc/mediamtx 8080:80   # in one shell
npm install && npm start                                  # in another
```

`proxy.conf.json` forwards `/api`, `/hls`, `/webrtc` and `/stats.json` to that
port-forward, so `http://localhost:4200` gets real flows, real metrics and real
video while serving the app from the dev server.

## Checks

```bash
npm test                      # vitest, jsdom
npm run build                 # production bundle into dist/
npx prettier --check "src/**/*.{ts,html,scss}"
```

## Building the image

```bash
docker build -t ghcr.io/qvest-digital/mxl-dmf-demo-app/ui:dev .
```

The image is `caddy:2-alpine` with `dist/mxl-multiviewer/browser` copied to
`/srv`. The Caddyfile is deliberately **not** baked in — it stays a
kustomize-generated ConfigMap (`k8s/config/Caddyfile`) so the routes above remain
editable through GitOps without rebuilding. To serve the image by hand:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/../k8s/config/Caddyfile:/etc/caddy/Caddyfile:ro" \
  ghcr.io/qvest-digital/mxl-dmf-demo-app/ui:dev
```

CI (`.github/workflows/build-ui.yml`) runs the tests and pushes the image to GHCR
on every change under `ui/`.

The app is one route (`/`) and anything else redirects to it, which is why the
Caddyfile still needs `try_files {path} /index.html` — without it a reload on any
other path 404s against the file server before the router ever sees it.

## How it is put together

```
src/app/
  core/api/       typed calls to the aggregator + the polling helper
  core/player/    WHEP, hls.js, and the registry that tears players down
  shared/         kv-row, video shell, formatting pipes, origin-state mapping
  features/       the multiviewer page, plus the flow-preview cards
```

Three things are less obvious than they look, and all three were bugs once:

- **Players are registered, not just created.** Chrome does not throttle
  background-tab WebRTC decode, so an unattended wall of tiles kept pulling
  ~12 Mbit/s behind a Google Meet tab and starved the call. `PlayerRegistry`
  tracks every PeerConnection and Hls instance so a teardown releases the whole
  set in one pass, mediamtx paths included. `window.__mvDebug.counts()` reports
  what is live. Only a preview card opens a player now, and each one owns its
  own teardown.
- **Origin freshness is three-state.** Green means an origin Lease is being
  renewed, orange means the claim outlived its Lease, grey means nothing claims
  Origin at all. Grey is _unknown_, not broken — most flows carry no
  `OriginFresh` condition, and reading its absence as "stale" painted red dots on
  healthy flows. See `shared/origin-state.ts`.
- **Not everything on screen is measured.** Nominal bitrates are arithmetic off
  the flow definition and are dimmed to say so; the compositor's numbers are the
  only measured throughput. Anything unknown reads `--` rather than `0`.

Styles live in `src/styles.scss` rather than in component stylesheets: they are
shared classes carried over from the page this app replaces, and the components
are `display: contents` so the parent/child relationships that CSS was written
against still hold.
