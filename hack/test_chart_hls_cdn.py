"""The proxy and the media server have to agree on the CDN token.

Without one, the media server hands every HLS reader a per-client session and
answers the second playlist of the stream with 401 unless two Secure,
SameSite=None, Partitioned cookies come back. The session is per-process and
matched on the client IP, which behind this proxy is the proxy's own, so no
browser and no second replica can recover from that.

Three things have to line up for the token to work, in three different
namespaces and two charts, and none of them fails loudly when they do not: the
proxy would simply go back to being answered with 401s.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/qutil"
BASE = {
    "production": {"namespace": "p-demo"},
    "ingress": {"hostname": "demo.example"},
}


def render(**overrides):
    values = {**BASE, **overrides}
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as fh:
        yaml.safe_dump(values, fh)
        fh.flush()
        proc = subprocess.run(
            ["helm", "template", "qutil", str(CHART),
             "--namespace", "demo-app", "-f", fh.name],
            capture_output=True, text=True, check=True,
        )
    return [d for d in yaml.safe_load_all(proc.stdout) if d]


def by_kind(docs, kind, name=None):
    out = [d for d in docs if d["kind"] == kind]
    if name is not None:
        out = [d for d in out if d["metadata"]["name"] == name]
    return out


class HLSCDNTokenTest(unittest.TestCase):
    def setUp(self):
        self.docs = render()

    def test_the_same_token_reaches_both_namespaces(self):
        """The proxy runs in this release's namespace and the media server in
        the production namespace. Two different values authenticate nothing."""
        secrets = by_kind(self.docs, "Secret", "mediamtx-hls-cdn")
        namespaces = sorted(s["metadata"]["namespace"] for s in secrets)
        self.assertEqual(namespaces, ["demo-app", "p-demo"])

        values = {list(s["stringData"].values())[0] for s in secrets}
        self.assertEqual(len(values), 1, "the two copies carry different tokens")
        self.assertGreaterEqual(len(values.pop()), 32)

    def test_the_proxy_reads_it_from_the_secret_and_not_the_config(self):
        """A token in the ConfigMap is a token in `kubectl get cm -o yaml`,
        and it skips authentication on every path the server carries."""
        ui = by_kind(self.docs, "Deployment", "qutil-ui")[0]
        container = ui["spec"]["template"]["spec"]["containers"][0]
        env = {e["name"]: e for e in container.get("env") or []}
        self.assertIn("MTX_HLS_CDN_SECRET", env)
        self.assertNotIn("value", env["MTX_HLS_CDN_SECRET"])
        self.assertEqual(
            env["MTX_HLS_CDN_SECRET"]["valueFrom"]["secretKeyRef"],
            {"name": "mediamtx-hls-cdn", "key": "secret"})

        cm = by_kind(self.docs, "ConfigMap", "qutil-ui")[0]
        self.assertNotIn("Bearer eyJ", cm["data"]["Caddyfile"])
        self.assertIn('header_up Authorization "Bearer {$MTX_HLS_CDN_SECRET}"',
                      cm["data"]["Caddyfile"])

    def test_the_booking_names_the_secret_rather_than_the_value(self):
        claim = by_kind(self.docs, "MediaFunctionClaim", "mediamtx")[0]
        self.assertEqual(
            claim["spec"]["parameters"]["hlsCDNSecret"],
            {"secretName": "mediamtx-hls-cdn", "key": "secret"})
        token = list(
            by_kind(self.docs, "Secret", "mediamtx-hls-cdn")[0]["stringData"]
            .values())[0]
        self.assertNotIn(token, json.dumps(claim["spec"]["parameters"]),
                         "the token itself reached the claim")

    def test_only_the_hls_route_presents_it(self):
        """WHEP needs no token: its session is a URL the client is handed
        back, not a cookie. Sending it there would widen the bypass for
        nothing."""
        cm = by_kind(self.docs, "ConfigMap", "qutil-ui")[0]
        caddyfile = cm["data"]["Caddyfile"]
        webrtc = caddyfile[caddyfile.index("handle_path /webrtc/*"):]
        self.assertNotIn("MTX_HLS_CDN_SECRET", webrtc)

    def test_turning_it_off_removes_all_three(self):
        """A cluster whose proxy is not this chart's has no business making
        the server skip authentication."""
        docs = render(mediamtx={"cdn": {"enabled": False}})
        self.assertEqual(by_kind(docs, "Secret", "mediamtx-hls-cdn"), [])

        ui = by_kind(docs, "Deployment", "qutil-ui")[0]
        container = ui["spec"]["template"]["spec"]["containers"][0]
        self.assertNotIn(
            "MTX_HLS_CDN_SECRET",
            [e["name"] for e in container.get("env") or []])

        cm = by_kind(docs, "ConfigMap", "qutil-ui")[0]
        self.assertNotIn("Authorization", cm["data"]["Caddyfile"])

        claim = by_kind(docs, "MediaFunctionClaim", "mediamtx")[0]
        self.assertNotIn("hlsCDNSecret", claim["spec"]["parameters"])


if __name__ == "__main__":
    unittest.main()
