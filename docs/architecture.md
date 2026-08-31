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
| compositor | `compositor` | a mosaic |

The chart in this repository renders those claims into a namespace named by a
required value. It renders no workload for any of them: the class names a
chart in `dmf-catalog`, and the lifecycle plane provisions it.

Claim parameters are provisioning inputs. They are consumed when a function is
provisioned, and on a bound claim they take effect only where
`lifecycle.reprovisionOnDrift` is set -- which re-materializes the workload, so
the writers this chart books restart when their parameters change and the
generators booked from the UI, which set it false, do not. Either way nothing
that has to change while a function runs belongs in them.

The chart is no longer the only thing that renders claims: the Generators page
books writers at runtime through the aggregator, where the install has enabled
it. Those claims carry a `managed-by` label of their own, are named with a
reserved prefix, and expire through `booking.window.end`, because neither Helm
nor Flux prunes an object it never rendered.

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
source and republishes it. Video and audio both go through it, and a path can
name one of each: the server publishes them as two tracks, which is what lets
a browser play picture and sound in step. Nothing downstream rejoins separate
flows, so a card that wants both has to name both.

An audio path publishes one Opus track, and because the server muxes fMP4
rather than MPEG-TS that track serves HLS as well as WebRTC. A browser plays
two channels however wide the flow is, so the path names the 1-based pair;
naming another pair reconfigures the path, and a listener hears the gap.

**Paths are created at runtime, not declared.** The booking carries one
publisher path for the compositor's mosaic and nothing else. Every per-flow
path is added over the mediamtx HTTP API when something wants it and removed
when it stops wanting it. A path added this way does not need to exist at boot,
and it opens its flow only once a reader attaches: an encode nobody is watching
costs about 1.4 cores, and four of seven paths were measured running for zero
readers before the sources were made on-demand.

This is not a preference. A path declared in the booking reaches the server as
a config file, so changing the set restarts it, and editing a bound claim's
parameters does not reach the running function at all.

The aggregator drives that API. It does not report configuration state back
onto the claim; those conditions belong to an element manager the lifecycle
plane defines, not to an application.

---

## 4. The compositor

The compositor reads flows zero-copy through libmxl, lays them out in one
GStreamer `compositor` element at their native tile size, encodes the mosaic
once with x264, and publishes it over RTSP. Grid geometry is derived from the
flow count: `cols = ceil(sqrt(n))`, `rows = ceil(n / cols)`.

It publishes to the media server's origin address rather than its read one. A
path added over the API lives in one process's memory, so a publish has to
land on the instance the read replicas proxy.

It links `libmxl`. MXL's domain protocol requires every reader and writer
sharing a domain to use a byte-identical `libmxl.so`, so the `go-mxl` tag a
function image is built against and the tag the mxl-k8s gateway was built from
must match exactly. That lock-step is enforced in the function repositories,
not here.

---

## 5. This app

**Aggregator.** A dependency-free Python HTTP server. It merges flow state
from the Kubernetes API and the MXL resources into the metrics panel, drives the
mediamtx API to open and close preview paths, and -- where the install enables it
-- creates and deletes the writer claims the Generators page books. Its reads are
cluster-wide; both of its write grants are Roles in the production namespace, and
it refuses to delete a claim that does not carry the label it stamps on its own.

It finds mediamtx through the endpoints its claim publishes under
`status.handle.endpoints`, gated on `handle.ready`. No Service name is
hardcoded: the namespace a booking lands in is not this app's to assume.

The polled routes report cluster state and nothing about who asked, so each is
served from a snapshot rebuilt at most once a second by one thread at a time:
what the panels cost follows the cluster, not the number of open tabs. Past a
ceiling of requests in flight a poll is refused rather than queued, which the
frontend absorbs by keeping the value it last had. The health route is answered
ahead of that ceiling, so shedding load cannot fail a liveness probe.

**Frontend.** An Angular app served by Caddy. Each tile plays its own
`<video>`, trying WHEP first and rebuilding it whenever the connection drops or
the media stops arriving. HLS is where it lands once those rebuilds are spent,
and it climbs back to WHEP on a backoff rather than staying there. Players are
tracked in a registry and torn down on tab hide and on route change, and the
card that owns one puts it back when the tab returns; a tile that goes away
releases the path it asked for, or paths leak.

---

## 6. Routing

A Gateway API `HTTPRoute` attaches to the cluster's ingress gateway. Caddy
serves the app, proxies HLS and WebRTC signalling to mediamtx, and proxies the
API to the aggregator. The mediamtx control API is never exposed through it.
