"""preview.domains reaches the three places that have to agree on it.

A flow in an MxlDomain other than the primary one previews only if the media
server and the ANC reader mount that domain, and the aggregator configures a
path for it only if it knows they do. One value feeds all three; a mount the
aggregator does not know about leaves the button off, and an aggregator that
believes in a mount that is not there configures a path that never opens.
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/qutil"
BASE = {
    "production": {"namespace": "p-demo"},
    "ingress": {"hostname": "demo.example"},
    "ancReader": {"enabled": True},
}


def render(check=True, **overrides):
    values = {**BASE, **overrides}
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as fh:
        yaml.safe_dump(values, fh)
        fh.flush()
        return subprocess.run(
            ["helm", "template", "qutil", str(CHART),
             "--namespace", "demo-app", "-f", fh.name],
            capture_output=True, text=True, check=check,
        )


def docs(proc):
    return [d for d in yaml.safe_load_all(proc.stdout) if d]


def claim(documents, name):
    (c,) = [d for d in documents
            if d["kind"] == "MediaFunctionClaim" and d["metadata"]["name"] == name]
    return c


def aggregator_env(documents):
    for d in documents:
        if d["kind"] != "Deployment":
            continue
        for c in d["spec"]["template"]["spec"]["containers"]:
            env = {e["name"]: e.get("value") for e in c.get("env") or []}
            if "MEDIAMTX_CLAIM" in env:
                return env
    raise AssertionError("no aggregator container")


class PreviewDomains(unittest.TestCase):
    def test_one_value_feeds_both_mounts_and_the_aggregator(self):
        documents = docs(render(preview={"domains": ["studio-x", "studio-y"]}))
        for name in ("mediamtx", "anc-reader"):
            self.assertEqual(claim(documents, name)["spec"]["parameters"]["mxl"],
                             {"csi": {"extraDomains": ["studio-x", "studio-y"]}}, name)
        self.assertEqual(aggregator_env(documents)["PREVIEW_DOMAINS"], "studio-x,studio-y")

    def test_none_by_default(self):
        documents = docs(render())
        self.assertNotIn("mxl", claim(documents, "mediamtx")["spec"]["parameters"])
        self.assertNotIn("parameters", claim(documents, "anc-reader")["spec"])
        self.assertNotIn("PREVIEW_DOMAINS", aggregator_env(documents))

    def test_refuses_an_mxl_parameter_it_would_collide_with(self):
        """Two mxl keys in one mapping are not merged; one silently wins."""
        proc = render(check=False, preview={"domains": ["studio-x"]},
                      mediamtx={"parameters": {"mxl": {"csi": {"enabled": True}}}})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("drop mxl from mediamtx.parameters", proc.stderr)


if __name__ == "__main__":
    unittest.main()
