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
#   GET  /api/flows      -> combined JSON
#   POST /api/kill/<n>   -> delete the writer-mxl-<n> pod (watch it recover)
#
# Runs in-cluster with a scoped ServiceAccount; talks to the API server with
# the mounted SA token + CA. No pip deps so it runs on stock python:3-slim.
import base64, json, os, re, ssl, threading, time, urllib.parse, urllib.request, urllib.error
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
# grain counters. The compositor does measure though — it opens its own reader
# on all four flows for the mosaic — so the panel reports its counters and says
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
with open(SA + "/token") as f:
    TOKEN = f.read().strip()
CTX = ssl.create_default_context(cafile=SA + "/ca.crt")


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
    # it has to be listed at the non-namespaced path — the namespaced URL
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
                    # time. Nothing on the fabric is measured here — the mirror
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
        # — placement is dynamic, so which flow is local varies). Requiring a
        # mirror unconditionally made the local flow show as down.
        live = writer_ok and origin_ok and (mirror_ok or not mlist)

        # Delivery numbers: measured from the compositor's own readers when it
        # is reachable and reading this flow, nominal otherwise. "measured"
        # tells the panel which it got — a derived number that cannot move is
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


# ── Booking lifecycle ───────────────────────────────────────────────────────
# The MediaOps booking deploys a per-booking txDarwin instance: a
# MediaFunctionInstance CR, from which the DMF operator renders a HelmRelease,
# which Flux turns into a pod. The showcase screen needs all three, plus the
# instance's *wired* sources — that is what tells template-1 (2 sources) from
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
    chart-default credentials, short timeout — a slow or absent instance must
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


# ── Origin freshness ────────────────────────────────────────────────────────
# status.conditions[OriginFresh] is NOT a per-flow health field: the operator
# stamps it only while reconciling an MxlReceiver that names the flow (and only
# when it has an opinion — "no origin yet" is deliberately left unwritten). So
# every flow nobody receives cross-node — the ST 2110 gateway flows, tcp-demo,
# the booking flows — carries no condition at all, and reading its absence as
# "not fresh" painted a red dot on perfectly healthy flows.
#
# Derive it the way the operator's own resolveSourceNode does instead, from two
# things that exist for every flow: status.locations[].phase == Origin says who
# claims to hold the authoritative copy, and the Lease
# mxl-flow-<flowID>-<node> in mxl-system says whether that node's agent is
# still alive (renewed every ~10s, 30s duration, released when the flow
# vanishes). The Lease filters the claim — it never replaces it, because the
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
    dict hit with no parsing — both halves contain dashes (UUID flow ids
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

    True  — a node claims Origin and holds a Lease inside its renewal window.
    False — a node claims Origin but its Lease lapsed or never landed.
    None  — nothing claims Origin (mirror-only, or not published yet), so
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
        # The most recently renewed of the lapsed ones — the origin that came
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
    """Media facts off the flow definition — whatever it carries.

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
            # Nominal, not observed — see the note in build()'s media block.
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
    receivers and mirrors wired to it — including each mirror's Source/Target
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


# ── Operator flow inventory ─────────────────────────────────────────────────
# Every MXL flow the mxl-k8s operator knows about, straight from the (cluster-
# scoped) MxlFlow CRs — not the hardcoded d4d writer set build() reports. The
# multiviewer's "operator flows" list renders this verbatim, so the demo shows
# whatever is actually registered on the cluster (ST 2110 gateway, tcp-demo,
# audio, ...), each with the media facts and origin health the operator tracks.
def operator_flows():
    items = safe_k8s(
        "/apis/mxl.qvest-digital.com/v1alpha1/mxlflows").get("items", [])
    leases = origin_leases()
    # All namespaces (no namespace segment): MxlFlow is cluster-scoped, so the
    # receivers and mirrors wired to one can live anywhere — not only in this
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


# ── Per-flow preview (mediamtx control API) ─────────────────────────────────
# The operator-flows list can open a live preview of any flow: add a mediamtx
# path that reads the flow zero-copy from the local MXL domain, play its HLS,
# and delete the path on close so the reader doesn't linger. Only flows the
# operator actually knows about can be added — we validate the uuid against the
# MxlFlow set first, and the flow must be node-local to mediamtx (its Service
# node) for the mxl source to open.
#
# Audio flows go the other way round. mediamtx's mxlSource refuses them
# ("flow <id> is not video (format=audio)"), so nothing can PULL an audio flow —
# instead the audio-preview container beside it (k8s/mediamtx-deployment.yaml)
# reads it via libmxl and PUSHES it over RTSP. mediamtx only has a publisher slot for a path that
# exists, and mediamtx.yml declares just a couple, so the path is created in
# publisher mode (empty config, no source) before the pod is asked to start.
#
# It pushes the same flow twice, into two paths: Opus for WHEP and AAC for HLS.
# Neither transport carries the other's codec — WebRTC has no AAC, and the
# MPEG-TS HLS variant refuses Opus outright ("supports MPEG-4 Audio only") with
# a muxer that crashes on publish — and the overlay needs both, since it tries
# WHEP first and falls back to HLS wherever ICE cannot complete.
# Both services are booked media functions now, so neither has a fixed Service
# name this aggregator can assume: mediamtx and the compositor are provisioned
# per production, in the namespace the MediaProduction owns, under whatever the
# claim is called. The address is published on the claim, so it is read from
# there rather than guessed. An explicit env var still wins, which is what a
# port-forwarded dev loop uses.
MEDIAMTX_API = os.environ.get("MEDIAMTX_API")
AUDIO_PREVIEW_API = os.environ.get("AUDIO_PREVIEW_API")
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
        # nothing about which dependency is missing — it reads like a browser or
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


def _known_flow(uuid):
    for fl in safe_k8s(
            "/apis/mxl.qvest-digital.com/v1alpha1/mxlflows").get("items", []):
        if fl.get("metadata", {}).get("name") == uuid:
            return fl
    return None


# Who is holding a preview open. The multiviewer's four tiles and the operator
# overlay can ask for the same flow at once, and both derive the same path name
# from the uuid, so an unconditional delete on close would drop the path out
# from under whoever else is still playing it. Holders are counted per flow and
# the path only goes when the last one lets go.
_holders = {}
_holders_lock = threading.Lock()


def _hold(uuid, owner):
    with _holders_lock:
        _holders.setdefault(uuid, set()).add(owner)


def _release(uuid, owner):
    """Drop one holder. True when that was the last one."""
    with _holders_lock:
        owners = _holders.get(uuid)
        if owners is None:
            # Nothing recorded: a delete for a preview this process did not
            # start, which is what a restarted aggregator sees. Tear it down.
            return True
        owners.discard(owner)
        if owners:
            return False
        _holders.pop(uuid, None)
        return True


def preview_add(uuid, owner="overlay"):
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    fl = _known_flow(uuid)
    if not fl:
        return 404, {"error": "flow not known to the operator"}
    d = fl.get("spec", {}).get("definition", {}) or {}
    fmt = (d.get("format") or "").rsplit(":", 1)[-1]
    if fmt == "audio":
        code, res = preview_add_audio(uuid)
        if code == 200:
            _hold(uuid, owner)
        return code, res
    if fmt != "video":
        # Only video can be pulled by mediamtx and only audio has a publisher to
        # push it, so anything else (data/smpte291) has no route to a browser.
        # Refuse before creating a path: mediamtx's mxlSource would retry the
        # open every 5s forever, leaving a zombie path behind spamming the log
        # while the overlay sat on "buffering…".
        return 415, {"error": f"preview supports video and audio flows; this "
                              f"one is {fmt or 'of unknown format'}"}
    name = "preview-" + uuid
    # Idempotent: reuse the path if the card was opened before.
    code, _ = _mtx(f"/v3/config/paths/get/{name}")
    if code != 200:
        conf = {"source": f"mxl://{MXL_DOMAIN}/{uuid}", "sourceOnDemand": False,
                "mxlH264Preset": "veryfast", "mxlH264Profile": "high",
                "mxlH264Bitrate": 5000000,
                # Force a keyframe every second so the HLS segmenter always has
                # a cut point. High-complexity content (noise, gamut sweeps,
                # dense checkerboards) otherwise defers IDRs far enough that the
                # muxer cannot form a segment and index.m3u8 answers HTTP 500.
                # Low-motion patterns emit IDRs often enough to hide it, which
                # is why this only shows on some flows.
                "mxlH264IDRPeriod": 30}
        code, res = _mtx(f"/v3/config/paths/add/{name}", "POST", conf)
        if code != 200:
            return code, {"error": res.get("error") or "mediamtx add failed"}
    _hold(uuid, owner)
    return 200, {"path": name, "hls": f"/hls/{name}/index.m3u8",
                 "whep": f"/webrtc/{name}/whep", "format": "video"}


def _audio_preview_paths(uuid):
    """The pair of mediamtx paths one audio preview publishes into.

    Opus for WHEP and AAC for HLS, because neither transport can carry the
    other's codec: WebRTC has no AAC, and hlsVariant: mpegts refuses Opus ("the
    MPEG-TS variant of HLS supports MPEG-4 Audio only") — its muxer crashes the
    moment such a path is published. The suffix must match kHlsPathSuffix in
    compositor/src/audio_preview.cpp; both sides derive the names rather than
    exchange them, because these paths have to exist before /start is called.
    """
    name = "preview-audio-" + uuid
    return name, name + "-hls"


def preview_add_audio(uuid):
    """Create the publisher-mode paths, then ask audio-preview to push into them."""
    name, hls_name = _audio_preview_paths(uuid)
    added = []
    for path in (name, hls_name):
        code, _ = _mtx(f"/v3/config/paths/get/{path}")
        if code == 200:
            continue
        # Empty config == publisher mode: no source, mediamtx waits to be
        # published to. The video branch above is the opposite — a source it
        # pulls from.
        code, res = _mtx(f"/v3/config/paths/add/{path}", "POST", {})
        if code != 200:
            # Both paths or neither: the pipeline has a sink for each and fails
            # as a whole if one has nowhere to publish.
            for done in added:
                _mtx(f"/v3/config/paths/delete/{done}", "DELETE")
            return code, {"error": res.get("error") or "mediamtx add failed"}
        added.append(path)
    code, res = _audio_preview(f"/start?flow={uuid}", "POST")
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

    /start only spawns the reader — opening the flow can take seconds while the
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


def preview_del(uuid, owner="overlay"):
    if not _UUID_RE.match(uuid or ""):
        return 400, {"error": "bad flow id"}
    if not _release(uuid, owner):
        # Somebody else is still playing this flow. Reporting the release as
        # done is honest: this holder is gone, and the path staying up is the
        # point of counting them.
        return 200, {"released": uuid}
    # Stop the publisher before dropping its path, so the pipeline sends EOS into
    # a path that still exists. Both variants are attempted rather than looking
    # the flow's format up again: the flow may have been deleted while the
    # overlay was open, and whichever call does not apply is a harmless 404.
    _audio_preview(f"/stop?flow={uuid}", "DELETE")
    # Audio leaves two paths behind (Opus for WHEP, AAC for HLS); missing one
    # would leave a publisher-mode path lingering with no publisher.
    for path in _audio_preview_paths(uuid):
        _mtx(f"/v3/config/paths/delete/{path}", "DELETE")
    _mtx(f"/v3/config/paths/delete/preview-{uuid}", "DELETE")
    return 200, {"stopped": uuid}


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
        """(uuid, owner) from /api/preview/<uuid>[?owner=<token>].

        The owner names who is asking, so the four tiles and the operator
        overlay can hold the same flow open without either one's close
        dropping the path the other is playing.
        """
        parts = urllib.parse.urlsplit(self.path)
        uuid = parts.path.rstrip("/").rsplit("/", 1)[1]
        owner = urllib.parse.parse_qs(parts.query).get("owner", ["overlay"])[0]
        return uuid, owner

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
        elif self.path.startswith("/api/preview/"):
            # GET on the same collection POST/DELETE use: is this audio preview
            # actually producing yet, or did its reader fail to open?
            uuid, _ = self._preview_args()
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
            uuid, owner = self._preview_args()
            code, res = preview_del(uuid, owner)
            return self._send(code, res)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/api/preview/"):
            uuid, owner = self._preview_args()
            try:
                code, res = preview_add(uuid, owner)
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
    ThreadingHTTPServer(("0.0.0.0", 8088), H).serve_forever()
