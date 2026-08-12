# dmf-app-qutil

The Qvest DMF and MXL utility app. A browser multiviewer over MXL flows: it
books the media functions it needs, shows what the transport is doing, and
serves the result as WebRTC and HLS.

## What it demonstrates

- **Cross-node RDMA flow mirroring via mxl-k8s.** Writers produce v210
  test-pattern flows into a shared tmpfs domain; the mxl-k8s gateway and agent
  DaemonSets bridge grains across the fabric so a flow written on one node
  reads as local on another, with no copy.
- **Everything is a booking.** The writers, the mediamtx that serves them and
  the compositor that mosaics them are all `MediaFunctionClaim`s against the
  DMF catalog, provisioned into the namespace a `MediaProduction` owns. This
  app declares the booking and consumes the result; it implements none of it.
  The chart books what the demo always needs, and the Generators page books a
  test pattern on demand for what it does not.
- **Flows are served on demand.** Nothing static describes a flow. Each tile
  asks for a path when it opens and releases it when it closes, over the
  mediamtx HTTP API.
- **Live WebRTC and HLS delivery**, WHEP first with HLS as the fallback.

## How it fits together

Writers produce flows into the MXL domain. The mxl-k8s control plane makes a
flow written anywhere readable on the node that wants it. mediamtx reads a
flow zero-copy from the local domain and republishes it; the compositor reads
several and publishes one mosaic back into mediamtx over RTSP.

This app supplies the two things that are not media functions: the Angular
multiviewer the browser loads, and an aggregator that merges Kubernetes and
MXL state into the metrics panel and drives mediamtx's HTTP API to open and
close preview paths.

Both mediamtx and the compositor are reached through the endpoints their
claims publish, so this app holds no Service address of its own.

## Repository layout

| Path | Contents |
|------|----------|
| `ui/` | The Angular multiviewer, built into a Caddy-based image. See `ui/README.md` for local development against a running cluster. |
| `charts/` | The Helm chart: the app, its aggregator, and the claims that book the media functions it consumes. |
| `.github/` | CI. The chart and the UI image share one release version. |

## What is not here

No media function. mediamtx lives in
[`dmf-mf-mediamtx`](https://github.com/qvest-digital/dmf-mf-mediamtx) and the
compositor in
[`dmf-mf-mxl-compositor`](https://github.com/qvest-digital/dmf-mf-mxl-compositor);
their charts and catalog entries live in the DMF catalog repository. This
repository books them, it does not build or package them.

## Documentation

- [docs/architecture.md](docs/architecture.md) covers the signal path, the
  booking model and how the app finds what it booked.
- [docs/ci-and-release.md](docs/ci-and-release.md) covers the build outputs
  and the joint release.
