"""Every MXL flow id the chart books is an RFC 9562 UUID.

BCP-007-03 restricts a flow id to version 1-f and variant 8-b, and nmos-cpp
validates IS-05 transport parameters against that. A writer booked with a
version-0 id runs and its grains reach the multiviewer, but a controller
connecting a receiver to it gets 400.
"""

import re
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
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
NIL_UUID = "00000000-0000-0000-0000-000000000000"
MXL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def render():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as fh:
        yaml.safe_dump(BASE, fh)
        fh.flush()
        proc = subprocess.run(
            ["helm", "template", "qutil", str(CHART),
             "--namespace", "demo-app", "-f", fh.name],
            capture_output=True, text=True, check=True,
        )
    return proc.stdout


class FlowIdTest(unittest.TestCase):
    def setUp(self):
        self.manifest = render()
        self.docs = [d for d in yaml.safe_load_all(self.manifest) if d]

    def test_every_booked_id_conforms(self):
        """Every UUID the chart renders but the Nil UUID in the aggregator's
        source is a flow id of a booked claim."""
        ids = set(UUID.findall(self.manifest)) - {NIL_UUID}
        self.assertTrue(ids)
        self.assertEqual(sorted(u for u in ids if not MXL_UUID.match(u)), [])

    def test_multiviewer_tiles_are_the_writers_flows(self):
        """The aggregator derives each tile's flow as the prefix plus one
        digit, so the prefix has to stay the writers' ids minus that digit."""
        env = {}
        for doc in self.docs:
            if doc["kind"] != "Deployment":
                continue
            for container in doc["spec"]["template"]["spec"]["containers"]:
                for var in container.get("env", []):
                    env[var["name"]] = var.get("value")
        prefix, count = env["FLOW_PREFIX"], int(env["N_FLOWS"])
        tiles = {prefix + str(n) for n in range(1, count + 1)}
        for tile in tiles:
            self.assertRegex(tile, MXL_UUID)
        writers = {
            d["spec"]["parameters"]["flow"]["video_output"]["id"]
            for d in self.docs
            if d["kind"] == "MediaFunctionClaim"
            and d["metadata"]["name"].startswith("writer-mxl-")
        }
        self.assertEqual(tiles, writers)


if __name__ == "__main__":
    unittest.main()
