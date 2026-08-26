#!/usr/bin/env python3
# demo-metrics: dependency-free aggregator for the multiviewer client.
#
# Merges, per flow, everything we can cheaply reach:
#   - compositor  : the stats endpoint its claim publishes (measured per-flow
#                    grains/s, Mbit/s, grains pushed/dropped -- see GRAIN_RATE)
#   - writer pod  : k8s API (node, phase, restarts, image, pattern, age)
#   - receiver    : MxlReceiver CR (phase, provider, bound mirror)
#   - mirror      : MxlFlowMirror CR (phase, sourceNode, provider)
#   - flow        : MxlFlow CR (OriginFresh, per-node origin locations)
#   - origin      : per-flow origin Lease in mxl-system (freshness, see below)
#   - gateways    : mxl-system gateway pods (node, ready, restarts)
#
# Endpoints:
#   GET    /api/flows              -> the demo writer set, merged as above
#   GET    /api/operator-flows     -> every MxlFlow the operator knows
#   GET    /api/booking            -> the per-booking instances and their story
#   POST   /api/preview/<uuid>     -> provision a mediamtx path for a flow
#   GET    /api/preview/<uuid>     -> whether an audio preview is producing yet
#   DELETE /api/preview/<uuid>     -> release this owner's hold on the path
#   GET    /api/anc/<uuid>         -> the latest decoded ANC grain of a data flow
#   GET    /api/generators         -> the writer claims the UI booked
#   GET    /api/generators/flow-ids-> two unused MXL flow ids
#   POST   /api/generators         -> book a writer claim
#   DELETE /api/generators/<name>  -> release one
#   POST   /api/kill/<n>           -> delete the writer-mxl-<n> pod (watch it recover)
#
# Runs in-cluster with a scoped ServiceAccount; talks to the API server with the
# mounted SA token + CA. Reads are cluster-wide; the writes it can do -- deleting
# a writer pod and creating or deleting a generator claim -- are granted in the
# production namespace only. No pip deps so it runs on stock python:3-slim.
import base64, json, os, re, secrets, ssl, threading, time, urllib.parse, urllib.request, urllib.error
import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def _own_namespace():
    # The app runs in demo-app on the sc cluster but in default on the EKS demo
    # (Flux targetNamespace). Read the pod's own namespace so the namespaced
    # queries (pods/receivers/mirrors) hit the right one on either cluster.
    try:
        with open("/var/run/secrets/kubernetes.io/serviceaccount/namespace") as f:
            return f.read().strip()
    except OSError:
        return "demo-app"


NS = os.environ.get("DEMO_NS") or _own_namespace()
GW_NS = os.environ.get("GW_NS", "mxl-system")
# The writers are booked from the catalog, so they run in the namespace the
# MediaProduction owns rather than beside this aggregator.
WRITER_NS = os.environ.get("WRITER_NS", "production-demo-app")
FLOW_PREFIX = os.environ.get("FLOW_PREFIX", "d4d00000-0000-0000-0000-00000000000")
N_FLOWS = int(os.environ.get("N_FLOWS", "4"))

# No consumer measures what the four per-flow TILES receive: each one goes
# producer -> RDMA mirror -> mediamtx, and mediamtx does not report per-path
# grain counters. The compositor does measure though -- it opens its own reader
# on all four flows for the mosaic -- so the panel reports its counters and says
# so, rather than deriving numbers that look live but never move.
#
# These constants are the fallback for when the compositor is unreachable or
# does not carry a flow: a Ready mirror transfers every 720p v210 grain at the
# grain rate, so the shape is right even though the value cannot change.
GRAIN_RATE = 30000.0 / 1001.0   # 29.97 fps
GRAIN_BYTES = 2488320           # 720p v210 (1296 px wide -> 3456 B/row * 720)
# Resolved from the compositor claim like every other booked address; see
# _resolve_base. An explicit value still wins, for a port-forwarded dev loop.
COMPOSITOR = os.environ.get("COMPOSITOR_STATS")

API = "https://kubernetes.default.svc"
SA = "/var/run/secrets/kubernetes.io/serviceaccount"
# Guarded so the pure helpers below import outside a cluster, the same reason
# _own_namespace tolerates a missing namespace file. In-cluster both exist.
try:
    with open(SA + "/token") as f:
        TOKEN = f.read().strip()
    CTX = ssl.create_default_context(cafile=SA + "/ca.crt")
except OSError:
    TOKEN = ""
    CTX = None


def k8s(path, method="GET"):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, context=CTX, timeout=8) as r:
        return json.load(r) if method == "GET" else {"status": r.status}


def safe_k8s(path):
    try:
        return k8s(path)
    except Exception as e:
        return {"_error": str(e)}


def k8s_json(path, method="GET", body=None):
    """Like k8s(), but carries a request body and reports what came back.

    k8s() throws its response away for anything but a GET, so an AlreadyExists
    or an Invalid would reach the operator as "HTTP Error 409: Conflict" with the
    API server's own sentence discarded. Creating a claim is the first call here
    whose failure is worth reading, hence a second function rather than a change
    to the one every read path uses.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=8) as r:
            raw = r.read().decode().strip()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            status = json.loads(e.read().decode())
        except Exception:
            status = {}
        # A k8s Status carries the readable part in message; reason is the
        # machine-readable half (AlreadyExists, Forbidden, Invalid).
        return e.code, {"error": status.get("message") or f"apiserver said {e.code}",
                        "reason": status.get("reason")}
    except Exception as e:
        return 503, {"error": f"apiserver unreachable: {e}"}


def compositor_stats():
    base = _resolve_base(COMPOSITOR, "compositor-stats", COMPOSITOR_CLAIM,
                         "compositor", "stats")
    if not base:
        return {"_error": "no ready compositor claim in " + CLAIM_NS,
                "flows": []}
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/", timeout=5) as r:
            return json.load(r)
    except Exception as e:
        return {"_error": str(e), "flows": []}


def idx_of(uuid):
    # FLOW_PREFIX + single digit
    try:
        return int(uuid[len(FLOW_PREFIX):])
    except Exception:
        return None


def build():
    stats = compositor_stats()
    # The compositor opens a reader on every flow to build the 2x2 mosaic, so
    # its per-flow counters are a real measurement of RDMA delivery. Keyed by
    # flowId, not by the worker index it also reports, so a reordered
    # MXL_FLOW_IDS cannot shift one flow's numbers onto another's tile.
    comp_by_id = {f.get("flowId"): f for f in stats.get("flows", [])}
    comp_err = stats.get("_error")

    pods = safe_k8s(f"/api/v1/namespaces/{NS}/pods").get("items", [])
    writer_pods = (pods if WRITER_NS == NS
                   else safe_k8s(f"/api/v1/namespaces/{WRITER_NS}/pods").get("items", []))
    receivers = safe_k8s(
        f"/apis/mxl.qvest-digital.com/v1alpha1/namespaces/{NS}/mxlreceivers").get("items", [])
    mirrors = safe_k8s(
        f"/apis/mxl.qvest-digital.com/v1alpha1/namespaces/{NS}/mxlflowmirrors").get("items", [])
    # MxlFlow is CLUSTER-scoped (MxlReceiver/MxlFlowMirror are namespaced), so
    # it has to be listed at the non-namespaced path -- the namespaced URL
    # returns nothing, which is why "origin fresh" read as unknown/no.
    flows = safe_k8s(
        "/apis/mxl.qvest-digital.com/v1alpha1/mxlflows").get("items", [])
    gw_pods = safe_k8s(f"/api/v1/namespaces/{GW_NS}/pods?labelSelector=app.kubernetes.io/component=gateway").get("items", [])

    def find_pod(app):
        # The chart names the release after the claim, so the claim name lands
        # on app.kubernetes.io/instance. Older raw Deployments carried it as
        # plain app; both are accepted so a half-migrated cluster still reads.
        for p in writer_pods:
            labels = p.get("metadata", {}).get("labels", {})
            if app in (labels.get("app.kubernetes.io/instance"), labels.get("app")):
                return p
        return None

    def flow_cr(uuid):
        for fl in flows:
            if fl.get("metadata", {}).get("name") == uuid:
                return fl
        return None

    def receiver_for(uuid):
        for rc in receivers:
            if rc.get("spec", {}).get("flowID") == uuid:
                return rc
        return None

    def mirror_for(uuid):
        out = []
        for m in mirrors:
            if m.get("metadata", {}).get("name", "").startswith(uuid):
                out.append(m)
        return out

    gateways = []
    for p in gw_pods:
        cs = (p.get("status", {}).get("containerStatuses") or [{}])[0]
        gateways.append({
            "name": p["metadata"]["name"],
            "node": p.get("spec", {}).get("nodeName"),
            "phase": p.get("status", {}).get("phase"),
            "ready": cs.get("ready"),
            "restarts": cs.get("restartCount"),
            "image": cs.get("image"),
        })

    result = []
    for n in range(1, N_FLOWS + 1):
        uuid = FLOW_PREFIX + str(n)
        app = f"writer-mxl-{n}"
        pod = find_pod(app)
        writer = None
        if pod:
            cs = (pod.get("status", {}).get("containerStatuses") or [{}])[0]
            env = {e["name"]: e.get("value") for e in
                   (pod.get("spec", {}).get("containers", [{}])[0].get("env") or [])}
            writer = {
                "pod": pod["metadata"]["name"],
                "node": pod.get("spec", {}).get("nodeName"),
                "phase": pod.get("status", {}).get("phase"),
                "ready": cs.get("ready"),
                "restarts": cs.get("restartCount"),
                "started": pod.get("status", {}).get("startTime"),
                "image": cs.get("image"),
                "pattern": env.get("MXL_FLOW_PATTERN"),
                "overlay": env.get("MXL_FLOW_OVERLAY"),
                # Overlay compositing format the writer runs (I420 fast path vs
                # the deliberate v210 reference tile). Defaults to I420 like the
                # writer itself when the env is unset.
                "overlayFormat": env.get("MXL_OVERLAY_FORMAT") or "I420",
            }

        rc = receiver_for(uuid)
        receiver = None
        if rc:
            receiver = {
                "name": rc["metadata"]["name"],
                "provider": rc.get("spec", {}).get("provider"),
                "phase": rc.get("status", {}).get("phase"),
                "boundMirror": (rc.get("status", {}).get("boundMirror") or {}).get("name"),
            }

        mlist = []
        for m in mirror_for(uuid):
            mlist.append({
                "name": m["metadata"]["name"],
                "phase": m.get("status", {}).get("phase"),
                "sourceNode": m.get("spec", {}).get("sourceNode"),
                "provider": m.get("spec", {}).get("provider"),
            })

        fl = flow_cr(uuid)
        flow_info = None
        media = None
        if fl:
            conds = {c["type"]: c for c in (fl.get("status", {}).get("conditions") or [])}
            of = conds.get("OriginFresh", {})
            flow_info = {
                "originFresh": of.get("status"),
                "originReason": of.get("reason"),
                "locations": [{"node": l.get("nodeName"), "phase": l.get("phase")}
                              for l in (fl.get("status", {}).get("locations") or [])],
            }
            # Media metadata straight off the flow definition: v210, resolution,
            # bit depth, grain rate, and the resulting uncompressed grain size /
            # RDMA throughput. v210 rows pad to a 48-pixel (128-byte) stride.
            d = fl.get("spec", {}).get("definition", {}) or {}
            if d.get("frame_width"):
                w = d.get("frame_width")
                h = d.get("frame_height") or 0
                gr = d.get("grain_rate", {}) or {}
                num = gr.get("numerator") or 0
                den = gr.get("denominator") or 1
                comps = d.get("components") or []
                stride = ((w + 47) // 48) * 128
                gbytes = stride * h
                rate = (num / den) if num else GRAIN_RATE
                media = {
                    "mediaType": d.get("media_type"),
                    "width": w,
                    "height": h,
                    "bitDepth": (comps[0].get("bit_depth") if comps else None),
                    "colorspace": d.get("colorspace"),
                    "grainRate": (f"{num}/{den}" if num else None),
                    "fps": round(rate, 2),
                    "grainBytes": gbytes,
                    # Nominal, NOT observed: grain size x grain rate is the
                    # bitrate the format implies if every grain is delivered on
                    # time. Nothing on the fabric is measured here -- the mirror
                    # CRs carry no byte counters and the gateway exports only
                    # controller-runtime metrics. Named so it cannot be read as
                    # throughput; the measured figure is comp.mbps.
                    "nominalMbps": round(gbytes * rate * 8 / 1e6),
                }

        writer_ok = bool(writer and writer.get("ready"))
        mirror_ok = any(m.get("phase") == "Ready" for m in mlist)
        origin_ok = bool(flow_info and flow_info.get("originFresh") == "True")
        # A flow is live if its writer is up and its origin lease is fresh, AND
        # it's delivered: either a Ready cross-node mirror, or NO mirror at all
        # (the flow's producer is co-located with mediamtx, so it's read locally
        # -- placement is dynamic, so which flow is local varies). Requiring a
        # mirror unconditionally made the local flow show as down.
        live = writer_ok and origin_ok and (mirror_ok or not mlist)

        # Delivery numbers: measured from the compositor's own readers when it
        # is reachable and reading this flow, nominal otherwise. "measured"
        # tells the panel which it got -- a derived number that cannot move is
        # honest only if it says so.
        cs = comp_by_id.get(uuid)
        if cs:
            comp = {
                "fps": round(cs.get("fps") or 0, 1),
                "mbps": round(cs.get("mbps") or 0),
                "pushed": cs.get("pushed"),
                "missed": cs.get("missed"),
                # The compositor's own reader state (it reports fps > 1), which
                # is the data plane. "live" below stays the control-plane view.
                "reading": bool(cs.get("live")),
                "measured": True,
                "source": COMPOSITOR,
            }
        else:
            gbytes = (media or {}).get("grainBytes") or GRAIN_BYTES
            rate = (media or {}).get("fps") or GRAIN_RATE
            comp = {
                "fps": round(rate, 1) if live else 0,
                "mbps": round(gbytes * rate * 8 / 1e6) if live else 0,
                "pushed": None,
                "missed": None,
                "reading": None,
                "measured": False,
                "source": ("compositor unreachable" if comp_err
                           else "flow not in the compositor's set"),
            }
        comp["live"] = live

        result.append({
            "n": n,
            "label": f"MXL-{n}",
            "uuid": uuid,
            "compositor": comp,
            "media": media,
            "writer": writer,
            "receiver": receiver,
            "mirrors": mlist,
            "flow": flow_info,
        })

    return {
        "provider": "verbs",
        "grid": {"cols": 1, "rows": len(result)},
        "grainBytes": GRAIN_BYTES,
        "gateways": gateways,
        "flows": result,
    }


# -- Booking lifecycle -------------------------------------------------------
# The MediaOps booking deploys a per-booking txDarwin instance: a
# MediaFunctionInstance CR, from which the DMF operator renders a HelmRelease,
# which Flux turns into a pod. The showcase screen needs all three, plus the
# instance's *wired* sources -- that is what tells template-1 (2 sources) from
# template-2 (3), and it lives in the HelmRelease values, not in the CR.
BOOKING_NS = os.environ.get("BOOKING_NS", "txdarwin")
# txDarwin serves its API over a self-signed cert on the pod itself.
INSECURE = ssl._create_unverified_context()


def _age(ts):
    """ISO8601 -> seconds, or None. The UI renders relative times itself."""
    if not ts:
        return None
    try:
        t = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return int((datetime.now(timezone.utc) - t).total_seconds())
    except Exception:
        return None


def _cond(obj, typ):
    for c in (obj.get("status", {}) or {}).get("conditions", []) or []:
        if c.get("type") == typ:
            return c
    return {}


def darwin_reader_flow(name):
    """The flow the instance is reading *right now*.

    The HelmRelease values only say where the reader was told to start; an
    operator can switch it in txDarwin's own UI, and the showcase's whole point
    is that this switch is visible. Ask the instance instead. Self-signed cert,
    chart-default credentials, short timeout -- a slow or absent instance must
    not stall the screen.
    """
    try:
        # Fully qualified (this aggregator runs in the demo namespace, the
        # instance Services in the booking one) and against the LIST endpoint:
        # this API version 404s on /modules/<id>, it only serves the
        # collection. Pick the reader out of it.
        req = urllib.request.Request(f"https://{name}.{BOOKING_NS}:8002/modules")
        req.add_header("Authorization", "Basic " + base64.b64encode(b"admin:admin").decode())
        with urllib.request.urlopen(req, context=INSECURE, timeout=2) as r:
            mods = (json.load(r) or {}).get("data") or []
        reader = next((m for m in mods if m.get("type") == "MxlReader"), None)
        return ((reader or {}).get("options") or {}).get("flowId")
    except Exception:
        return None


def phase_of(inst, hr_exists, replicas, pod):
    """Where the booking stands, in the words the schedule uses.

    Derived rather than reported: nothing in the cluster knows about pre-roll.
    The CR is the booking's intent, the pod is the workload, and the release
    outlives both under a ScaleToZero reclaim.
    """
    if inst and not (pod and pod.get("phase") == "Running"):
        return "deploying"          # pre-roll: intent exists, workload coming up
    if inst and pod and pod.get("phase") == "Running" and not pod.get("deleting"):
        return "on-air"
    if not inst and pod:
        return "post-roll"          # CR pruned, workload winding down
    if not inst and hr_exists and replicas == 0:
        return "reclaimed"
    if not inst and not hr_exists:
        return "idle"
    return "unknown"


def booking():
    instances = safe_k8s(
        f"/apis/dmf.qvest-digital.com/v1alpha1/namespaces/{BOOKING_NS}/mediafunctioninstances"
    ).get("items", [])
    releases = safe_k8s(
        f"/apis/helm.toolkit.fluxcd.io/v2/namespaces/{BOOKING_NS}/helmreleases"
    ).get("items", [])
    pods = safe_k8s(f"/api/v1/namespaces/{BOOKING_NS}/pods").get("items", [])

    hr_by_name = {h["metadata"]["name"]: h for h in releases}
    # An instance is torn down CR-first, so key the view on the HelmRelease:
    # it outlives the CR (ScaleToZero) and its replicaCount is what actually
    # says whether the workload is meant to be running.
    names = sorted(set(list(hr_by_name) + [i["metadata"]["name"] for i in instances]))

    out = []
    for name in names:
        hr = hr_by_name.get(name, {})
        inst = next((i for i in instances if i["metadata"]["name"] == name), None)
        vals = (hr.get("spec", {}) or {}).get("values", {}) or {}
        flow = vals.get("flow", {}) or {}
        sources = flow.get("readerFlowIds") or ([flow["readerFlowId"]] if flow.get("readerFlowId") else [])
        pod = next((p for p in pods if p["metadata"]["name"].startswith(name + "-")), None)
        ready = _cond(hr, "Ready")
        out.append({
            "name": name,
            # The CR is the booking's intent; once it is gone the instance is
            # being reclaimed even though the release object may linger.
            "type": ((inst or {}).get("spec", {}) or {}).get("typeName"),
            "instancePhase": ((inst or {}).get("status", {}) or {}).get("phase") if inst else "reclaimed",
            "jobRef": (((inst or {}).get("spec", {}) or {}).get("booking", {}) or {}).get("jobRef"),
            "windowEnd": ((((inst or {}).get("spec", {}) or {}).get("booking", {}) or {}).get("window", {}) or {}).get("end"),
            "replicas": vals.get("replicaCount"),
            "helmReady": ready.get("status") == "True",
            "helmMessage": ready.get("message"),
            # Source count IS the template: 2 -> template-1, 3 -> template-2.
            # sources[0] is where the chart starts the reader.
            "sources": sources,
            "readerFlow": sources[0] if sources else None,
            # What it was configured to read vs. what it actually reads.
            "liveReaderFlow": None,
            "outFlow": flow.get("writerFlowId") or None,
            "pod": None if not pod else {
                "name": pod["metadata"]["name"],
                "phase": pod.get("status", {}).get("phase"),
                "node": pod.get("spec", {}).get("nodeName"),
                "ageSeconds": _age(pod["metadata"].get("creationTimestamp")),
                "deleting": bool(pod["metadata"].get("deletionTimestamp")),
            },
        })

    for row, name in ((r, r["name"]) for r in out):
        row["phase"] = phase_of(
            next((i for i in instances if i["metadata"]["name"] == name), None),
            name in hr_by_name, row["replicas"], row["pod"],
        )
        if row["phase"] == "on-air":
            row["liveReaderFlow"] = darwin_reader_flow(name) or row["readerFlow"]
        else:
            row["liveReaderFlow"] = row["readerFlow"]

    # Events carry the visible lifecycle ("Scheduled", "Pulled", "Started",
    # "Killing"). Newest last so the client can append without re-sorting.
    ev = safe_k8s(f"/api/v1/namespaces/{BOOKING_NS}/events?limit=40").get("items", [])
    events = sorted(
        ({
            "at": e.get("lastTimestamp") or e.get("eventTime"),
            "reason": e.get("reason"),
            "object": (e.get("involvedObject", {}) or {}).get("name"),
            "kind": (e.get("involvedObject", {}) or {}).get("kind"),
            "message": (e.get("message") or "")[:160],
        } for e in ev if e.get("lastTimestamp") or e.get("eventTime")),
        key=lambda x: x["at"] or "",
    )[-25:]

    return {"namespace": BOOKING_NS, "instances": out,
            "events": events, "story": storyline(events)}


# Kubernetes narrates its own plumbing: four container images pulled, four
# containers created, four started, per pod. On a stage that is noise. Keep the
# beats an audience can follow, and say them in the language of the schedule.
STORY = {
    "Scheduled":         ("deploy",   "Instance {obj} scheduled"),
    "ScalingReplicaSet": ("deploy",   "Workload scaling up"),
    "InstallSucceeded":  ("live",     "Instance {obj} installed"),
    "UpgradeSucceeded":  ("live",     "Instance {obj} upgraded"),
    "Killing":           ("teardown", "Instance {obj} being reclaimed"),
    "UninstallSucceeded": ("teardown", "Instance {obj} removed"),
}


def storyline(events):
    """The five beats that matter, newest last, one line each."""
    out = []
    for e in events:
        beat = STORY.get(e.get("reason"))
        if not beat:
            continue
        kind, text = beat
        obj = (e.get("object") or "").split("-")[0]
        out.append({"at": e["at"], "kind": kind, "text": text.format(obj=obj)})
    return out[-12:]


# -- Origin freshness --------------------------------------------------------
# status.conditions[OriginFresh] is NOT a per-flow health field: the operator
# stamps it only while reconciling an MxlReceiver that names the flow (and only
# when it has an opinion -- "no origin yet" is deliberately left unwritten). So
# every flow nobody receives cross-node -- the ST 2110 gateway flows, tcp-demo,
# the booking flows -- carries no condition at all, and reading its absence as
# "not fresh" painted a red dot on perfectly healthy flows.
#
# Derive it the way the operator's own resolveSourceNode does instead, from two
# things that exist for every flow: status.locations[].phase == Origin says who
# claims to hold the authoritative copy, and the Lease
# mxl-flow-<flowID>-<node> in mxl-system says whether that node's agent is
# still alive (renewed every ~10s, 30s duration, released when the flow
# vanishes). The Lease filters the claim -- it never replaces it, because the
# agent renews one for every flow directory on its disk, mirror copies
# included.
LEASE_NS = os.environ.get("MXL_LEASE_NS", "mxl-system")
LEASE_PREFIX = "mxl-flow-"
LEASE_SECONDS = 30      # agent default, and the operator's own fallback


def _renew_time(ts):
    """Lease renewTime (RFC3339 micro) -> aware datetime, or None."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def origin_leases():
    """Per-flow origin Leases, keyed by "<flowID>-<nodeName>".

    That is exactly the name LeaseName() builds, so a (flow, node) lookup is a
    dict hit with no parsing -- both halves contain dashes (UUID flow ids
    always, node names usually), so there is no safe way to split one back
    apart. Returns None when the Leases are unreadable (a cluster still on the
    RBAC without the coordination.k8s.io read) so the caller can fall back to
    the condition instead of declaring every flow stale.
    """
    res = safe_k8s(f"/apis/coordination.k8s.io/v1/namespaces/{LEASE_NS}/leases")
    if "_error" in res:
        return None
    now = datetime.now(timezone.utc)
    out = {}
    for ls in res.get("items", []):
        name = ls.get("metadata", {}).get("name") or ""
        if not name.startswith(LEASE_PREFIX):
            continue
        spec = ls.get("spec", {}) or {}
        renew = _renew_time(spec.get("renewTime"))
        if not renew:
            continue
        dur = spec.get("leaseDurationSeconds") or LEASE_SECONDS
        out[name[len(LEASE_PREFIX):]] = {
            "fresh": now < renew + timedelta(seconds=dur),
            "age": int((now - renew).total_seconds()),
        }
    return out


def origin_health(fl, leases):
    """Three-state origin health for one MxlFlow.

    True  -- a node claims Origin and holds a Lease inside its renewal window.
    False -- a node claims Origin but its Lease lapsed or never landed.
    None  -- nothing claims Origin (mirror-only, or not published yet), so
            there is nothing to be fresh about. Unknown, not broken.

    Gated on the Origin location first, exactly like the operator's
    resolveSourceNode, and the Lease is only consulted for the nodes that make
    that claim. A Lease on its own proves nothing about the origin: the agent's
    renew loop refreshes one for every flow directory on its disk, mirror
    copies included, so a mirror target holds a perfectly fresh Lease for a
    flow whose actual origin is long dead.
    """
    st = fl.get("status", {}) or {}
    uuid = fl.get("metadata", {}).get("name") or ""
    origins = [l.get("nodeName") for l in (st.get("locations") or [])
               if l.get("phase") == "Origin"]
    if not origins:
        return {"originFresh": None, "originReason": "NoOrigin",
                "originNode": None, "originAge": None}

    if leases is None:
        cond = {}
        for c in st.get("conditions") or []:
            if c.get("type") == "OriginFresh":
                cond = c
        return {
            "originFresh": (cond.get("status") == "True") if cond else None,
            "originReason": cond.get("reason") or "NoLeaseRead",
            "originNode": origins[0],
            "originAge": None,
        }

    held = [(n, leases.get(uuid + "-" + n)) for n in origins]
    dated = [(n, l) for n, l in held if l]
    fresh = [(n, l) for n, l in dated if l["fresh"]]
    if fresh:
        n, l = min(fresh, key=lambda x: x[1]["age"])
        return {"originFresh": True, "originReason": "LeaseRenewed",
                "originNode": n, "originAge": l["age"]}
    if dated:
        # The most recently renewed of the lapsed ones -- the origin that came
        # closest to still being good, and the useful age to show.
        n, l = min(dated, key=lambda x: x[1]["age"])
        return {"originFresh": False, "originReason": "LeaseExpired",
                "originNode": n, "originAge": l["age"]}
    # Claims Origin with no Lease at all: the agent that published it is gone
    # or never renewed. The same fault, just with nothing left to date it.
    return {"originFresh": False, "originReason": "NoOriginLease",
            "originNode": origins[0], "originAge": None}


def _age_secs(ts):
    """RFC3339 -> whole seconds since, or None. Tolerates the fractional form
    k8s writes on Lease renewTime as well as the plain one on conditions."""
    t = _renew_time(ts)
    return None if t is None else int((datetime.now(timezone.utc) - t).total_seconds())


def _conditions(obj):
    """Every status condition on a CR, flattened and ordered by type so the
    detail panel's rows don't reshuffle between polls."""
    out = [{"type": c.get("type"), "status": c.get("status"),
            "reason": c.get("reason"), "message": c.get("message"),
            "age": _age_secs(c.get("lastTransitionTime"))}
           for c in ((obj.get("status") or {}).get("conditions") or [])]
    out.sort(key=lambda c: c["type"] or "")
    return out


def flow_media(d):
    """Media facts off the flow definition -- whatever it carries.

    The v210 grain-size / RDMA-rate derivation is gated on the media type
    rather than applied to everything the inventory lists: the 48-pixel
    (128-byte) row stride is a v210 property, and quoting it for, say, an
    audio/float32 or a raw RGB flow would be a made-up number.
    """
    comps = d.get("components") or []
    out = {
        "mediaType": d.get("media_type"),
        "colorspace": d.get("colorspace"),
        "interlaceMode": d.get("interlace_mode"),
        # Video carries bit depth per component, audio at the top level.
        "bitDepth": comps[0].get("bit_depth") if comps else d.get("bit_depth"),
        "channels": d.get("channel_count"),
        "components": [f"{c.get('name')} {c.get('width')}×{c.get('height')}"
                       f" @{c.get('bit_depth')}b" for c in comps],
    }
    gr = d.get("grain_rate") or {}
    if gr.get("numerator"):
        num, den = gr["numerator"], (gr.get("denominator") or 1)
        out["grainRate"] = f"{num}/{den}"
        out["fps"] = round(num / den, 2)
    sr = d.get("sample_rate") or {}
    if sr.get("numerator"):
        out["sampleRate"] = \
            f"{sr['numerator'] / max(1, sr.get('denominator', 1)) / 1000:g} kHz"
    w, h = d.get("frame_width"), d.get("frame_height")
    if w and h:
        out["width"], out["height"] = w, h
        if (d.get("media_type") or "") == "video/v210":
            gbytes = (((w + 47) // 48) * 128) * h
            out["grainBytes"] = gbytes
            # Nominal, not observed -- see the note in build()'s media block.
            # There is no live per-flow throughput anywhere in the control
            # plane to report instead: mirrors expose lastGrainAt but no byte
            # counters, so "last grain" is the only live delivery signal a
            # non-compositor flow has.
            out["nominalMbps"] = round(
                gbytes * (out.get("fps") or GRAIN_RATE) * 8 / 1e6)
    return out


def flow_detail(fl, d, uuid, receivers, mirrors):
    """Everything the control plane knows about one flow, for the expandable
    row: the full definition, every condition (not just OriginFresh), and the
    receivers and mirrors wired to it -- including each mirror's Source/Target
    progress, which is where a stalled transfer actually shows up.
    """
    md = fl.get("metadata", {}) or {}
    recv = [{"name": r["metadata"]["name"],
             "namespace": r["metadata"].get("namespace"),
             "provider": (r.get("spec") or {}).get("provider"),
             "phase": (r.get("status") or {}).get("phase"),
             "pod": ((r.get("spec") or {}).get("podRef") or {}).get("name"),
             "boundMirror": ((r.get("status") or {}).get("boundMirror")
                             or {}).get("name")}
            for r in receivers if (r.get("spec") or {}).get("flowID") == uuid]

    mirs = []
    for m in mirrors:
        ms, mst = (m.get("spec") or {}), (m.get("status") or {})
        if ms.get("flowID") != uuid:
            continue
        mirs.append({
            "name": m["metadata"]["name"],
            "namespace": m["metadata"].get("namespace"),
            "sourceNode": ms.get("sourceNode"),
            "targetNode": ms.get("targetNode"),
            "provider": ms.get("provider"),
            "phase": mst.get("phase"),
            "attempts": mst.get("attemptCount"),
            # Empty string means "no error", which reads as a blank row.
            "lastError": mst.get("lastError") or None,
            "grainAge": _age_secs(mst.get("lastGrainAt")),
            "requestor": (ms.get("requestor") or {}).get("name"),
            "conditions": _conditions(m),
        })

    return {
        "created": md.get("creationTimestamp"),
        "createdAge": _age_secs(md.get("creationTimestamp")),
        "description": d.get("description"),
        "media": flow_media(d),
        "parents": d.get("parents") or [],
        "tags": d.get("tags") or {},
        "conditions": _conditions(fl),
        "receivers": recv,
        "mirrors": mirs,
    }


# -- Operator flow inventory -------------------------------------------------
# Every MXL flow the mxl-k8s operator knows about, straight from the (cluster-
# scoped) MxlFlow CRs -- not the hardcoded d4d writer set build() reports. The
# multiviewer's "operator flows" list renders this verbatim, so the demo shows
# whatever is actually registered on the cluster (ST 2110 gateway, tcp-demo,
# audio, ...), each with the media facts and origin health the operator tracks.
def operator_flows():
    items = safe_k8s(
        "/apis/mxl.qvest-digital.com/v1alpha1/mxlflows").get("items", [])
    leases = origin_leases()
    # All namespaces (no namespace segment): MxlFlow is cluster-scoped, so the
    # receivers and mirrors wired to one can live anywhere -- not only in this
    # aggregator's own namespace, which is all build() needs to look at.
    receivers = safe_k8s(
        "/apis/mxl.qvest-digital.com/v1alpha1/mxlreceivers").get("items", [])
    mirrors = safe_k8s(
        "/apis/mxl.qvest-digital.com/v1alpha1/mxlflowmirrors").get("items", [])
    out = []
    for fl in items:
        d = fl.get("spec", {}).get("definition", {}) or {}
        uuid = fl.get("metadata", {}).get("name") or fl.get("spec", {}).get("id")
        # urn:x-nmos:format:video -> "video"; keep raw if it isn't a URN.
        fmt = (d.get("format") or "").rsplit(":", 1)[-1] or None

        resolution = None
        if d.get("frame_width") and d.get("frame_height"):
            resolution = f"{d['frame_width']}x{d['frame_height']}"

        rate = None
        gr = d.get("grain_rate") or {}
        if gr.get("numerator"):
            rate = f"{gr['numerator']}/{gr.get('denominator', 1)}"
        sr = d.get("sample_rate") or {}
        if sr.get("numerator"):
            rate = f"{sr['numerator'] / max(1, sr.get('denominator', 1)) / 1000:g} kHz"

        origin = origin_health(fl, leases)
        locations = [
            {"node": l.get("nodeName"), "phase": l.get("phase"),
             "observedAge": _age_secs(l.get("lastObserved"))}
            for l in (fl.get("status", {}).get("locations") or [])
        ]

        grouphint = None
        gh = (d.get("tags") or {}).get("urn:x-nmos:tag:grouphint/v1.0")
        if isinstance(gh, list) and gh:
            grouphint = gh[0]

        row = {
            "id": uuid,
            "label": d.get("label") or uuid,
            "description": d.get("description"),
            "format": fmt,
            "mediaType": d.get("media_type"),
            "resolution": resolution,
            "rate": rate,
            "channels": d.get("channel_count"),
            "colorspace": d.get("colorspace"),
            "grouphint": grouphint,
            "locations": locations,
            "detail": flow_detail(fl, d, uuid, receivers, mirrors),
        }
        row.update(origin)
        out.append(row)
    # Stable order: group by media format, then by uuid.
    out.sort(key=lambda f: ((f["format"] or "~"), f["id"] or ""))
    return {"flows": out}


# -- Per-flow preview (mediamtx control API) ---------------------------------
# The operator-flows list can open a live preview of any flow: add a mediamtx
# path that reads the flow zero-copy from the local MXL domain, play its HLS,
# and delete the path on close so the reader doesn't linger. Only flows the
# operator actually knows about can be added -- we validate the uuid against the
# MxlFlow set first, and the flow must be node-local to mediamtx (its Service
# node) for the mxl source to open.
#
# Audio flows go the other way round. mediamtx's mxlSource refuses them
# ("flow <id> is not video (format=audio)"), so nothing can PULL an audio flow --
# instead the audio-preview container beside it (k8s/mediamtx-deployment.yaml)
# reads it via libmxl and PUSHES it over RTSP. mediamtx only has a publisher slot for a path that
# exists, and mediamtx.yml declares just a couple, so the path is created in
# publisher mode (empty config, no source) before the pod is asked to start.
#
# What it pushes is a stereo pair, whatever the flow's channel count: neither
# transport carries more, and a wider one fails to negotiate rather than
# degrading. Which pair is a parameter, so a 12-channel flow is audible two
# channels at a time, and /status carries a level for every channel so the
# caller can see the rest without listening to them.
#
# It pushes the same flow twice, into two paths: Opus for WHEP and AAC for HLS.
# Neither transport carries the other's codec -- WebRTC has no AAC, and the
# MPEG-TS HLS variant refuses Opus outright ("supports MPEG-4 Audio only") with
# a muxer that crashes on publish -- and the overlay needs both, since it tries
# WHEP first and falls back to HLS wherever ICE cannot complete.
# Both services are booked media functions now, so neither has a fixed Service
# name this aggregator can assume: mediamtx and the compositor are provisioned
# per production, in the namespace the MediaProduction owns, under whatever the
# claim is called. The address is published on the claim, so it is read from
# there rather than guessed. An explicit env var still wins, which is what a
# port-forwarded dev loop uses.
MEDIAMTX_API = os.environ.get("MEDIAMTX_API")
AUDIO_PREVIEW_API = os.environ.get("AUDIO_PREVIEW_API")
# Reader for ANC data flows. Nothing in the catalog provides one yet, so this
# stays unset on a stock install and data previews report that rather than fail.
ANC_PREVIEW_API = os.environ.get("ANC_PREVIEW_API")
MXL_DOMAIN = os.environ.get("MXL_DOMAIN", "/run/mxl/domain")

# Where the claims live, and what they are called. The names come from chart
# values; empty means "find the one claim of that class in the namespace",
# which is what a single-production install wants.
CLAIM_NS = os.environ.get("CLAIM_NS", WRITER_NS)
MEDIAMTX_CLAIM = os.environ.get("MEDIAMTX_CLAIM", "")
COMPOSITOR_CLAIM = os.environ.get("COMPOSITOR_CLAIM", "")

# The class a nameless claim is looked up by. A cluster may register a class
# under a different name than the catalog's default, so this follows the same
# value the claim was rendered from rather than assuming the two agree.
MEDIAMTX_CLASS = os.environ.get("MEDIAMTX_CLASS", "mediamtx")
COMPOSITOR_CLASS = os.environ.get("COMPOSITOR_CLASS", "compositor")

# A claim's address only changes when it is re-provisioned, so re-reading it per
# request would spend an API call on an answer that is almost always the same.
# Ten seconds is short enough that a re-provision is picked up within one
# player retry and long enough that four tiles starting at once cost one read.
_ENDPOINT_TTL = 10.0
_endpoint_cache = {}
_endpoint_lock = threading.Lock()

_CLAIMS_API = "/apis/dmf.qvest-digital.com/v1alpha1"
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# Which channel pair an audio preview should publish, 1-based, as the
# audio-preview control API takes it. Validated rather than forwarded blind:
# the value ends up in a query string built by hand.
_CHANNELS_RE = re.compile(r"^\d{1,3}(,\d{1,3})?$")

# ── Generators ──────────────────────────────────────────────────────────────
#
# The UI books writers by creating MediaFunctionClaims of GEN_CLASS. Off unless
# the chart says otherwise: nothing in front of this API authenticates, so the
# grant that makes it work is opt-in per install.
#
# Everything an operator submits is validated here rather than forwarded. The
# writer chart's prepareDomain init container runs
#     rm -rf "<domain>/<flow.video_output.id>"*
# as root, with the glob outside the quotes, so a flow id is a prefix pattern
# over the shared MXL domain: a truncated id matches several production flows
# and a borrowed one deletes that flow's grains. _UUID_RE's anchors stop the
# first, _flow_ids_in_use stops the second.
GEN_ENABLED = os.environ.get("GEN_ENABLED", "") == "true"
# From the environment, never from a request: create on claims means "install any
# chart in the catalog here", and the class is the only thing that decides which.
GEN_CLASS = os.environ.get("GEN_CLASS", "mxl-writer")
GEN_JOB_REF = os.environ.get("GEN_JOB_REF", "qutil/generators")
# Both halves of the ownership guard: page-created claims carry the label and the
# prefix, and delete refuses anything missing either.
GEN_PREFIX = os.environ.get("GEN_PREFIX", "generator-")
GEN_MANAGER = os.environ.get("GEN_MANAGER", "qutil-aggregator")
GEN_MAX = int(os.environ.get("GEN_MAX") or "8")
try:
    GEN_RESOURCES = json.loads(os.environ.get("GEN_RESOURCES") or "{}")
except ValueError:
    GEN_RESOURCES = {}

_GEN_LABEL_MANAGED = "app.kubernetes.io/managed-by"
_GEN_LABEL_COMPONENT = "app.kubernetes.io/component"
_GEN_COMPONENT = "generator"
_GEN_NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
_GEN_MAX_BODY = 8192
# videotestsrc patterns, passed to the writer as -p. An unknown one leaves the
# pod Ready and producing nothing, so the set is closed here.
_GEN_PATTERNS = ("smpte", "ball", "gamut", "checkers-8", "snow", "zone-plate")
# These regenerate every pixel of every frame where a still pattern repeats one,
# so they cost several times as much and the class README says the test source
# stalls on them at 1080p. Reported rather than refused: what a frame size costs
# depends on the node, and a booking that wants a moving picture at 1080p is the
# operator's call. The page says so beside the pattern.
_GEN_ANIMATED = ("ball", "snow", "zone-plate")
# Fixed sets rather than free numbers: v210 packs two pixels per group, so an odd
# width fails the function chart's own render, and a rate the source cannot hold
# is a writer that never reaches its grain rate.
_GEN_FRAME_SIZES = ((640, 360), (1296, 720), (1920, 1080))
_GEN_GRAIN_RATES = ((30000, 1001), (25, 1), (50, 1), (60000, 1001))
_GEN_SAMPLE_RATES = (44100, 48000, 96000)
_GEN_MAX_CHANNELS = 16
_GEN_MAX_OVERLAY = 32
# How long a booking may last. Nothing else prunes a claim created at runtime:
# helm prunes what its release owns and Flux what its source declares, so a
# closed browser tab would otherwise leave a writer running for good.
_GEN_TTLS = {"1h": 3600, "8h": 28800, "24h": 86400, "none": 0}
_GEN_NIL_UUID = "00000000-0000-0000-0000-000000000000"


def _http_json(base, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read().decode().strip()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            raw = e.read().decode()
        except Exception:
            raw = ""
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw[:200]}
    except Exception as e:
        # Unreachable service (not deployed, DNS, timeout): a status, not a
        # traceback, so the caller can report it as a failed preview rather than
        # a 500 on the whole endpoint.
        #
        # Name the backend. On its own, urlopen's text is
        # "<urlopen error [Errno -2] Name or service not known>", which says
        # nothing about which dependency is missing -- it reads like a browser or
        # frontend fault, and once cost real time to trace back to a Service
        # that had dropped out of the kustomization.
        return 503, {"error": f"{base} unreachable: {e}"}


def _claim_endpoint(claim_name, class_name, ep_name):
    """The URL a booked function publishes for one of its endpoints.

    The lifecycle plane renders a class's endpointTemplates once, at provision
    time, and the binder copies the result onto the claim as
    status.handle.endpoints. That is the only address a consumer is promised:
    the Service name is the claim's, in whatever namespace the production owns,
    so nothing here may assume either.

    handle.ready gates it. An endpoint published for a function whose workload
    is not up yet resolves to a Service with no backend, which fails as a
    connection timeout rather than as the "not ready yet" it actually is.
    """
    claim = None
    if claim_name:
        got = safe_k8s(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}"
                       f"/mediafunctionclaims/{claim_name}")
        if not got.get("_error"):
            claim = got
    else:
        # No name configured: a single-production install has exactly one claim
        # of each class, so the class is enough to find it. Two would be
        # ambiguous, and picking one at random would be worse than saying so.
        listing = safe_k8s(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}"
                           f"/mediafunctionclaims")
        matches = [c for c in listing.get("items", [])
                   if (c.get("spec") or {}).get("className") == class_name]
        if len(matches) == 1:
            claim = matches[0]
    if not claim:
        return None
    handle = (claim.get("status") or {}).get("handle") or {}
    if not handle.get("ready"):
        return None
    for ep in handle.get("endpoints") or []:
        if ep.get("name") == ep_name:
            return ep.get("url")
    return None


def _resolve_base(override, cache_key, claim_name, class_name, ep_name):
    if override:
        return override
    now = time.monotonic()
    with _endpoint_lock:
        hit = _endpoint_cache.get(cache_key)
        if hit and now - hit[0] < _ENDPOINT_TTL:
            return hit[1]
    url = _claim_endpoint(claim_name, class_name, ep_name)
    with _endpoint_lock:
        _endpoint_cache[cache_key] = (now, url)
    return url


def _mtx(path, method="GET", body=None):
    base = _resolve_base(MEDIAMTX_API, "mediamtx", MEDIAMTX_CLAIM,
                         MEDIAMTX_CLASS, "api")
    if not base:
        return 503, {"error": "no ready mediamtx claim in " + CLAIM_NS}
    return _http_json(base, path, method, body)


def _audio_preview(path, method="GET"):
    base = _resolve_base(AUDIO_PREVIEW_API, "audio-preview", COMPOSITOR_CLAIM,
                         COMPOSITOR_CLASS, "audio-preview")
    if not base:
        return 503, {"error": "no ready compositor claim in " + CLAIM_NS}
    return _http_json(base, path, method)


def _anc_preview(path, method="GET"):
    """The ANC reader, which decodes RFC-8331 grains into JSON.

    Env-only for now: no class in the catalog publishes an anc-preview endpoint,
    so there is no claim to resolve one from. Unset reads as not booked rather
    than as a broken lookup.
    """
    if not ANC_PREVIEW_API:
        return 503, {"error": "no ANC reader configured (ANC_PREVIEW_API)"}
    return _http_json(ANC_PREVIEW_API, path, method)


def _known_flow(uuid):
    for fl in safe_k8s(
            "/apis/mxl.qvest-digital.com/v1alpha1/mxlflows").get("items", []):
        if fl.get("metadata", {}).get("name") == uuid:
            return fl
    return None


_PREVIEW_PREFIX = "preview-"
_AUDIO_PREFIX = _PREVIEW_PREFIX + "audio-"
_HLS_SUFFIX = "-hls"

# When each preview path was last seen with nobody reading it.
#
# The multiviewer's tiles and the operator overlay can ask for the same flow at
# once and derive the same path name from the uuid, so a close must not drop
# the path out from under whoever else is still playing it. Counting holders
# here answered that but only while this process lived: a restart lost the
# counts, and the next close then tore down a path someone was watching, while
# a card that never closed (tab killed, pod evicted) held its path forever.
#
# mediamtx already knows who is reading. The one thing it cannot know is that a
# path was created moments ago for a browser that has not finished connecting,
# so a path goes only after it has had no readers for REAP_GRACE. That covers
# both windows with one rule: the ICE gathering and connect budget before the
# first reader attaches, and a reconnect after the last one leaves.
#
# The grace has to clear the client's own budget, which is 2.5 s of ICE
# gathering plus an 8 s connect timeout for WHEP, and a 4 s retry for HLS.
REAP_GRACE = 30.0
REAP_INTERVAL = 10.0

_idle_since = {}
_idle_lock = threading.Lock()


def _preview_track(*names):
    """Start the idle clock for paths just created, before anyone can read them."""
    now = time.monotonic()
    with _idle_lock:
        for name in names:
            _idle_since[name] = now


def _preview_delete(name):
    """Drop one preview path, stopping its publisher first where it has one."""
    if name.startswith(_AUDIO_PREFIX):
        # Audio is pushed in by a separate process. Stopping it before the path
        # goes lets its pipeline send EOS into a path that still exists.
        flow = name[len(_AUDIO_PREFIX):]
        if flow.endswith(_HLS_SUFFIX):
            flow = flow[:-len(_HLS_SUFFIX)]
        _audio_preview(f"/stop?flow={flow}", "DELETE")
    _mtx(f"/v3/config/paths/delete/{name}", "DELETE")


def _preview_reap_pass(now=None):
    """Delete preview paths that have had no readers for REAP_GRACE.

    Returns the names deleted. A path this process did not create starts its
    clock at the first pass that sees it idle rather than being reaped at once,
    so a restart costs a delay and never a live preview.
    """
    now = time.monotonic() if now is None else now
    code, res = _mtx("/v3/paths/list")
    if code != 200:
        return []

    reap = []
    for item in (res.get("items") or []):
        name = item.get("name") or ""
        if not name.startswith(_PREVIEW_PREFIX):
            continue
        if item.get("readers"):
            with _idle_lock:
                _idle_since[name] = None
            continue
        with _idle_lock:
            since = _idle_since.get(name)
            if since is None:
                _idle_since[name] = now
                continue
            if now - since <= REAP_GRACE:
                continue
        reap.append(name)

    for name in reap:
        _preview_delete(name)
        with _idle_lock:
            _idle_since.pop(name, None)
    return reap


def _preview_reaper():
    while True:
        time.sleep(REAP_INTERVAL)
        try:
            _preview_reap_pass()
        except Exception as e:
            print(f"preview reaper: {e}", flush=True)


def preview_add(uuid, owner="overlay", channels="", audio=""):
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    if channels and not _CHANNELS_RE.match(channels):
        return 400, {"error": "channels must be one or two 1-based numbers"}
    fl = _known_flow(uuid)
    if not fl:
        return 404, {"error": "flow not known to the operator"}
    d = fl.get("spec", {}).get("definition", {}) or {}
    fmt = (d.get("format") or "").rsplit(":", 1)[-1]
    if audio:
        return preview_add_joined(uuid, fmt, audio)
    if fmt == "audio":
        code, res = preview_add_audio(uuid, channels)
        if code == 200:
            _preview_track(*_audio_preview_paths(uuid))
        return code, res
    if fmt == "data":
        # No transport carries ANC to a browser, so a data preview is not a
        # player: the reader decodes grains and the card reads them from
        # /api/anc/<uuid>. Nothing is provisioned, so nothing is held either.
        media = (d.get("media_type") or "").lower()
        if media and media != "video/smpte291":
            return 415, {"error": f"data preview supports video/smpte291; this "
                                  f"one is {media}"}
        return 200, {"format": "data", "anc": f"/api/anc/{uuid}"}
    if fmt != "video":
        # Only video can be pulled by mediamtx and only audio has a publisher to
        # push it, so anything else has no route to a browser. Refuse before
        # creating a path: mediamtx's mxlSource would retry the open every 5s
        # forever, leaving a zombie path behind spamming the log while the card
        # sat on "buffering...".
        return 415, {"error": f"preview supports video, audio and ANC data "
                              f"flows; this one is {fmt or 'of unknown format'}"}
    name = _PREVIEW_PREFIX + uuid
    # Idempotent: reuse the path if the card was opened before.
    code, _ = _mtx(f"/v3/config/paths/get/{name}")
    if code != 200:
        # No IDR period: the media server derives one from the rate the flow
        # declares. A frame count stated here is right for one rate and wrong
        # for every other, and a GOP the length of hlsSegmentDuration lands on
        # the HLS muxer's own cut comparison, which is what makes segment
        # durations alternate between one and two of them.
        # On demand: the reader is what the encode is for, so a path with
        # nobody on it should not be running ffmpeg. Measured live, four of
        # seven preview paths were encoding for zero readers at about 1.4
        # cores each. It also removes the wait the card used to guess at, as
        # mediamtx holds a reader that arrives before the first frame instead
        # of refusing it.
        conf = {"source": f"mxl://{MXL_DOMAIN}/{uuid}", "sourceOnDemand": True,
                "sourceOnDemandCloseAfter": "10s",
                "mxlH264Preset": "veryfast", "mxlH264Profile": "high",
                "mxlH264Bitrate": 5000000}
        code, res = _mtx(f"/v3/config/paths/add/{name}", "POST", conf)
        if code != 200:
            return code, {"error": res.get("error") or "mediamtx add failed"}
    _preview_track(name)
    return 200, {"path": name, "hls": f"/hls/{name}/index.m3u8",
                 "whep": f"/webrtc/{name}/whep", "format": "video"}


def preview_add_joined(video_uuid, video_fmt, audio_uuid):
    """One path carrying a video flow and an audio flow together.

    Picture and sound are separate flows and nothing downstream rejoins them,
    so a card that wants both has to name both. The media server takes the
    audio as a query on the video's source and publishes the two as one path
    with two tracks, which is what lets a browser play them in step.

    The path name cannot carry a "+": the media server accepts only
    [0-9a-zA-Z_-/.] in one, so the two ids are joined with the same hyphen
    that already separates the prefix.
    """
    if not _UUID_RE.match(audio_uuid or ""):
        return 400, {"error": "bad audio flow id"}
    if audio_uuid == video_uuid:
        return 400, {"error": "a joined preview needs two different flows"}
    if video_fmt != "video":
        return 415, {"error": f"a joined preview needs a video flow; this one "
                              f"is {video_fmt or 'of unknown format'}"}

    afl = _known_flow(audio_uuid)
    if not afl:
        return 404, {"error": "audio flow not known to the operator"}
    ad = afl.get("spec", {}).get("definition", {}) or {}
    afmt = (ad.get("format") or "").rsplit(":", 1)[-1]
    if afmt != "audio":
        return 415, {"error": f"the second flow of a joined preview must be "
                              f"audio; this one is {afmt or 'of unknown format'}"}

    name = f"{_PREVIEW_PREFIX}{video_uuid}-{audio_uuid}"
    code, _ = _mtx(f"/v3/config/paths/get/{name}")
    if code != 200:
        conf = {"source": f"mxl://{MXL_DOMAIN}/{video_uuid}?audio={audio_uuid}",
                "sourceOnDemand": True, "sourceOnDemandCloseAfter": "10s",
                "mxlH264Preset": "veryfast", "mxlH264Profile": "high",
                "mxlH264Bitrate": 5000000}
        code, res = _mtx(f"/v3/config/paths/add/{name}", "POST", conf)
        if code != 200:
            return code, {"error": res.get("error") or "mediamtx add failed"}
    _preview_track(name)
    return 200, {"path": name, "hls": f"/hls/{name}/index.m3u8",
                 "whep": f"/webrtc/{name}/whep", "format": "video",
                 "audio": audio_uuid}


def _audio_preview_paths(uuid):
    """The pair of mediamtx paths one audio preview publishes into.

    Opus for WHEP and AAC for HLS, because neither transport can carry the
    other's codec: WebRTC has no AAC, and hlsVariant: mpegts refuses Opus ("the
    MPEG-TS variant of HLS supports MPEG-4 Audio only") -- its muxer crashes the
    moment such a path is published. The suffix must match kHlsPathSuffix in
    compositor/src/audio_preview.cpp; both sides derive the names rather than
    exchange them, because these paths have to exist before /start is called.
    """
    name = _AUDIO_PREFIX + uuid
    return name, name + _HLS_SUFFIX


def preview_add_audio(uuid, channels=""):
    """Create the publisher-mode paths, then ask audio-preview to push into them.

    `channels` is the 1-based pair to publish, which is all a browser can play
    however wide the flow is. Repeating this call with a different pair moves a
    running session rather than restarting it, so the paths already exist and
    the loop below is a no-op -- that is what makes switching pairs mid-listen
    cheap enough to drive from a button.
    """
    name, hls_name = _audio_preview_paths(uuid)
    added = []
    for path in (name, hls_name):
        code, _ = _mtx(f"/v3/config/paths/get/{path}")
        if code == 200:
            continue
        # Empty config == publisher mode: no source, mediamtx waits to be
        # published to. The video branch above is the opposite -- a source it
        # pulls from.
        code, res = _mtx(f"/v3/config/paths/add/{path}", "POST", {})
        if code != 200:
            # Both paths or neither: the pipeline has a sink for each and fails
            # as a whole if one has nowhere to publish.
            for done in added:
                _mtx(f"/v3/config/paths/delete/{done}", "DELETE")
            return code, {"error": res.get("error") or "mediamtx add failed"}
        added.append(path)
    query = f"/start?flow={uuid}"
    if channels:
        query += f"&channels={channels}"
    code, res = _audio_preview(query, "POST")
    if code != 200:
        # Don't leave orphan paths waiting for a publisher that never comes.
        for path in (name, hls_name):
            _mtx(f"/v3/config/paths/delete/{path}", "DELETE")
        return code, {"error": res.get("error") or "audio preview start failed"}
    # `path` is the Opus one: the overlay builds its WHEP URL from it, and only
    # the HLS fallback uses the AAC path.
    return 200, {"path": name, "hls": f"/hls/{hls_name}/index.m3u8",
                 "whep": f"/webrtc/{name}/whep", "format": "audio"}


def preview_status(uuid):
    """Whether an audio preview is actually producing, for the overlay to poll.

    /start only spawns the reader -- opening the flow can take seconds while the
    intent shim waits for the gateway to mirror it, and it can fail outright on
    a flow that is not readable on that node. Without somewhere to surface that,
    a failed session is a silently spinning overlay, which is the same fault as
    the zombie video path this endpoint pair already had.
    """
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    code, res = _audio_preview("/status")
    if code != 200:
        return code, {"error": res.get("error") or "audio preview unreachable"}
    for s in res.get("sessions", []):
        if s.get("flow") == uuid:
            return 200, s
    return 404, {"error": "no session for this flow"}


def anc_grain(uuid):
    """The latest RFC-8331 grain of an ANC flow, as the reader decodes it.

    Proxied rather than parsed here: reading a grain needs libmxl and the node's
    domain, which is a media function's job and not this aggregator's.
    """
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    return _anc_preview(f"/grain?flow={uuid}")


def preview_del(uuid, owner="overlay"):
    """Advisory: a card saying it has stopped playing.

    Nothing is torn down here. Whether a path is still wanted is answered by
    whether anything is reading it, which mediamtx knows and this process does
    not; the reaper drops it once it has been idle for REAP_GRACE. Deleting on
    this call is what used to drop a path out from under a second card on the
    same flow.

    `owner` is kept so the route's contract does not change. It no longer
    identifies anything, because holders are no longer counted.
    """
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    return 200, {"released": uuid}


# ── Generators: booking writers from the UI ─────────────────────────────────


def _gen_slug(label):
    """A DNS-1123 fragment from whatever the operator typed, or "" if nothing
    usable is left. Only the claim's name is built from this, so dropping a
    character is better than rejecting a label."""
    out = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-")
    return out[:20].strip("-")


def _gen_name(label, pattern):
    """generator-<slug>-<4 hex>. The suffix is what makes a second booking of the
    same label a different claim; the prefix is half the delete guard."""
    stem = _gen_slug(label) or _gen_slug(pattern) or "flow"
    return f"{GEN_PREFIX}{stem}-{secrets.token_hex(2)}"


def _claim_flow_ids(claim):
    """Every flow id a claim's parameters carry.

    A walk rather than the two keys this app writes: the writer takes
    video_output and audio_output, the SRT ingest adds anc_output, and a class
    this app has never heard of can name a fourth. Anything whose key ends
    _output and carries an id counts.
    """
    found = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key.endswith("_output") and isinstance(value, dict):
                    flow_id = value.get("id")
                    if isinstance(flow_id, str) and flow_id:
                        found.append(flow_id.lower())
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk((claim.get("spec") or {}).get("parameters") or {})
    return found


def _flow_ids_in_use():
    """{flow id: what holds it}, or ("", error) when the index cannot be read.

    Two sources, because a flow exists at two different times: an MxlFlow CR is
    a flow that exists now, whoever wrote it, and a claim's parameters are a flow
    that will exist once it provisions. Only the second catches writer-mxl-1..4
    and the SRT ingests before their pods have written anything.
    """
    used = {}
    flows = safe_k8s("/apis/mxl.qvest-digital.com/v1alpha1/mxlflows")
    if "_error" in flows:
        return None, f"cannot list MxlFlows: {flows['_error']}"
    for fl in flows.get("items", []) or []:
        name = (fl.get("metadata", {}) or {}).get("name")
        if name:
            used.setdefault(name.lower(), "a flow the operator already knows")

    claims = safe_k8s(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}/mediafunctionclaims")
    if "_error" in claims:
        return None, f"cannot list claims in {CLAIM_NS}: {claims['_error']}"
    for claim in claims.get("items", []) or []:
        name = (claim.get("metadata", {}) or {}).get("name", "?")
        for flow_id in _claim_flow_ids(claim):
            used.setdefault(flow_id, f"claim {name}")
    return used, None


def _gen_new_ids(used):
    """Two ids no flow and no claim holds. Minted here rather than in the browser:
    uniqueness can only be judged where the index is, and crypto.randomUUID is
    undefined outside a secure context, which this demo often is not."""
    out = []
    while len(out) < 2:
        candidate = str(uuid_mod.uuid4())
        if candidate in used or candidate in out or candidate == _GEN_NIL_UUID:
            continue
        out.append(candidate)
    return out


def _gen_int(node, key, default=None):
    value = node.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _validate_generator(req):
    """The first thing wrong with a submission, or None.

    Every message here is mirrored word for word in the UI's
    generator-validation.ts. This side is the authority; that side only spares
    the operator a round trip.
    """
    if not isinstance(req, dict):
        return "body must be a JSON object of at most 8 KiB"

    video = req.get("video") or {}
    audio = req.get("audio") or {}
    video_on = bool(video.get("enabled"))
    audio_on = bool(audio.get("enabled"))
    if not video_on and not audio_on:
        return "enable at least one of video or audio"

    if req.get("ttl", "1h") not in _GEN_TTLS:
        return "expiry must be one of " + ", ".join(_GEN_TTLS)

    for on, block, what in ((video_on, video, "video"), (audio_on, audio, "audio")):
        if not on:
            continue
        flow_id = (block.get("id") or "").strip()
        if not flow_id:
            return (f"a {what} flow id is required: a writer without one runs on the "
                    f"class default id, and two writers on one flow delete each "
                    f"other's grains")
        if not _UUID_RE.match(flow_id):
            return f"{what} flow id must be a full UUID, all 36 characters of it"
        if flow_id.lower() == _GEN_NIL_UUID:
            return f"{what} flow id must not be the nil UUID"
    if video_on and audio_on:
        if (video.get("id") or "").lower() == (audio.get("id") or "").lower():
            return "the video and audio flows need different ids"

    if video_on:
        if video.get("pattern") not in _GEN_PATTERNS:
            return "pattern must be one of " + ", ".join(_GEN_PATTERNS)
        width = _gen_int(video, "frameWidth")
        height = _gen_int(video, "frameHeight")
        if (width, height) not in _GEN_FRAME_SIZES:
            return "frame size must be one of " + ", ".join(
                f"{w}x{h}" for w, h in _GEN_FRAME_SIZES)
        rate = video.get("grainRate") or {}
        num = _gen_int(rate, "numerator")
        den = _gen_int(rate, "denominator")
        if (num, den) not in _GEN_GRAIN_RATES:
            return "grain rate must be one of " + ", ".join(
                f"{n}/{d}" for n, d in _GEN_GRAIN_RATES)
        overlay = video.get("overlayText") or ""
        if len(overlay) > _GEN_MAX_OVERLAY or not all(0x20 <= ord(c) < 0x7f for c in overlay):
            return f"overlay text must be at most {_GEN_MAX_OVERLAY} printable ASCII characters"

    if audio_on:
        if _gen_int(audio, "sampleRate") not in _GEN_SAMPLE_RATES:
            return "sample rate must be one of " + ", ".join(
                str(r) for r in _GEN_SAMPLE_RATES)
        channels = _gen_int(audio, "channelCount")
        if channels is None or not 1 <= channels <= _GEN_MAX_CHANNELS:
            return f"channel count must be between 1 and {_GEN_MAX_CHANNELS}"
    return None


def _gen_claim(name, req):
    """The claim to POST. Deliberately shaped like the blocks
    charts/qutil/templates/claims-writers.yaml renders, so the two can be read
    side by side -- spec.parameters is validated by nothing, and a mistyped key
    is accepted in silence."""
    video = req.get("video") or {}
    audio = req.get("audio") or {}
    flow = {"group_hint": name}

    if video.get("enabled"):
        rate = video.get("grainRate") or {}
        flow["video_output"] = {
            "enabled": True,
            "id": (video.get("id") or "").lower(),
            "flow_pattern": video["pattern"],
            "frame_width": video["frameWidth"],
            "frame_height": video["frameHeight"],
            "grain_rate": {"numerator": rate["numerator"], "denominator": rate["denominator"]},
        }
        if video.get("overlayText"):
            flow["video_output"]["overlay_text"] = video["overlayText"]
    else:
        # Written out rather than omitted: the class defaults video on, with an id
        # of its own, so an audio-only claim that leaves this out books a second
        # writer onto that shared id.
        flow["video_output"] = {"enabled": False}

    if audio.get("enabled"):
        flow["audio_output"] = {
            "enabled": True,
            "id": (audio.get("id") or "").lower(),
            "sample_rate": audio["sampleRate"],
            "channel_count": audio["channelCount"],
        }

    parameters = {"flow": flow}
    # The class envelope is sized for 1080p50, which reserves several times what a
    # test pattern at these sizes needs.
    if GEN_RESOURCES:
        parameters["resources"] = GEN_RESOURCES

    spec = {
        "className": GEN_CLASS,
        # Nothing re-applies a claim this page created, so there is no drift to
        # reprovision on -- and with it on, an edit would restart a writer while
        # something is reading its grains.
        "lifecycle": {"reprovisionOnDrift": False},
        "booking": {"jobRef": GEN_JOB_REF},
        "parameters": parameters,
    }
    seconds = _GEN_TTLS.get(req.get("ttl", "1h"), 3600)
    if seconds:
        end = datetime.now(timezone.utc) + timedelta(seconds=seconds)
        spec["booking"]["window"] = {"end": end.strftime("%Y-%m-%dT%H:%M:%SZ")}

    return {
        "apiVersion": "dmf.qvest-digital.com/v1alpha1",
        "kind": "MediaFunctionClaim",
        "metadata": {
            "name": name,
            "namespace": CLAIM_NS,
            # The chart's claims carry managed-by: Helm from qutil.labels, so
            # they can never match this selector. Reusing that helper here would
            # make a page claim look chart-owned and hand it to the delete path.
            "labels": {_GEN_LABEL_MANAGED: GEN_MANAGER, _GEN_LABEL_COMPONENT: _GEN_COMPONENT},
        },
        "spec": spec,
    }
    # No ownerReferences: the claim lives in the production namespace and this
    # Deployment does not, and the collector treats an owner in another namespace
    # as gone -- which would delete every generator behind our back.


def _is_generator(claim):
    labels = (claim.get("metadata", {}) or {}).get("labels") or {}
    return (labels.get(_GEN_LABEL_MANAGED) == GEN_MANAGER
            and labels.get(_GEN_LABEL_COMPONENT) == _GEN_COMPONENT)


def _gen_row(claim):
    meta = claim.get("metadata", {}) or {}
    status = claim.get("status", {}) or {}
    handle = status.get("handle") or {}
    flow = ((claim.get("spec") or {}).get("parameters") or {}).get("flow") or {}
    video = flow.get("video_output") or {}
    audio = flow.get("audio_output") or {}
    reachable = _cond(claim, "Reachable")

    def rate(block):
        gr = block.get("grain_rate") or {}
        num, den = gr.get("numerator"), gr.get("denominator")
        return f"{num}/{den}" if num and den else None

    return {
        "name": meta.get("name"),
        "namespace": meta.get("namespace"),
        "className": (claim.get("spec") or {}).get("className"),
        "phase": status.get("phase"),
        "ready": handle.get("ready"),
        # A claim being deleted keeps answering GETs until its finalizers run.
        "deleting": bool(meta.get("deletionTimestamp")),
        "reachable": {"status": reachable.get("status"), "reason": reachable.get("reason"),
                      "message": reachable.get("message")} if reachable else None,
        "expiresAt": ((claim.get("spec") or {}).get("booking") or {})
                     .get("window", {}).get("end"),
        "created": meta.get("creationTimestamp"),
        "ageSeconds": _age_secs(meta.get("creationTimestamp")),
        "groupHint": flow.get("group_hint"),
        "video": {"id": video.get("id"), "pattern": video.get("flow_pattern"),
                  "overlayText": video.get("overlay_text"),
                  "frameWidth": video.get("frame_width"),
                  "frameHeight": video.get("frame_height"),
                  "grainRate": rate(video)} if video.get("enabled") else None,
        "audio": {"id": audio.get("id"), "sampleRate": audio.get("sample_rate"),
                  "channelCount": audio.get("channel_count")} if audio.get("enabled") else None,
    }


def _gen_list():
    """Only the claims this page created. A label selector rather than a filter in
    here, so the chart's claims are never in this process's hands at all."""
    selector = urllib.parse.quote(
        f"{_GEN_LABEL_MANAGED}={GEN_MANAGER},{_GEN_LABEL_COMPONENT}={_GEN_COMPONENT}",
        safe="=,")
    res = safe_k8s(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}/mediafunctionclaims"
                   f"?labelSelector={selector}")
    if "_error" in res:
        return None, res["_error"]
    rows = [_gen_row(c) for c in res.get("items", []) or []]
    # Newest first, so a just-booked generator is at the top of the list it
    # appears in.
    rows.sort(key=lambda r: (r["created"] or "", r["name"] or ""), reverse=True)
    return rows, None


def generators():
    rows, err = _gen_list() if GEN_ENABLED else ([], None)
    return {"namespace": CLAIM_NS, "className": GEN_CLASS, "enabled": GEN_ENABLED,
            "max": GEN_MAX, "ttls": [t for t in _GEN_TTLS],
            "patterns": list(_GEN_PATTERNS), "animated": list(_GEN_ANIMATED),
            "frameSizes": [{"width": w, "height": h} for w, h in _GEN_FRAME_SIZES],
            "grainRates": [{"numerator": n, "denominator": d} for n, d in _GEN_GRAIN_RATES],
            "sampleRates": list(_GEN_SAMPLE_RATES),
            "generators": rows or [], "error": err}


def generator_flow_ids():
    if not GEN_ENABLED:
        return 403, {"error": "generator booking is disabled on this install"}
    used, err = _flow_ids_in_use()
    if err:
        return 503, {"error": f"cannot check flow-id uniqueness: {err}"}
    video_id, audio_id = _gen_new_ids(used)
    return 200, {"videoFlowId": video_id, "audioFlowId": audio_id}


def generator_create(req):
    if not GEN_ENABLED:
        return 403, {"error": "generator booking is disabled on this install"}
    bad = _validate_generator(req)
    if bad:
        return 400, {"error": bad}

    rows, err = _gen_list()
    if err:
        return 503, {"error": f"cannot list generators in {CLAIM_NS}: {err}"}
    if len(rows) >= GEN_MAX:
        return 409, {"error": f"at most {GEN_MAX} generators at once; delete one first"}

    # Fail closed: booking a writer whose id might already be written is the one
    # mistake here that destroys somebody else's grains.
    used, err = _flow_ids_in_use()
    if err:
        return 503, {"error": f"cannot check flow-id uniqueness: {err}"}
    for block in (req.get("video") or {}, req.get("audio") or {}):
        if not block.get("enabled"):
            continue
        flow_id = (block.get("id") or "").lower()
        if flow_id in used:
            return 409, {"error": f"flow id {flow_id} is already in use by {used[flow_id]}"}

    label = req.get("label") or ""
    pattern = (req.get("video") or {}).get("pattern") or ""
    for attempt in (1, 2):
        name = _gen_name(label, pattern)
        if not _GEN_NAME_RE.match(name) or len(name) > 63:
            return 400, {"error": "that label does not make a usable claim name"}
        code, res = k8s_json(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}/mediafunctionclaims",
                             "POST", _gen_claim(name, req))
        if code in (200, 201):
            return 201, _gen_row(res)
        # A fresh suffix is the whole fix for a name that is taken; anything else
        # is the operator's to see.
        if res.get("reason") != "AlreadyExists" or attempt == 2:
            if code == 403:
                return 403, {"error": f"not allowed to create claims in {CLAIM_NS}"}
            return code, {"error": res.get("error") or "claim create failed"}
    return 409, {"error": "could not find a free claim name"}


def generator_delete(name):
    if not GEN_ENABLED:
        return 403, {"error": "generator booking is disabled on this install"}
    if not name or not _GEN_NAME_RE.match(name) or not name.startswith(GEN_PREFIX):
        return 400, {"error": "not a generator name"}

    # Read before deleting: a label selector bounds a list, it does not bound a
    # delete by name. This is what keeps writer-mxl-1 and mediamtx out of reach.
    claim = safe_k8s(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}/mediafunctionclaims/{name}")
    if "_error" in claim:
        return 404, {"error": f"no generator named {name}"}
    if not _is_generator(claim):
        return 403, {"error": f"{name} was not booked from this page"}

    code, res = k8s_json(f"{_CLAIMS_API}/namespaces/{CLAIM_NS}/mediafunctionclaims/{name}",
                         "DELETE")
    if code not in (200, 202):
        return code, {"error": res.get("error") or "claim delete failed"}

    # A mediamtx path left pointing at a flow that is going away retries the open
    # every 5s for as long as the server lives.
    for flow_id in _claim_flow_ids(claim):
        for path in _audio_preview_paths(flow_id):
            _preview_delete(path)
        _preview_delete(_PREVIEW_PREFIX + flow_id)
        with _idle_lock:
            for path in _audio_preview_paths(flow_id):
                _idle_since.pop(path, None)
            _idle_since.pop(_PREVIEW_PREFIX + flow_id, None)
    return 200, {"deleted": name}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _preview_args(self):
        """(uuid, owner, channels, audio) from
        /api/preview/<uuid>[?owner=<token>][&channels=<l>[,<r>]][&audio=<uuid>].

        owner names who is asking. It no longer decides when a path goes,
        which the media server's own reader count does, and is kept so the
        route's contract does not change. channels applies to audio only and
        is empty when the caller does not care which pair it gets. audio names
        the sound to carry alongside a video flow, and turns the request into
        one path with both tracks on it.
        """
        parts = urllib.parse.urlsplit(self.path)
        uuid = parts.path.rstrip("/").rsplit("/", 1)[1]
        query = urllib.parse.parse_qs(parts.query)
        owner = query.get("owner", ["overlay"])[0]
        channels = query.get("channels", [""])[0]
        audio = query.get("audio", [""])[0]
        return uuid, owner, channels, audio

    def _json_body(self):
        """The request's JSON object, or None.

        The first body this handler has ever read: the preview endpoints carry
        their input in the query string, which a form of a dozen fields cannot.
        Bounded, because an unbounded read is a way to spend the pod's memory.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > _GEN_MAX_BODY:
            return None
        try:
            obj = json.loads(self.rfile.read(length).decode())
        except Exception:
            return None
        return obj if isinstance(obj, dict) else None

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/api/booking"):
            try:
                self._send(200, booking())
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif self.path.startswith("/api/operator-flows"):
            try:
                self._send(200, operator_flows())
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif self.path.startswith("/api/generators/flow-ids"):
            # Before the collection branch: the collection prefix would swallow it.
            try:
                code, res = generator_flow_ids()
            except Exception as e:
                code, res = 500, {"error": str(e)}
            self._send(code, res)
        elif self.path.startswith("/api/generators"):
            try:
                self._send(200, generators())
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif self.path.startswith("/api/anc/"):
            # The latest decoded ANC grain of a data flow. Polled, because a
            # data preview is a look at what a grain currently carries rather
            # than a stream something plays.
            uuid, _, _, _ = self._preview_args()
            try:
                code, res = anc_grain(uuid)
            except Exception as e:
                code, res = 500, {"error": str(e)}
            self._send(code, res)
        elif self.path.startswith("/api/preview/"):
            # GET on the same collection POST/DELETE use: is this audio preview
            # actually producing yet, or did its reader fail to open?
            uuid, _, _, _ = self._preview_args()
            try:
                code, res = preview_status(uuid)
            except Exception as e:
                code, res = 500, {"error": str(e)}
            self._send(code, res)
        elif self.path.startswith("/api/flows"):
            try:
                self._send(200, build())
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif self.path in ("/healthz", "/api/healthz"):
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_DELETE(self):
        if self.path.startswith("/api/preview/"):
            uuid, owner, _, _ = self._preview_args()
            code, res = preview_del(uuid, owner)
            return self._send(code, res)
        if self.path.startswith("/api/generators/"):
            name = urllib.parse.unquote(
                urllib.parse.urlsplit(self.path).path.rstrip("/").rsplit("/", 1)[1])
            try:
                code, res = generator_delete(name)
            except Exception as e:
                code, res = 500, {"error": str(e)}
            return self._send(code, res)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path.rstrip("/") == "/api/generators":
            # Only the collection: a POST to a named generator is not an edit,
            # and a claim's parameters are consumed at provision time anyway.
            body = self._json_body()
            if body is None:
                return self._send(400, {"error": "body must be a JSON object of at most 8 KiB"})
            try:
                code, res = generator_create(body)
            except Exception as e:
                code, res = 500, {"error": str(e)}
            return self._send(code, res)
        if self.path.startswith("/api/preview/"):
            uuid, owner, channels, audio = self._preview_args()
            try:
                code, res = preview_add(uuid, owner, channels, audio)
            except Exception as e:
                code, res = 500, {"error": str(e)}
            return self._send(code, res)
        if self.path.startswith("/api/kill/"):
            try:
                n = int(self.path.rsplit("/", 1)[1])
            except Exception:
                return self._send(400, {"error": "bad flow index"})
            if n < 1 or n > N_FLOWS:
                return self._send(400, {"error": "flow out of range"})
            app = f"writer-mxl-{n}"
            killed = []
            sel = f"app.kubernetes.io/instance={app}"
            found = safe_k8s(f"/api/v1/namespaces/{WRITER_NS}/pods?labelSelector={sel}").get("items", [])
            if not found:
                found = safe_k8s(f"/api/v1/namespaces/{WRITER_NS}/pods?labelSelector=app={app}").get("items", [])
            for p in found:
                name = p["metadata"]["name"]
                try:
                    k8s(f"/api/v1/namespaces/{WRITER_NS}/pods/{name}", method="DELETE")
                    killed.append(name)
                except Exception as e:
                    return self._send(500, {"error": f"delete {name}: {e}"})
            self._send(200, {"killed": killed, "flow": n})
        else:
            self._send(404, {"error": "not found"})


if __name__ == "__main__":
    threading.Thread(target=_preview_reaper, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8088), H).serve_forever()
