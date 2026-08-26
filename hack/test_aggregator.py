#!/usr/bin/env python3
"""Unit tests for charts/qutil/files/aggregator.py.

The aggregator ships as a ConfigMap literal and runs as a single
dependency-free script, so it has no package to import and no test runner of
its own. It is importable all the same: the serve loop sits behind an
`if __name__ == "__main__"` guard, and the one module-level call that touches
the filesystem reads the service account namespace, which `DEMO_NS`
short-circuits. Setting it before the module is loaded is what keeps importing
it free of side effects.

Run: DEMO_NS=test python3 -m unittest discover -s hack -p 'test_*.py'
"""
import importlib.util
import os
import pathlib
import unittest
from unittest import mock

os.environ.setdefault("DEMO_NS", "test")

_SOURCE = pathlib.Path(__file__).resolve().parent.parent / "charts/qutil/files/aggregator.py"


def _load():
    spec = importlib.util.spec_from_file_location("aggregator", _SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agg = _load()


def video_flow(uuid, rate_num=30, rate_den=1):
    """The subset of an MxlFlow the preview path reads."""
    return {
        "metadata": {"name": uuid},
        "spec": {
            "definition": {
                "format": "urn:x-nmos:format:video",
                "media_type": "video/v210",
                "frame_width": 1920,
                "frame_height": 1080,
                "grain_rate": {"numerator": rate_num, "denominator": rate_den},
            }
        },
    }


class MtxRecorder:
    """Stands in for _mtx, recording calls and answering from a script.

    A path that does not exist yet answers the existence probe with 404, which
    is what drives preview_add down the create branch.
    """

    def __init__(self, existing=()):
        self.calls = []
        self.existing = set(existing)

    def __call__(self, path, method="GET", body=None):
        self.calls.append((path, method, body))
        if path.startswith("/v3/config/paths/get/"):
            name = path.rsplit("/", 1)[-1]
            return (200, {}) if name in self.existing else (404, {})
        return 200, {}

    def added(self):
        """The body of the single paths/add POST, or None."""
        for path, method, body in self.calls:
            if method == "POST" and path.startswith("/v3/config/paths/add/"):
                return body
        return None


class PreviewPathConfig(unittest.TestCase):
    """What preview_add asks mediamtx to create for a video flow."""

    def setUp(self):
        self.uuid = "b2000000-0000-0000-0000-000000000001"
        self.mtx = MtxRecorder()
        patches = [
            mock.patch.object(agg, "_mtx", self.mtx),
            mock.patch.object(agg, "_known_flow", lambda u: video_flow(u)),
            mock.patch.object(agg, "_holders", {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_leaves_the_idr_period_to_the_media_server(self):
        """The rate is the flow's, so the GOP that follows from it is too.

        A fixed frame count is right for one rate and wrong for every other,
        and a GOP the length of hlsSegmentDuration lands on the HLS muxer's cut
        comparison, which makes segment durations alternate.
        """
        code, _ = agg.preview_add(self.uuid)
        self.assertEqual(code, 200)
        conf = self.mtx.added()
        self.assertIsNotNone(conf, "no path was created")
        self.assertNotIn("mxlH264IDRPeriod", conf)

    def test_still_pins_the_encoder_settings_that_are_not_rate_derived(self):
        """Dropping the IDR period must not take the rest of the config with it."""
        agg.preview_add(self.uuid)
        conf = self.mtx.added()
        self.assertEqual(conf["source"], f"mxl://{agg.MXL_DOMAIN}/{self.uuid}")
        self.assertEqual(conf["mxlH264Preset"], "veryfast")
        self.assertEqual(conf["mxlH264Profile"], "high")
        self.assertEqual(conf["mxlH264Bitrate"], 5000000)

    def test_reuses_an_existing_path(self):
        """Two cards on one flow share the path rather than racing to create it."""
        self.mtx.existing.add("preview-" + self.uuid)
        code, res = agg.preview_add(self.uuid)
        self.assertEqual(code, 200)
        self.assertIsNone(self.mtx.added())
        self.assertEqual(res["path"], "preview-" + self.uuid)


class PreviewAddGuards(unittest.TestCase):
    """Refusals that happen before anything is provisioned."""

    def setUp(self):
        self.mtx = MtxRecorder()
        p = mock.patch.object(agg, "_mtx", self.mtx)
        p.start()
        self.addCleanup(p.stop)

    def test_rejects_a_malformed_flow_id(self):
        code, res = agg.preview_add("not-a-uuid")
        self.assertEqual(code, 400)
        self.assertEqual(self.mtx.calls, [])

    def test_rejects_a_flow_the_operator_does_not_know(self):
        with mock.patch.object(agg, "_known_flow", lambda u: None):
            code, _ = agg.preview_add("b2000000-0000-0000-0000-000000000001")
        self.assertEqual(code, 404)
        self.assertEqual(self.mtx.calls, [])

    def test_refuses_a_format_with_no_route_to_a_browser(self):
        """mxlSource would retry the open every few seconds and log forever."""
        flow = video_flow("b2000000-0000-0000-0000-000000000001")
        flow["spec"]["definition"]["format"] = "urn:x-nmos:format:mux"
        with mock.patch.object(agg, "_known_flow", lambda u: flow):
            code, _ = agg.preview_add("b2000000-0000-0000-0000-000000000001")
        self.assertEqual(code, 415)
        self.assertIsNone(self.mtx.added())


if __name__ == "__main__":
    unittest.main()
