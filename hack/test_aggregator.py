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
            mock.patch.object(agg, "_idle_since", {}),
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

    def test_creates_the_path_on_demand(self):
        """An encode with no reader on it is an encode nobody asked for.

        mediamtx also holds a reader that arrives before the first frame when
        the path is on demand, and refuses it outright when it is not, so this
        is what lets the card stop guessing at a warmup delay.
        """
        agg.preview_add(self.uuid)
        conf = self.mtx.added()
        self.assertIs(conf["sourceOnDemand"], True)
        self.assertEqual(conf["sourceOnDemandCloseAfter"], "10s")

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


class PathList:
    """Stands in for _mtx, answering /v3/paths/list from a fixture."""

    def __init__(self, paths):
        self.paths = paths
        self.deleted = []
        self.stopped = []

    def __call__(self, path, method="GET", body=None):
        if path == "/v3/paths/list":
            return 200, {"items": [{"name": n, "readers": [{}] * r}
                                   for n, r in self.paths.items()]}
        if path.startswith("/v3/config/paths/delete/"):
            self.deleted.append(path.rsplit("/", 1)[-1])
            return 200, {}
        return 200, {}


class PreviewReaper(unittest.TestCase):
    """When an idle preview path is dropped, and when it is not.

    The rule has to hold across two windows that look identical from here: a
    path created for a browser that has not finished connecting, and a path
    whose last viewer has just left.
    """

    def setUp(self):
        self.idle = {}
        p = mock.patch.object(agg, "_idle_since", self.idle)
        p.start()
        self.addCleanup(p.stop)

    def reap(self, mtx, now):
        with mock.patch.object(agg, "_mtx", mtx):
            return agg._preview_reap_pass(now=now)

    def test_keeps_a_path_within_the_grace_period(self):
        """A card that has not finished its WHEP handshake still owns its path."""
        mtx = PathList({"preview-a": 0})
        self.idle["preview-a"] = 100.0
        self.assertEqual(self.reap(mtx, 100.0 + agg.REAP_GRACE - 1), [])
        self.assertEqual(mtx.deleted, [])

    def test_drops_a_path_idle_past_the_grace_period(self):
        mtx = PathList({"preview-a": 0})
        self.idle["preview-a"] = 100.0
        self.assertEqual(self.reap(mtx, 100.0 + agg.REAP_GRACE + 1), ["preview-a"])
        self.assertEqual(mtx.deleted, ["preview-a"])
        self.assertNotIn("preview-a", self.idle)

    def test_never_drops_a_path_with_a_reader(self):
        mtx = PathList({"preview-a": 2})
        self.idle["preview-a"] = 100.0
        self.assertEqual(self.reap(mtx, 100.0 + agg.REAP_GRACE * 100), [])
        self.assertIsNone(self.idle["preview-a"])

    def test_starts_the_clock_when_the_last_reader_leaves(self):
        """Not at creation: a long-watched path gets the full grace afterwards."""
        mtx = PathList({"preview-a": 1})
        self.reap(mtx, 100.0)
        mtx.paths["preview-a"] = 0
        self.assertEqual(self.reap(mtx, 500.0), [])
        self.assertEqual(self.idle["preview-a"], 500.0)
        self.assertEqual(self.reap(mtx, 500.0 + agg.REAP_GRACE + 1), ["preview-a"])

    def test_gives_an_unrecorded_path_a_full_grace_period(self):
        """What a restarted aggregator sees. Costs a delay, never a live preview."""
        mtx = PathList({"preview-a": 0})
        self.assertEqual(self.reap(mtx, 100.0), [])
        self.assertEqual(self.idle["preview-a"], 100.0)
        self.assertEqual(self.reap(mtx, 100.0 + agg.REAP_GRACE + 1), ["preview-a"])

    def test_leaves_paths_it_did_not_create_alone(self):
        """The compositor's mosaic is published into a path of its own."""
        mtx = PathList({"composite": 0, "some-other-path": 0})
        self.assertEqual(self.reap(mtx, 1e9), [])
        self.assertEqual(mtx.deleted, [])

    def test_stops_the_publisher_before_dropping_an_audio_path(self):
        """The pipeline needs a path that still exists to send EOS into."""
        mtx = PathList({"preview-audio-a": 0})
        self.idle["preview-audio-a"] = 100.0
        calls = []
        with mock.patch.object(agg, "_audio_preview",
                               lambda q, m="GET": calls.append((q, m)) or (200, {})):
            self.reap(mtx, 100.0 + agg.REAP_GRACE + 1)
        self.assertEqual(calls, [("/stop?flow=a", "DELETE")])
        self.assertEqual(mtx.deleted, ["preview-audio-a"])

    def test_strips_the_hls_suffix_when_stopping_a_publisher(self):
        """Both audio paths carry one flow; the suffix is not part of its id."""
        mtx = PathList({"preview-audio-a-hls": 0})
        self.idle["preview-audio-a-hls"] = 100.0
        calls = []
        with mock.patch.object(agg, "_audio_preview",
                               lambda q, m="GET": calls.append((q, m)) or (200, {})):
            self.reap(mtx, 100.0 + agg.REAP_GRACE + 1)
        self.assertEqual(calls, [("/stop?flow=a", "DELETE")])

    def test_reaps_nothing_when_the_media_server_cannot_be_reached(self):
        """A failed list is not evidence that anything is idle."""
        with mock.patch.object(agg, "_mtx", lambda *a, **k: (503, {})):
            self.assertEqual(agg._preview_reap_pass(now=1e9), [])


class PreviewDelete(unittest.TestCase):
    """Closing a card is advisory. It used to tear the path down."""

    def test_deletes_nothing(self):
        mtx = PathList({})
        with mock.patch.object(agg, "_mtx", mtx):
            code, res = agg.preview_del("b2000000-0000-0000-0000-000000000001")
        self.assertEqual(code, 200)
        self.assertEqual(mtx.deleted, [])

    def test_still_rejects_a_malformed_flow_id(self):
        code, _ = agg.preview_del("not-a-uuid")
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
