# Architecture

Deep-dive companion to [`../README.md`](../README.md).

The signal path in one line: **writers -> MXL domain (tmpfs) -> mxl-k8s
gateway/agent bridge -> the consumer node's mirrored domain**. From there
mediamtx republishes a flow as WebRTC and HLS, and the compositor reads
several and publishes one mosaic back into mediamtx.

Everything in that path except the browser and the aggregator is a booked
media function. This app declares the booking and consumes the result.

---

## 1. The booking

A `MediaProduction` owns a namespace, `production-<name>`. Every function this
app needs is a `MediaFunctionClaim` in that namespace:

| Claim | Class | Produces |
|---|---|---|
| four video writers | `mxl-writer` | one v210 test-pattern flow each |
| one audio writer | `mxl-writer` | one audio flow, video disabled |
| mediamtx | `mediamtx` | RTSP, HLS, WebRTC and an HTTP API |
| compositor | `compositor` | a mosaic, plus the audio preview |

The chart in this repository renders those claims into a namespace named by a
required value. It renders no workload for any of them: the class names a
chart in `dmf-catalog`, and the lifecycle plane provisions it.

Claim parameters are provisioning inputs. They are consumed when a function is
provisioned and do not take effect on an already-bound claim, so nothing that
has to change while the app runs belongs in them.

---

## 2. mxl-k8s control plane

Deployed independently of this app, as DaemonSets, and a hard dependency.

**Gateway** runs on every node, watches the domain via fanotify, and bridges
grains across the fabric. **Agent** materialises the mirror on the consumer's
node so a remote flow reads as local, and manages the `MxlReceiver` and
`MxlFlowMirror` resources that record it. **Intent shim**
(`libmxl-intent.so`, `LD_PRELOAD`ed from an init container) blocks the first
`mxlCreateFlowReader` until the mirror is ready, which is what prevents
`FLOW_NOT_FOUND` on startup or reschedule.

Consumers mount the MXL runtime root and resolve the domain below it from
configuration. Mounting the domain directory or `agent.sock` separately is a
defect: a single-file hostPath mount pins the socket's inode, and the agent
unlinks and recreates it on every restart.

Cluster-scoped `MxlFlow` records each flow's origin and freshness;
`MxlReceiver` and `MxlFlowMirror` are namespaced and track the consumer side.

---

## 3. Serving a flow

mediamtx reads a flow zero-copy from the local domain through its MXL static
source and republishes it. Its `mxlSource` refuses any flow whose format is
not video, which is why audio takes the path in section 4.

**Paths are created at runtime, not declared.** The booking carries one
publisher path for the compositor's mosaic and nothing else. Every per-flow
path is added over the mediamtx HTTP API when something wants it and removed
when it stops wanting it. A path added this way starts its source immediately;
it does not need to exist at boot.

This is not a preference. A path declared in the booking reaches the server as
a config file, so changing the set restarts it, and editing a bound claim's
parameters does not reach the running function at all.

The aggregator drives that API. It does not report configuration state back
onto the claim; those conditions belong to an element manager the lifecycle
plane defines, not to an application.

---

## 4. The compositor and the audio preview

The compositor reads flows zero-copy through libmxl, lays them out in one
GStreamer `compositor` element at their native tile size, encodes the mosaic
once with x264, and publishes it over RTSP. Grid geometry is derived from the
flow count: `cols = ceil(sqrt(n))`, `rows = ceil(n / cols)`.

The same image carries a second entry point, the audio preview. Audio flows
cannot go through `mxlSource`, so the preview reads a flow's per-channel ring
buffers, interleaves them, encodes Opus for WebRTC and AAC for HLS, and
publishes both into paths created for it. Neither transport carries the
other's codec, which is why there are two.

Both link `libmxl`. MXL's domain protocol requires every reader and writer
sharing a domain to use a byte-identical `libmxl.so`, so the `go-mxl` tag a
function image is built against and the tag the mxl-k8s gateway was built from
must match exactly. That lock-step is enforced in the function repositories,
not here.

---

## 5. This app

**Aggregator.** A dependency-free Python HTTP server. It merges flow state
from the Kubernetes API and the MXL resources into the metrics panel, and
drives the mediamtx API to open and close preview paths.

It finds mediamtx and the audio preview through the endpoints their claims
publish under `status.handle.endpoints`, gated on `handle.ready`. No Service
name is hardcoded: the namespace a booking lands in is not this app's to
assume.

**Frontend.** An Angular app served by Caddy. Each tile plays its own
`<video>`, trying WHEP first and falling back to HLS. Players are tracked in a
registry and torn down on tab hide and on route change; a tile that goes away
releases the path it asked for, or paths leak.

---

## 6. Routing

A Gateway API `HTTPRoute` attaches to the cluster's ingress gateway. Caddy
serves the app, proxies HLS and WebRTC signalling to mediamtx, and proxies the
API to the aggregator. The mediamtx control API is never exposed through it.
