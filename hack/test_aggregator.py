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
import io
import json
import os
import pathlib
import threading
import time
import unittest
import urllib.parse
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


def audio_flow(uuid, channels=2):
    return {
        "metadata": {"name": uuid},
        "spec": {
            "definition": {
                "format": "urn:x-nmos:format:audio",
                "media_type": "audio/float32",
                "channel_count": channels,
                "sample_rate": {"numerator": 48000},
            }
        },
    }


class MtxRecorder:
    """Stands in for _mtx, recording calls and answering from a script.

    A path that does not exist yet answers the existence probe with 404, which
    is what drives preview_add down the create branch.
    """

    def __init__(self, existing=(), running=None):
        self.calls = []
        self.existing = set(existing)
        # Paths the server is still running. Defaults to the configured set;
        # a test that wants the window where the two disagree names it.
        self.running = None if running is None else set(running)
        # What a configured path reads back as, for the callers that compare
        # against it before deciding to write.
        self.configs = {}

    def __call__(self, path, method="GET", body=None):
        self.calls.append((path, method, body))
        if path.startswith("/v3/config/paths/get/"):
            name = path.rsplit("/", 1)[-1]
            if name not in self.existing:
                return 404, {}
            return 200, dict(self.configs.get(name, {}))
        if path == "/v3/config/paths/list":
            # One source of truth: a path the recorder says is configured is a
            # path the configuration listing has to report, or a test can pass
            # against a server that contradicts itself.
            return 200, {"items": [{"name": n} for n in sorted(self.existing)]}
        if path == "/v3/paths/list":
            # Running paths, which are not the same set: one outlives its
            # configuration while its last reader drains.
            return 200, {"items": [{"name": n, "readers": []}
                                   for n in sorted(self.running or self.existing)]}
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
        self.uuid = "b2000000-0000-4000-8000-000000000001"
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
        self.assertEqual(conf["mxlH264Preset"], "superfast")
        self.assertEqual(conf["mxlH264Profile"], "high")
        self.assertEqual(conf["mxlH264Bitrate"], 5000000)

    def test_caps_the_preview_at_twenty_five_frames_a_second(self):
        """Previews share one media server; at 50 fps they filled its node.

        The cap is a preview's, not the flow's: the flow keeps its own rate.
        """
        agg.preview_add(self.uuid)
        conf = self.mtx.added()
        self.assertEqual(conf["mxlH264MaxRate"], 25)

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


class EncodingServer(MtxRecorder):
    """A media server carrying its own preview names, as the mediamtx chart
    renders them: read from MXL where it encodes itself, proxied to its
    encoders where it does not."""

    UNSPLIT = ("~^video/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}"
               "-[0-9a-f]{12})$")
    SPLIT = "~^((?:domains/[^/]+/)?video/.+)$"

    def __init__(self, regexp=UNSPLIT, rtsp=":8554"):
        super().__init__()
        self.regexp = regexp
        self.rtsp = rtsp

    def __call__(self, path, method="GET", body=None):
        if path.startswith("/v3/config/paths/list?"):
            self.calls.append((path, method, body))
            return 200, {"items": [{"name": self.regexp}]}
        if path == "/v3/config/global/get":
            self.calls.append((path, method, body))
            return 200, {"rtspAddress": self.rtsp}
        return super().__call__(path, method, body)


class EncodedPreview(unittest.TestCase):
    """A video preview on a server that decides where its encodes run.

    Pointing the path at the server's own video/ name is what lets those
    encodes move off the server onto encoders that scale with them. Encoding
    it here as well would put the encode back on the server, so nothing about
    the encode may be configured on such a path.
    """

    VIDEO = "b2000000-0000-4000-8000-000000000001"
    AUDIO = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.flows = {self.VIDEO: video_flow(self.VIDEO),
                      self.AUDIO: audio_flow(self.AUDIO),
                      "studio-x." + self.VIDEO: video_flow("studio-x." + self.VIDEO)}
        for p in (mock.patch.object(agg, "_known_flow", self.flows.get),
                  mock.patch.object(agg, "PREVIEW_DOMAINS", frozenset({"studio-x"})),
                  mock.patch.object(agg, "redundancy_sets", lambda: ([], None)),
                  mock.patch.object(agg, "_idle_since", {})):
            p.start()
            self.addCleanup(p.stop)

    def add(self, server, *args, **kwargs):
        with mock.patch.object(agg, "_mtx", server):
            code, _ = agg.preview_add(*args, **kwargs)
        self.assertEqual(code, 200)
        return server.added()

    def test_a_video_preview_reads_the_servers_own_name(self):
        for regexp in (EncodingServer.UNSPLIT, EncodingServer.SPLIT):
            with self.subTest(regexp=regexp):
                conf = self.add(EncodingServer(regexp), self.VIDEO)
                self.assertEqual(conf["source"],
                                 f"rtsp://127.0.0.1:8554/video/{self.VIDEO}")
                self.assertEqual(conf["rtspTransport"], "tcp")
                self.assertFalse([k for k in conf if k.startswith("mxl")])

    def test_it_stays_on_demand_and_waits_for_a_mirror(self):
        conf = self.add(EncodingServer(), self.VIDEO)
        self.assertIs(conf["sourceOnDemand"], True)
        self.assertEqual(conf["sourceOnDemandStartTimeout"], agg.SOURCE_START_TIMEOUT)

    def test_a_joined_preview_names_both_flows(self):
        conf = self.add(EncodingServer(), self.VIDEO, audio=self.AUDIO)
        self.assertEqual(conf["source"],
                         f"rtsp://127.0.0.1:8554/video/{self.VIDEO}/{self.AUDIO}")

    def test_a_flow_in_another_domain_names_its_domain(self):
        conf = self.add(EncodingServer(EncodingServer.SPLIT), "studio-x." + self.VIDEO)
        self.assertEqual(
            conf["source"],
            f"rtsp://127.0.0.1:8554/domains/studio-x/video/{self.VIDEO}")

    def test_the_port_is_the_servers_own(self):
        conf = self.add(EncodingServer(rtsp="0.0.0.0:9554"), self.VIDEO)
        self.assertTrue(conf["source"].startswith("rtsp://127.0.0.1:9554/"))

    def test_audio_alone_is_still_read_from_mxl(self):
        """The server's names carry video. An audio preview costs a percent of
        a core and picks its channel pair per path, so it stays a direct read."""
        conf = self.add(EncodingServer(), self.AUDIO)
        self.assertEqual(conf["source"], f"mxl://{agg.MXL_DOMAIN}/{self.AUDIO}")

    def test_a_server_without_the_names_encodes_as_before(self):
        conf = self.add(EncodingServer(regexp="~^(.+)$"), self.VIDEO)
        self.assertEqual(conf["source"], f"mxl://{agg.MXL_DOMAIN}/{self.VIDEO}")
        self.assertEqual(conf["mxlH264MaxRate"], agg.PREVIEW_MAX_RATE)

    def test_an_unreadable_port_falls_back_rather_than_guessing(self):
        conf = self.add(EncodingServer(rtsp=""), self.VIDEO)
        self.assertTrue(conf["source"].startswith("mxl://"))


class PreviewAddGuards(unittest.TestCase):
    """Refusals that happen before anything is provisioned."""

    def setUp(self):
        self.mtx = MtxRecorder()
        for p in (mock.patch.object(agg, "_mtx", self.mtx),
                  mock.patch.object(agg, "redundancy_sets", lambda: ([], None))):
            p.start()
            self.addCleanup(p.stop)

    def test_rejects_a_malformed_flow_id(self):
        code, res = agg.preview_add("not-a-uuid")
        self.assertEqual(code, 400)
        self.assertEqual(self.mtx.calls, [])

    def test_refuses_a_flow_in_another_domain_by_naming_the_domain(self):
        """An MxlFlow outside the primary domain is named <domain>.<id>, and
        the inventory lists it by that name. The media server reads only the
        primary domain, so the refusal says that rather than "bad flow id",
        which read as a parsing fault in the page."""
        name = "studio-x.5fd00000-0000-4000-8000-0000000000d1"
        for call in (agg.preview_add, agg.preview_status, agg.anc_grain,
                     agg.preview_del):
            code, res = call(name)
            self.assertEqual(code, 422, call.__name__)
            self.assertIn("MXL domain studio-x", res["error"], call.__name__)
        self.assertEqual(self.mtx.calls, [])

    def test_refuses_another_domain_nothing_mounts_even_if_one_other_is(self):
        """Only the domains the media server mounts preview; the rest still
        refuse by name."""
        name = "studio-y.5fd00000-0000-4000-8000-0000000000d1"
        with mock.patch.object(agg, "PREVIEW_DOMAINS", frozenset({"studio-x"})):
            code, res = agg.preview_add(name)
        self.assertEqual(code, 422)
        self.assertIn("MXL domain studio-y", res["error"])
        self.assertEqual(self.mtx.calls, [])

    def test_rejects_a_flow_the_operator_does_not_know(self):
        with mock.patch.object(agg, "_known_flow", lambda u: None):
            code, _ = agg.preview_add("b2000000-0000-4000-8000-000000000001")
        self.assertEqual(code, 404)
        self.assertEqual(self.mtx.calls, [])

    def test_refuses_a_format_with_no_route_to_a_browser(self):
        """mxlSource would retry the open every few seconds and log forever."""
        flow = video_flow("b2000000-0000-4000-8000-000000000001")
        flow["spec"]["definition"]["format"] = "urn:x-nmos:format:mux"
        with mock.patch.object(agg, "_known_flow", lambda u: flow):
            code, _ = agg.preview_add("b2000000-0000-4000-8000-000000000001")
        self.assertEqual(code, 415)
        self.assertIsNone(self.mtx.added())


class PreviewInAnotherDomain(unittest.TestCase):
    """A flow in an MxlDomain the media server and the ANC reader mount is read
    from the directory that domain is mounted at, under its own name."""

    VIDEO = "studio-x.5fd00000-0000-4000-8000-0000000000d1"
    AUDIO = "studio-x.5fd00000-0000-4000-8000-0000000000d2"
    DATA = "studio-x.5fd00000-0000-4000-8000-0000000000d3"

    def setUp(self):
        self.mtx = MtxRecorder()
        flows = {self.VIDEO: video_flow(self.VIDEO), self.AUDIO: audio_flow(self.AUDIO),
                 self.DATA: {"metadata": {"name": self.DATA}, "spec": {"definition": {
                     "format": "urn:x-nmos:format:data", "media_type": "video/smpte291"}}}}
        for p in (mock.patch.object(agg, "_mtx", self.mtx),
                  mock.patch.object(agg, "PREVIEW_DOMAINS", frozenset({"studio-x"})),
                  mock.patch.object(agg, "MXL_DOMAINS_DIR", "/run/mxl/domains"),
                  mock.patch.object(agg, "_known_flow", flows.get)):
            p.start()
            self.addCleanup(p.stop)

    def test_video_reads_the_mounted_domain(self):
        code, res = agg.preview_add(self.VIDEO)
        self.assertEqual(code, 200, res)
        self.assertEqual(res["path"], "preview-" + self.VIDEO)
        self.assertEqual(self.mtx.added()["source"],
                         "mxl:///run/mxl/domains/studio-x/5fd00000-0000-4000-8000-0000000000d1")

    def test_audio_reads_the_mounted_domain(self):
        code, res = agg.preview_add(self.AUDIO, channels="1,2")
        self.assertEqual(code, 200, res)
        self.assertEqual(self.mtx.added()["source"],
                         "mxl:///run/mxl/domains/studio-x/5fd00000-0000-4000-8000-0000000000d2")

    def test_joined_names_the_audio_by_its_id_in_the_same_domain(self):
        code, res = agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(code, 200, res)
        self.assertEqual(res["path"], "preview-" + self.VIDEO + "-5fd00000-0000-4000-8000-0000000000d2")
        self.assertEqual(self.mtx.added()["source"],
                         "mxl:///run/mxl/domains/studio-x/5fd00000-0000-4000-8000-0000000000d1"
                         "?audio=5fd00000-0000-4000-8000-0000000000d2")
        # A later picture-only request finds the joined path and is told which
        # audio flow it carries, by the name the inventory lists it under.
        self.mtx.existing.add(res["path"])
        code, again = agg.preview_add(self.VIDEO)
        self.assertEqual((code, again["path"], again["audio"]), (200, res["path"], self.AUDIO))

    def test_joined_refuses_flows_in_two_domains(self):
        code, res = agg.preview_add(self.VIDEO, audio="5fd00000-0000-4000-8000-0000000000d2")
        self.assertEqual(code, 400)
        self.assertIn("one MXL domain", res["error"])
        self.assertIsNone(self.mtx.added())

    def test_anc_names_the_domain_to_the_reader(self):
        seen = []
        with mock.patch.object(agg, "_anc_preview", lambda q: seen.append(q) or (200, {})):
            agg.anc_grain(self.DATA)
        self.assertEqual(seen, ["/grain?flow=5fd00000-0000-4000-8000-0000000000d3&domain=studio-x"])

    def test_the_primary_domain_is_read_as_before(self):
        primary = "5fd00000-0000-4000-8000-0000000000e1"
        with mock.patch.object(agg, "_known_flow", lambda u: video_flow(u)):
            code, _ = agg.preview_add(primary)
        self.assertEqual(code, 200)
        self.assertEqual(self.mtx.added()["source"], "mxl:///run/mxl/domain/" + primary)
        seen = []
        with mock.patch.object(agg, "_anc_preview", lambda q: seen.append(q) or (200, {})):
            agg.anc_grain(primary)
        self.assertEqual(seen, ["/grain?flow=" + primary])


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


class JoinedPreview(unittest.TestCase):
    """One path carrying a video flow and an audio flow together.

    Picture and sound are separate flows and nothing downstream rejoins them,
    so a card that wants both names both.
    """

    VIDEO = "b2000000-0000-4000-8000-000000000001"
    AUDIO = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.mtx = MtxRecorder()
        self.flows = {self.VIDEO: video_flow(self.VIDEO), self.AUDIO: audio_flow(self.AUDIO)}
        patches = [
            mock.patch.object(agg, "_mtx", self.mtx),
            mock.patch.object(agg, "_known_flow", lambda u: self.flows.get(u)),
            mock.patch.object(agg, "redundancy_sets", lambda: ([], None)),
            mock.patch.object(agg, "_idle_since", {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_names_both_flows_on_one_source(self):
        code, res = agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(code, 200)
        conf = self.mtx.added()
        self.assertEqual(
            conf["source"], f"mxl://{agg.MXL_DOMAIN}/{self.VIDEO}?audio={self.AUDIO}"
        )
        self.assertEqual(res["audio"], self.AUDIO)

    def test_path_name_carries_no_character_the_media_server_refuses(self):
        """Its path names accept only [0-9a-zA-Z_-/.], so a "+" would be rejected."""
        code, res = agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(code, 200)
        self.assertRegex(res["path"], r"^[0-9a-zA-Z_\-/.]+$")
        self.assertEqual(res["path"], f"preview-{self.VIDEO}-{self.AUDIO}")

    def test_is_created_on_demand_like_any_other_preview(self):
        agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertIs(self.mtx.added()["sourceOnDemand"], True)

    def test_rejects_a_malformed_audio_flow_id(self):
        code, _ = agg.preview_add(self.VIDEO, audio="not-a-uuid")
        self.assertEqual(code, 400)
        self.assertIsNone(self.mtx.added())

    def test_rejects_an_audio_flow_the_operator_does_not_know(self):
        code, _ = agg.preview_add(self.VIDEO, audio="aea7b9e9-0000-0000-0000-000000000000")
        self.assertEqual(code, 404)
        self.assertIsNone(self.mtx.added())

    def test_refuses_a_second_flow_that_is_not_audio(self):
        """Two video flows would give the media server two pictures and no sound."""
        other = "b2000000-0000-4000-8000-000000000002"
        self.flows[other] = video_flow(other)
        code, _ = agg.preview_add(self.VIDEO, audio=other)
        self.assertEqual(code, 415)
        self.assertIsNone(self.mtx.added())

    def test_refuses_to_join_a_flow_to_itself(self):
        code, _ = agg.preview_add(self.AUDIO, audio=self.AUDIO)
        self.assertEqual(code, 400)
        self.assertIsNone(self.mtx.added())

    def test_refuses_when_the_first_flow_is_not_video(self):
        code, _ = agg.preview_add(self.AUDIO, audio=self.VIDEO)
        self.assertEqual(code, 415)
        self.assertIsNone(self.mtx.added())

    def test_reuses_a_joined_path_that_already_exists(self):
        self.mtx.existing.add(f"preview-{self.VIDEO}-{self.AUDIO}")
        code, _ = agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(code, 200)
        self.assertIsNone(self.mtx.added())


    def test_a_bare_request_reuses_the_joined_path(self):
        """One encoder per video flow, whatever the caller asked for.

        A card opening picture-only on a flow already previewed with its sound
        must not start a second reader and a second encoder over the same
        video. The joined path is the one that exists, so it is the one served.
        """
        joined = f"preview-{self.VIDEO}-{self.AUDIO}"
        self.mtx.existing.add(joined)
        code, res = agg.preview_add(self.VIDEO)
        self.assertEqual(code, 200)
        self.assertEqual(res["path"], joined)
        self.assertEqual(res["audio"], self.AUDIO)
        self.assertIsNone(self.mtx.added())

    def test_a_joined_request_does_not_settle_for_a_silent_path(self):
        """The reverse does not hold: sound asked for is sound delivered."""
        self.mtx.existing.add(f"preview-{self.VIDEO}")
        code, res = agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(code, 200)
        self.assertEqual(res["path"], f"preview-{self.VIDEO}-{self.AUDIO}")
        self.assertEqual(self.mtx.added()["source"],
                         f"mxl://{agg.MXL_DOMAIN}/{self.VIDEO}?audio={self.AUDIO}")

    def test_a_joined_path_being_torn_down_is_not_handed_out(self):
        """A running path outlives its configuration.

        The reaper deletes the configuration and the path keeps running until
        its last reader drains. Reusing a name out of that window gives the
        card a URL the media server answers with "path is not configured", and
        the preview never starts -- which is worse than the second encoder the
        reuse exists to avoid, because it never recovers.
        """
        joined = f"preview-{self.VIDEO}-{self.AUDIO}"
        # Running but no longer configured: exactly the teardown window.
        self.mtx.running = {joined}

        code, res = agg.preview_add(self.VIDEO)

        self.assertEqual(code, 200)
        self.assertEqual(res["path"], f"preview-{self.VIDEO}")
        self.assertNotIn("audio", res)
        self.assertEqual(self.mtx.added()["source"],
                         f"mxl://{agg.MXL_DOMAIN}/{self.VIDEO}")

    def test_another_flows_joined_path_is_not_mistaken_for_this_ones(self):
        """A hyphen also separates a UUID's own fields, so the id matches whole."""
        other = "b2000000-0000-4000-8000-000000000002"
        self.mtx.existing.add(f"preview-{other}-{self.AUDIO}")
        code, res = agg.preview_add(self.VIDEO)
        self.assertEqual(code, 200)
        self.assertEqual(res["path"], f"preview-{self.VIDEO}")
        self.assertNotIn("audio", res)


class NativeAudioPreview(unittest.TestCase):
    """Audio read by the media server itself, rather than pushed into it.

    What this replaces took a reader process, two mediamtx paths and an AAC
    copy of the same audio, because the MPEG-TS muxer carries no Opus. The
    server reads the flow now and one Opus track serves both transports.
    """

    UUID = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.mtx = MtxRecorder()
        patches = [
            mock.patch.object(agg, "_mtx", self.mtx),
            mock.patch.object(agg, "_known_flow", lambda u: audio_flow(u, channels=12)),
            mock.patch.object(agg, "_idle_since", {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_one_path_reads_the_flow(self):
        """Not two, and not a publisher target waiting to be pushed to."""
        code, res = agg.preview_add(self.UUID)
        self.assertEqual(code, 200)
        self.assertEqual(res["path"], f"preview-{self.UUID}")
        conf = self.mtx.added()
        self.assertEqual(conf["source"], f"mxl://{agg.MXL_DOMAIN}/{self.UUID}")
        adds = [c for c in self.mtx.calls
                if c[1] == "POST" and c[0].startswith("/v3/config/paths/add/")]
        self.assertEqual(len(adds), 1, "audio should create exactly one path")

    def test_no_separate_hls_path_is_created(self):
        """The AAC twin existed only because MPEG-TS refuses Opus."""
        agg.preview_add(self.UUID)
        names = [c[0] for c in self.mtx.calls if "/paths/add/" in c[0]]
        self.assertFalse([n for n in names if n.endswith("-hls")])
        self.assertFalse([n for n in names if "preview-audio-" in n])

    def test_the_pair_reaches_the_server(self):
        conf = agg.preview_add(self.UUID, channels="5,6")[1] and self.mtx.added()
        self.assertEqual(conf["mxlAudioChannels"], "5,6")

    def test_a_pair_the_flow_does_not_carry_is_refused(self):
        """Configured instead, the media server fails the open and its source
        retries every 5s for as long as the path exists. Nothing reports that
        back, so the card waits on sound that cannot arrive."""
        with mock.patch.object(agg, "_known_flow", lambda u: audio_flow(u, channels=2)):
            code, res = agg.preview_add(self.UUID, channels="3,4")
        self.assertEqual(code, 400)
        self.assertIn("2", res["error"])
        self.assertFalse([c for c in self.mtx.calls if "/paths/add/" in c[0]],
                         "no path may be created for a pair that cannot open")

    def test_a_pair_the_flow_does_carry_is_allowed(self):
        """The check must read the flow's own width, not a fixed stereo."""
        code, _ = agg.preview_add(self.UUID, channels="11,12")
        self.assertEqual(code, 200)
        self.assertEqual(self.mtx.added()["mxlAudioChannels"], "11,12")

    def test_it_is_created_on_demand(self):
        """An audio preview nobody is listening to should not be encoding."""
        agg.preview_add(self.UUID)
        self.assertTrue(self.mtx.added()["sourceOnDemand"])

    def test_reopening_does_not_rewrite_the_path(self):
        """Replacing it restarts the reader, which a listener hears, so an
        unchanged pair must not touch it."""
        self.mtx.existing.add(f"preview-{self.UUID}")
        agg.preview_add(self.UUID)
        writes = [c for c in self.mtx.calls
                  if c[1] == "POST" and "/paths/" in c[0]]
        self.assertEqual(writes, [])

    def test_a_different_pair_gets_a_second_path(self):
        """So it can run alongside the first rather than replacing it, which
        is what lets a listener hear every pair at once and move between them
        without a reconnect gap."""
        self.mtx.existing.add(f"preview-{self.UUID}-p1-2")
        code, res = agg.preview_add(self.UUID, channels="7,8")
        self.assertEqual(code, 200)
        self.assertEqual(res["path"], f"preview-{self.UUID}-p7-8")
        replaces = [c for c in self.mtx.calls if "/paths/replace/" in c[0]]
        self.assertEqual(replaces, [])
        self.assertEqual(self.mtx.added()["mxlAudioChannels"], "7,8")

    def test_reopening_the_same_pair_does_not_duplicate_the_path(self):
        self.mtx.existing.add(f"preview-{self.UUID}-p1-2")
        agg.preview_add(self.UUID, channels="1,2")
        adds = [c for c in self.mtx.calls
                if c[1] == "POST" and "/paths/add/" in c[0]]
        self.assertEqual(adds, [])

    def test_two_pairs_coexist_as_separate_paths(self):
        agg.preview_add(self.UUID, channels="1,2")
        agg.preview_add(self.UUID, channels="3,4")
        adds = [c[0].rsplit("/", 1)[-1] for c in self.mtx.calls
                if c[1] == "POST" and "/paths/add/" in c[0]]
        self.assertEqual(adds, [f"preview-{self.UUID}-p1-2",
                                f"preview-{self.UUID}-p3-4"])

    def test_a_bad_pair_is_refused_before_anything_is_created(self):
        code, _ = agg.preview_add(self.UUID, channels="left,right")
        self.assertEqual(code, 400)
        self.assertIsNone(self.mtx.added())


class PreviewSourceStartTimeout(unittest.TestCase):
    """How long the server waits for a preview's source to come up.

    Its own default is ten seconds. That is enough for a flow already in the
    node's domain, and not enough for one that is not: opening that flow is
    what makes the intent shim ask the node agent to mirror it, and no read
    succeeds until the mirror exists. Ten seconds killed the source first, so a
    preview of a flow originating on another node never started at all - and
    the failure reads as "flow not found", which looks like the flow is missing
    rather than like the wait being too short.
    """

    VIDEO = "b2000000-0000-4000-8000-000000000001"
    AUDIO = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.mtx = MtxRecorder()
        self.flows = {self.VIDEO: video_flow(self.VIDEO),
                      self.AUDIO: audio_flow(self.AUDIO)}
        for p in [mock.patch.object(agg, "_mtx", self.mtx),
                  mock.patch.object(agg, "_known_flow", lambda u: self.flows.get(u)),
                  mock.patch.object(agg, "_idle_since", {})]:
            p.start()
            self.addCleanup(p.stop)

    def test_a_video_preview_waits_longer_than_the_default(self):
        agg.preview_add(self.VIDEO)
        self.assertEqual(self.mtx.added()["sourceOnDemandStartTimeout"],
                         agg.SOURCE_START_TIMEOUT)

    def test_an_audio_preview_waits_too(self):
        agg.preview_add(self.AUDIO)
        self.assertEqual(self.mtx.added()["sourceOnDemandStartTimeout"],
                         agg.SOURCE_START_TIMEOUT)

    def test_a_joined_preview_waits_too(self):
        """Two flows, so two chances of one needing a mirror."""
        agg.preview_add(self.VIDEO, audio=self.AUDIO)
        self.assertEqual(self.mtx.added()["sourceOnDemandStartTimeout"],
                         agg.SOURCE_START_TIMEOUT)

    def test_the_wait_exceeds_the_servers_own_default(self):
        """A value at or below ten seconds would reintroduce the bug."""
        self.assertTrue(agg.SOURCE_START_TIMEOUT.endswith("s"))
        self.assertGreater(int(agg.SOURCE_START_TIMEOUT[:-1]), 10)

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

    def test_reaps_nothing_when_the_media_server_cannot_be_reached(self):
        """A failed list is not evidence that anything is idle."""
        with mock.patch.object(agg, "_mtx", lambda *a, **k: (503, {})):
            self.assertEqual(agg._preview_reap_pass(now=1e9), [])


class PreviewDelete(unittest.TestCase):
    """Closing a card is advisory. It used to tear the path down."""

    def test_deletes_nothing(self):
        mtx = PathList({})
        with mock.patch.object(agg, "_mtx", mtx):
            code, res = agg.preview_del("b2000000-0000-4000-8000-000000000001")
        self.assertEqual(code, 200)
        self.assertEqual(mtx.deleted, [])

    def test_still_rejects_a_malformed_flow_id(self):
        code, _ = agg.preview_del("not-a-uuid")
        self.assertEqual(code, 400)


class GeneratorDeletePreviewPaths(unittest.TestCase):
    """Deleting a generator's claim also drops the preview paths behind its
    flows: left up, a path pointing at a flow that just went away retries the
    open every 5s for as long as the server lives. A wide audio flow can have
    one such path per pair, and none of them are the bare preview-<uuid>.
    """

    NAME = "generator-demo-ab12"
    VIDEO = "b2000000-0000-4000-8000-000000000001"
    AUDIO = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def _claim(self):
        return {
            "metadata": {
                "name": self.NAME,
                "labels": {
                    agg._GEN_LABEL_MANAGED: agg.GEN_MANAGER,
                    agg._GEN_LABEL_COMPONENT: agg._GEN_COMPONENT,
                },
            },
            "spec": {
                "parameters": {
                    "flow": {
                        "video_output": {"id": self.VIDEO},
                        "audio_output": {"id": self.AUDIO},
                    }
                }
            },
        }

    def setUp(self):
        self.mtx = MtxRecorder(existing={
            f"preview-{self.VIDEO}",
            f"preview-{self.VIDEO}-p1-2",
            f"preview-{self.VIDEO}-p3-4",
            f"preview-{self.AUDIO}",
        })
        patches = [
            mock.patch.object(agg, "GEN_ENABLED", True),
            mock.patch.object(agg, "_mtx", self.mtx),
            mock.patch.object(agg, "safe_k8s", lambda *a, **k: self._claim()),
            mock.patch.object(agg, "k8s_json", lambda *a, **k: (200, {})),
            mock.patch.object(agg, "snapshot_drop", lambda *a, **k: None),
            mock.patch.object(agg, "_idle_since", {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _deleted(self):
        return [path.rsplit("/", 1)[-1] for path, method, _ in self.mtx.calls
                if method == "DELETE" and path.startswith("/v3/config/paths/delete/")]

    def test_deletes_every_pair_suffixed_path_of_a_wide_flow(self):
        code, _ = agg.generator_delete(self.NAME)
        self.assertEqual(code, 200)
        self.assertIn(f"preview-{self.VIDEO}-p1-2", self._deleted())
        self.assertIn(f"preview-{self.VIDEO}-p3-4", self._deleted())

    def test_still_deletes_the_bare_path(self):
        code, _ = agg.generator_delete(self.NAME)
        self.assertEqual(code, 200)
        self.assertIn(f"preview-{self.VIDEO}", self._deleted())

    def test_covers_every_flow_the_claim_names(self):
        code, _ = agg.generator_delete(self.NAME)
        self.assertEqual(code, 200)
        self.assertIn(f"preview-{self.AUDIO}", self._deleted())

    def test_does_not_touch_another_flows_path(self):
        other = "b2000000-0000-4000-8000-000000000002"
        self.mtx.existing.add(f"preview-{other}")
        agg.generator_delete(self.NAME)
        self.assertNotIn(f"preview-{other}", self._deleted())

    def test_returns_the_deleted_claim_name_not_a_preview_path(self):
        code, res = agg.generator_delete(self.NAME)
        self.assertEqual(code, 200)
        self.assertEqual(res["deleted"], self.NAME)


class GeneratorBooking(unittest.TestCase):
    """Copies and node pinning on the booking path.

    Every copy is a writer on the shared MXL domain, and the writer chart clears
    its flow id's grains with a root `rm -rf` glob on start, so two copies on one
    id delete each other's grains. Only the first copy may carry the submitted
    ids.
    """

    VIDEO = "3f2c8a1e-1111-4222-8333-444455556666"
    AUDIO = "9b1d0000-2222-4333-8444-555566667777"

    def _req(self, **over):
        req = {
            "label": "Bars", "ttl": "1h", "count": 1, "node": "",
            "video": {"enabled": True, "id": self.VIDEO, "pattern": "smpte",
                      "overlayText": "", "frameWidth": 1296, "frameHeight": 720,
                      "grainRate": {"numerator": 30000, "denominator": 1001}},
            "audio": {"enabled": True, "id": self.AUDIO, "sampleRate": 48000,
                      "channelCount": 2},
        }
        req.update(over)
        return req

    def setUp(self):
        self.posted = []
        self.fail_at = None

        def k8s_json(path, method="GET", body=None):
            self.posted.append(body)
            if self.fail_at is not None and len(self.posted) == self.fail_at:
                return 500, {"error": "apiserver said no"}
            return 201, body

        def no_list(*a, **k):
            raise AssertionError("booking must not list generators: there is no cap")

        patches = [
            mock.patch.object(agg, "GEN_ENABLED", True),
            mock.patch.object(agg, "_flow_ids_in_use", lambda *a: ({}, None)),
            mock.patch.object(agg, "k8s_json", k8s_json),
            mock.patch.object(agg, "_gen_list", no_list),
            mock.patch.object(agg, "snapshot_drop", lambda *a, **k: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _ids(self, body):
        flow = body["spec"]["parameters"]["flow"]
        return flow["video_output"]["id"], flow["audio_output"]["id"]

    def test_books_one_claim_per_copy(self):
        code, res = agg.generator_create(self._req(count=3))
        self.assertEqual(code, 201)
        self.assertEqual(len(self.posted), 3)
        self.assertEqual(len(res["generators"]), 3)
        self.assertIsNone(res["error"])

    def test_only_the_first_copy_carries_the_submitted_ids(self):
        agg.generator_create(self._req(count=3))
        ids = [self._ids(b) for b in self.posted]
        self.assertEqual(ids[0], (self.VIDEO, self.AUDIO))
        every = [i for pair in ids for i in pair]
        self.assertEqual(len(set(every)), 6)

    def test_each_copy_mints_around_every_id_booked_before_it(self):
        minted = [["11111111-1111-4111-8111-111111111111",
                   "22222222-2222-4222-8222-222222222222"],
                  ["33333333-3333-4333-8333-333333333333",
                   "44444444-4444-4444-8444-444444444444"]]
        seen = []

        def new_ids(used):
            seen.append(set(used))
            return minted[len(seen) - 1]

        with mock.patch.object(agg, "_gen_new_ids", new_ids):
            agg.generator_create(self._req(count=3))
        self.assertLessEqual({self.VIDEO, self.AUDIO}, seen[0])
        # The second mint has to see the first mint's ids, or copies 2 and 3
        # could land on one flow.
        self.assertLessEqual({self.VIDEO, self.AUDIO, *minted[0]}, seen[1])
        self.assertEqual([self._ids(b) for b in self.posted[1:]],
                         [tuple(m) for m in minted])

    def test_audio_only_copies_get_distinct_audio_ids_and_no_video(self):
        req = self._req(count=3)
        req["video"] = dict(req["video"], enabled=False)
        agg.generator_create(req)
        flows = [b["spec"]["parameters"]["flow"] for b in self.posted]
        audio_ids = [f["audio_output"]["id"] for f in flows]
        self.assertEqual(audio_ids[0], self.AUDIO)
        self.assertEqual(len(set(audio_ids)), 3)
        for f in flows:
            self.assertEqual(f["video_output"], {"enabled": False})

    def test_video_only_copies_carry_no_audio_output(self):
        req = self._req(count=2)
        req["audio"] = dict(req["audio"], enabled=False)
        agg.generator_create(req)
        for b in self.posted:
            self.assertNotIn("audio_output", b["spec"]["parameters"]["flow"])

    def test_a_later_failure_still_returns_what_was_booked(self):
        self.fail_at = 3
        code, res = agg.generator_create(self._req(count=4))
        self.assertEqual(code, 201)
        self.assertEqual(len(res["generators"]), 2)
        self.assertIn("booked 2 of 4", res["error"])
        self.assertEqual(len(self.posted), 3)

    def test_a_first_failure_is_the_error(self):
        self.fail_at = 1
        code, res = agg.generator_create(self._req(count=2))
        self.assertEqual(code, 500)
        self.assertEqual(res["error"], "apiserver said no")

    def test_refuses_a_count_outside_the_bound(self):
        for count in (0, agg._GEN_MAX_COPIES + 1, True, "2"):
            code, res = agg.generator_create(self._req(count=count))
            self.assertEqual(code, 400, count)
            self.assertIn("count must be between 1 and", res["error"])
        self.assertEqual(self.posted, [])

    def test_pins_the_writer_to_the_named_node(self):
        agg.generator_create(self._req(node=" worker-3 "))
        affinity = self.posted[0]["spec"]["parameters"]["affinity"]
        term = affinity["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"][
            "nodeSelectorTerms"][0]
        self.assertEqual(term["matchFields"],
                         [{"key": "metadata.name", "operator": "In", "values": ["worker-3"]}])
        # By name, not by a hostname label that need not match it.
        self.assertNotIn("nodeSelector", self.posted[0]["spec"]["parameters"])

    def test_leaves_placement_alone_without_a_node(self):
        agg.generator_create(self._req())
        self.assertNotIn("affinity", self.posted[0]["spec"]["parameters"])

    def test_the_row_reports_the_pinned_node(self):
        _, res = agg.generator_create(self._req(node="worker-3"))
        self.assertEqual(res["generators"][0]["node"], "worker-3")
        _, res = agg.generator_create(self._req())
        self.assertIsNone(res["generators"][0]["node"])

    def test_refuses_a_name_no_node_can_carry(self):
        for node in ("Worker_1", "-lead", "a" * 254, "x;rm -rf /", 5, 0, False, []):
            code, res = agg.generator_create(self._req(node=node))
            self.assertEqual(code, 400, node)
            self.assertIn("node must be a Kubernetes node name", res["error"])
        self.assertEqual(self.posted, [])

    def test_the_listing_no_longer_reports_a_cap(self):
        with mock.patch.object(agg, "_gen_list", lambda: ([], [], [], None)):
            res = agg.generators()
        self.assertNotIn("max", res)
        self.assertEqual(res["maxCopies"], agg._GEN_MAX_COPIES)


class GeneratorReaders(unittest.TestCase):
    """Readers of a generator's flows: claims of READER_CLASS that hold every
    flow the generator produces open on a node, which is what mirrors them
    there. They are found, listed and released through the generator."""

    GEN = "generator-bars-ab12"
    VIDEO = "3f2c8a1e-1111-4222-8333-444455556666"
    AUDIO = "9b1d0000-2222-4333-8444-555566667777"
    END = "2026-10-20T12:00:00Z"

    def _generator(self, **labels):
        return {
            "metadata": {"name": self.GEN, "labels": labels or {
                agg._GEN_LABEL_MANAGED: agg.GEN_MANAGER,
                agg._GEN_LABEL_COMPONENT: agg._GEN_COMPONENT}},
            "spec": {"booking": {"jobRef": "qutil/generators", "window": {"end": self.END}},
                     "parameters": {"flow": {
                         "video_output": {"enabled": True, "id": self.VIDEO},
                         "audio_output": {"enabled": True, "id": self.AUDIO}}}},
        }

    def setUp(self):
        self.posted = []
        self.deleted = []
        self.claims = {self.GEN: self._generator()}
        self.fail_at = None

        def k8s_json(path, method="GET", body=None):
            if method == "DELETE":
                self.deleted.append(path.rsplit("/", 1)[-1])
                return 200, {}
            self.posted.append(body)
            if self.fail_at is not None and len(self.posted) == self.fail_at:
                return 500, {"error": "apiserver said no"}
            return 201, body

        def safe_k8s(path):
            if "labelSelector=" in path:
                selector = urllib.parse.unquote(path.split("labelSelector=", 1)[1])
                want = dict(kv.split("=", 1) for kv in selector.split(","))
                return {"items": [c for c in self.claims.values()
                                  if all((c["metadata"].get("labels") or {}).get(k) == v
                                         for k, v in want.items())]}
            name = path.rsplit("/", 1)[-1]
            return self.claims.get(name) or {"_error": "404"}

        patches = [
            mock.patch.object(agg, "GEN_ENABLED", True),
            mock.patch.object(agg, "_flow_ids_in_use", lambda *a: ({}, None)),
            mock.patch.object(agg, "k8s_json", k8s_json),
            mock.patch.object(agg, "safe_k8s", safe_k8s),
            mock.patch.object(agg, "snapshot_drop", lambda *a, **k: None),
            mock.patch.object(agg, "_mtx", MtxRecorder()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_a_reader_reads_every_flow_of_its_generator(self):
        code, res = agg.reader_create(self.GEN, {"count": 1})
        self.assertEqual(code, 201)
        params = self.posted[0]["spec"]["parameters"]
        self.assertEqual(params["flows"], [self.VIDEO, self.AUDIO])
        self.assertEqual(self.posted[0]["spec"]["className"], agg.READER_CLASS)

    def test_a_reader_expires_with_its_generator(self):
        agg.reader_create(self.GEN, {"count": 1})
        self.assertEqual(self.posted[0]["spec"]["booking"]["window"], {"end": self.END})

    def test_readers_carry_the_generator_and_are_named_under_it(self):
        _, res = agg.reader_create(self.GEN, {"count": 2})
        names = [r["name"] for r in res["readers"]]
        self.assertEqual(len(set(names)), 2)
        for body in self.posted:
            self.assertTrue(body["metadata"]["name"].startswith(self.GEN + "-r"))
            self.assertEqual(body["metadata"]["labels"][agg._READER_LABEL_GENERATOR], self.GEN)
            self.assertEqual(body["metadata"]["labels"][agg._GEN_LABEL_COMPONENT], "reader")

    def test_pins_the_reader_and_picks_the_provider(self):
        _, res = agg.reader_create(self.GEN, {"count": 1, "node": "worker-7", "provider": "tcp"})
        params = self.posted[0]["spec"]["parameters"]
        self.assertEqual(params["receiver"], {"provider": "tcp"})
        term = params["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"][
            "nodeSelectorTerms"][0]["matchFields"][0]
        self.assertEqual(term["values"], ["worker-7"])
        self.assertEqual(res["readers"][0]["node"], "worker-7")
        self.assertEqual(res["readers"][0]["provider"], "tcp")

    def test_refuses_a_provider_the_receiver_does_not_know(self):
        code, res = agg.reader_create(self.GEN, {"count": 1, "provider": "carrier-pigeon"})
        self.assertEqual(code, 400)
        self.assertIn("provider must be one of", res["error"])
        self.assertEqual(self.posted, [])

    def test_will_not_read_a_claim_the_page_did_not_book(self):
        self.claims[self.GEN] = self._generator(**{agg._GEN_LABEL_MANAGED: "Helm"})
        code, _ = agg.reader_create(self.GEN, {"count": 1})
        self.assertEqual(code, 404)
        self.assertEqual(self.posted, [])

    def test_the_booking_form_books_readers_of_every_copy(self):
        req = {"label": "Bars", "ttl": "1h", "count": 2, "node": "",
               "readers": {"count": 2, "node": "worker-7", "provider": "auto"},
               "video": {"enabled": True, "id": self.VIDEO, "pattern": "smpte",
                         "overlayText": "", "frameWidth": 1296, "frameHeight": 720,
                         "grainRate": {"numerator": 30000, "denominator": 1001}},
               "audio": {"enabled": False, "id": self.AUDIO, "sampleRate": 48000,
                         "channelCount": 2}}
        code, res = agg.generator_create(req)
        self.assertEqual(code, 201)
        self.assertEqual([len(g["readers"]) for g in res["generators"]], [2, 2])
        writers = [b for b in self.posted if b["spec"]["className"] == agg.GEN_CLASS]
        readers = [b for b in self.posted if b["spec"]["className"] == agg.READER_CLASS]
        self.assertEqual(len(writers), 2)
        # Each reader reads the flow of the copy it belongs to, not the first one.
        for reader in readers:
            gen = reader["metadata"]["labels"][agg._READER_LABEL_GENERATOR]
            writer = next(w for w in writers if w["metadata"]["name"] == gen)
            self.assertEqual(reader["spec"]["parameters"]["flows"],
                             [writer["spec"]["parameters"]["flow"]["video_output"]["id"]])

    def test_zero_readers_on_the_form_books_none(self):
        req = {"label": "Bars", "ttl": "1h", "count": 1, "node": "",
               "readers": {"count": 0},
               "video": {"enabled": True, "id": self.VIDEO, "pattern": "smpte",
                         "overlayText": "", "frameWidth": 1296, "frameHeight": 720,
                         "grainRate": {"numerator": 30000, "denominator": 1001}},
               "audio": {"enabled": False}}
        code, res = agg.generator_create(req)
        self.assertEqual(code, 201)
        self.assertEqual(len(self.posted), 1)

    def test_deleting_a_generator_releases_its_readers_only(self):
        _, res = agg.reader_create(self.GEN, {"count": 2})
        for body in self.posted:
            self.claims[body["metadata"]["name"]] = body
        other = dict(self.posted[0], metadata=dict(self.posted[0]["metadata"],
                     name="generator-other-cd34-r0001",
                     labels=dict(self.posted[0]["metadata"]["labels"],
                                 **{agg._READER_LABEL_GENERATOR: "generator-other-cd34"})))
        self.claims[other["metadata"]["name"]] = other
        code, _ = agg.generator_delete(self.GEN)
        self.assertEqual(code, 200)
        self.assertEqual(sorted(self.deleted),
                         sorted([self.GEN] + [r["name"] for r in res["readers"]]))

    def test_a_reader_is_deleted_only_if_the_page_booked_it(self):
        _, res = agg.reader_create(self.GEN, {"count": 1})
        name = res["readers"][0]["name"]
        self.claims[name] = self.posted[0]
        code, _ = agg.reader_delete(name)
        self.assertEqual((code, self.deleted), (200, [name]))
        # The generator itself is not a reader, so this path cannot release it.
        code, _ = agg.reader_delete(self.GEN)
        self.assertEqual(code, 403)

    def test_the_listing_nests_readers_under_their_generator(self):
        _, res = agg.reader_create(self.GEN, {"count": 1})
        self.claims[res["readers"][0]["name"]] = self.posted[0]
        rows, _, orphans, err = agg._gen_list()
        self.assertIsNone(err)
        self.assertEqual([r["name"] for r in rows[0]["readers"]], [res["readers"][0]["name"]])
        self.assertEqual(orphans, [])

    def test_readers_of_a_vanished_generator_are_listed_as_orphans(self):
        _, res = agg.reader_create(self.GEN, {"count": 1})
        self.claims[res["readers"][0]["name"]] = self.posted[0]
        del self.claims[self.GEN]
        rows, standalone, orphans, _ = agg._gen_list()
        self.assertEqual(standalone, [])
        self.assertEqual(rows, [])
        self.assertEqual([r["name"] for r in orphans], [res["readers"][0]["name"]])

    def test_a_failed_reader_after_others_returns_what_was_booked(self):
        self.fail_at = 3
        code, res = agg.reader_create(self.GEN, {"count": 4})
        self.assertEqual(code, 201)
        self.assertEqual(len(res["readers"]), 2)
        self.assertIn("booked 2 of 4", res["error"])

    def test_a_reader_failure_on_the_form_says_how_far_the_booking_got(self):
        self.fail_at = 2
        req = {"label": "Bars", "ttl": "1h", "count": 3, "node": "",
               "readers": {"count": 1},
               "video": {"enabled": True, "id": self.VIDEO, "pattern": "smpte",
                         "overlayText": "", "frameWidth": 1296, "frameHeight": 720,
                         "grainRate": {"numerator": 30000, "denominator": 1001}},
               "audio": {"enabled": False}}
        code, res = agg.generator_create(req)
        self.assertEqual(code, 201)
        self.assertIn("booked 1 of 3", res["error"])

    def test_reader_names_stay_inside_a_label_value_and_the_prefix(self):
        long_gen = agg.GEN_PREFIX + "a" * 20 + "-ffff"
        self.claims[long_gen] = dict(self._generator(), metadata=dict(
            self._generator()["metadata"], name=long_gen))
        _, res = agg.reader_create(long_gen, {"count": 1})
        name = res["readers"][0]["name"]
        self.assertLessEqual(len(name), 63)
        self.assertTrue(name.startswith(agg.GEN_PREFIX))

    def test_reader_delete_refuses_a_chart_claim_and_a_foreign_name(self):
        self.claims["generator-bars-ab12-r0001"] = {
            "metadata": {"name": "generator-bars-ab12-r0001",
                         "labels": {agg._GEN_LABEL_MANAGED: "Helm",
                                    agg._GEN_LABEL_COMPONENT: "reader"}}}
        self.assertEqual(agg.reader_delete("generator-bars-ab12-r0001")[0], 403)
        self.assertEqual(agg.reader_delete("writer-mxl-1")[0], 400)
        self.assertEqual(self.deleted, [])

    def test_no_readers_for_a_generator_on_its_way_out(self):
        self.claims[self.GEN]["metadata"]["deletionTimestamp"] = "2026-10-19T12:00:00Z"
        code, _ = agg.reader_create(self.GEN, {"count": 1})
        self.assertEqual(code, 409)
        self.assertEqual(self.posted, [])

    def test_a_reader_left_behind_by_a_delete_is_reported(self):
        _, res = agg.reader_create(self.GEN, {"count": 1})
        reader = res["readers"][0]["name"]
        self.claims[reader] = self.posted[0]
        real = agg.k8s_json

        def refuse_reader(path, method="GET", body=None):
            if method == "DELETE" and path.endswith(reader):
                return 500, {"error": "apiserver said no"}
            return real(path, method, body)

        with mock.patch.object(agg, "k8s_json", refuse_reader):
            code, out = agg.generator_delete(self.GEN)
        self.assertEqual(code, 200)
        self.assertIn(reader, out["error"])


class FlowReaders(unittest.TestCase):
    """Readers of flows chosen by id, whoever writes them: a chart writer, an
    SRT ingest or a generator. They belong to no generator, so they carry no
    generator label, expire on their own and are listed on their own."""

    A = "d4d00000-0000-4000-8000-000000000001"
    B = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.posted = []
        self.claims = {}
        self.known = {self.A: "claim writer-mxl-1", self.B: "a flow the operator already knows"}

        def k8s_json(path, method="GET", body=None):
            self.posted.append(body)
            return 201, body

        def safe_k8s(path):
            if "labelSelector=" in path:
                selector = urllib.parse.unquote(path.split("labelSelector=", 1)[1])
                want = dict(kv.split("=", 1) for kv in selector.split(","))
                return {"items": [c for c in self.claims.values()
                                  if all((c["metadata"].get("labels") or {}).get(k) == v
                                         for k, v in want.items())]}
            return self.claims.get(path.rsplit("/", 1)[-1]) or {"_error": "404"}

        patches = [
            mock.patch.object(agg, "GEN_ENABLED", True),
            mock.patch.object(agg, "_flow_ids_in_use", lambda *a: (self.known, None)),
            mock.patch.object(agg, "redundancy_sets", lambda: ([], None)),
            mock.patch.object(agg, "k8s_json", k8s_json),
            mock.patch.object(agg, "safe_k8s", safe_k8s),
            mock.patch.object(agg, "snapshot_drop", lambda *a, **k: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_reads_exactly_the_chosen_flows(self):
        code, res = agg.flow_readers_create({"flows": [self.A, self.B], "count": 1})
        self.assertEqual(code, 201)
        self.assertEqual(self.posted[0]["spec"]["parameters"]["flows"], [self.A, self.B])
        self.assertNotIn(agg._READER_LABEL_GENERATOR, self.posted[0]["metadata"]["labels"])

    def test_names_fit_a_release_and_the_delete_guard(self):
        _, res = agg.flow_readers_create({"flows": [self.A], "count": 2,
                                          "label": "a very long label for the readers"})
        names = [b["metadata"]["name"] for b in self.posted]
        self.assertEqual(len(set(names)), 2)
        for name in names:
            self.assertTrue(name.startswith(agg.GEN_PREFIX + "r-"))
            self.assertLessEqual(len(name), 53)

    def test_refuses_a_name_helm_would_not_take_as_a_release(self):
        with mock.patch.object(agg, "GEN_PREFIX", "p" * 30 + "-"):
            code, res = agg.flow_readers_create({"flows": [self.A], "count": 1,
                                                 "label": "x" * 20})
        self.assertEqual(code, 502)
        self.assertIn("does not make a usable reader name", res["error"])
        self.assertEqual(self.posted, [])

    def test_refuses_a_label_or_expiry_that_is_not_text(self):
        for body, message in (({"label": 5}, "label must be text"),
                              ({"ttl": ["1h"]}, "expiry must be one of 1h, 8h, 24h, none")):
            code, res = agg.flow_readers_create(dict({"flows": [self.A], "count": 1}, **body))
            self.assertEqual((code, res["error"]), (400, message))

    def test_expires_on_its_own(self):
        agg.flow_readers_create({"flows": [self.A], "count": 1, "ttl": "8h"})
        self.assertIn("end", self.posted[0]["spec"]["booking"]["window"])
        self.posted.clear()
        agg.flow_readers_create({"flows": [self.A], "count": 1, "ttl": "none"})
        self.assertNotIn("window", self.posted[0]["spec"]["booking"])

    def test_refuses_a_flow_the_cluster_does_not_know(self):
        unknown = "11111111-1111-4111-8111-111111111111"
        code, res = agg.flow_readers_create({"flows": [self.A, unknown], "count": 1})
        self.assertEqual(code, 404)
        self.assertIn(unknown, res["error"])
        self.assertEqual(self.posted, [])

    def test_fails_closed_when_the_flows_cannot_be_listed(self):
        with mock.patch.object(agg, "_flow_ids_in_use", lambda *a: (None, "forbidden")):
            code, _ = agg.flow_readers_create({"flows": [self.A], "count": 1})
        self.assertEqual(code, 503)
        self.assertEqual(self.posted, [])

    def test_refuses_what_is_not_a_set_of_flow_ids(self):
        for flows, message in (([], "choose between 1 and 16 flows"),
                               ([self.A.upper()], "every flow id must be a full lowercase UUID"),
                               ([self.A, self.A], "a flow is chosen twice")):
            code, res = agg.flow_readers_create({"flows": flows, "count": 1})
            self.assertEqual((code, res["error"]), (400, message))
        self.assertEqual(self.posted, [])

    def test_listed_apart_from_generators_and_orphans(self):
        _, res = agg.flow_readers_create({"flows": [self.A], "count": 1})
        self.claims[res["readers"][0]["name"]] = self.posted[0]
        rows, standalone, orphans, err = agg._gen_list()
        self.assertEqual((rows, orphans, err), ([], [], None))
        self.assertEqual([r["name"] for r in standalone], [res["readers"][0]["name"]])

    def test_released_through_the_reader_delete(self):
        _, res = agg.flow_readers_create({"flows": [self.A], "count": 1})
        name = res["readers"][0]["name"]
        self.claims[name] = self.posted[0]
        with mock.patch.object(agg, "k8s_json", lambda *a, **k: (200, {})):
            self.assertEqual(agg.reader_delete(name)[0], 200)


class RedundancySets(unittest.TestCase):
    """MxlFlowRedundancySets: one output flow served from several members.

    The output has no MxlFlow. The gateway merges it on each node a reader
    wants it on, so the set and the members' MxlFlows are all there is to know
    it by.
    """

    A1 = "5fd00000-0000-4000-8000-0000000000a1"
    B1 = "5fd00000-0000-4000-8000-0000000000b1"
    C1 = "5fd00000-0000-4000-8000-0000000000c1"
    # The real listing, held before setUp patches it out.
    LIST = staticmethod(agg.redundancy_sets)

    @classmethod
    def rs(cls, name="p-show.video", members=(A1, B1), output=C1, domain=None,
           conditions=None):
        def ref(flow_id):
            return {"flowID": flow_id, **({"domain": domain} if domain else {})}

        return {
            "metadata": {"name": name, "generation": 2},
            "spec": {"members": [ref(m) for m in members], "output": ref(output),
                     "granularity": "Grain", "preference": "Ordered",
                     "skewBudget": "40ms"},
            "status": {"nodes": ["worker-1"], "observedGeneration": 2,
                       "conditions": conditions or [
                {"type": "Valid", "status": "True", "reason": "MembersAligned",
                 "message": "members agree in format, rate and geometry",
                 "observedGeneration": 2},
                {"type": "MembersReady", "status": "False", "reason": "MemberMissing",
                 "message": f"member {cls.A1} has no MxlFlow", "observedGeneration": 1},
            ]},
        }

    def setUp(self):
        self.sets = [self.rs()]
        self.flows = [video_flow(self.B1, 50)]
        patches = [
            mock.patch.object(agg, "redundancy_sets", lambda: (self.sets, None)),
            mock.patch.object(agg, "safe_k8s", self.safe_k8s),
            mock.patch.object(agg, "origin_leases", lambda: {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def safe_k8s(self, path):
        if path.endswith("/mxlflows"):
            return {"items": self.flows}
        return {"items": []}

    def test_lists_each_set_with_its_state_members_and_output(self):
        res = agg.operator_flows()
        self.assertEqual([f["id"] for f in res["flows"]], [self.B1])
        self.assertIsNone(res["setsError"])
        (row,) = res["sets"]
        self.assertEqual(row["name"], "p-show.video")
        self.assertEqual(row["members"], [self.A1, self.B1])
        self.assertEqual(row["nodes"], ["worker-1"])
        self.assertEqual((row["valid"]["status"], row["membersReady"]["status"]),
                         ("True", "False"))
        self.assertEqual(row["membersReady"]["message"], f"member {self.A1} has no MxlFlow")
        self.assertEqual(row["output"]["id"], self.C1)

    def test_marks_a_flow_outside_the_primary_domain(self):
        """The page cannot preview such a flow and has to know which it is."""
        other = video_flow("studio-x." + self.A1, 50)
        other["spec"]["domain"] = "studio-x"
        self.flows.append(other)
        rows = {f["id"]: f for f in agg.operator_flows()["flows"]}
        self.assertIsNone(rows[self.B1]["domain"])
        self.assertEqual(rows["studio-x." + self.A1]["domain"], "studio-x")
        self.assertTrue(rows[self.B1]["domainPreview"])
        self.assertFalse(rows["studio-x." + self.A1]["domainPreview"])
        with mock.patch.object(agg, "PREVIEW_DOMAINS", frozenset({"studio-x"})):
            rows = {f["id"]: f for f in agg.operator_flows()["flows"]}
        self.assertTrue(rows["studio-x." + self.A1]["domainPreview"],
                        "a flow in a domain the media server mounts previews")

    def test_carries_the_generation_each_condition_was_written_for(self):
        """A condition older than the spec says nothing about it; the page shows
        it as unknown, and needs both numbers to tell."""
        row = agg.operator_flows()["sets"][0]
        self.assertEqual((row["generation"], row["observedGeneration"]), (2, 2))
        self.assertEqual(row["valid"]["observedGeneration"], 2)
        self.assertEqual(row["membersReady"]["observedGeneration"], 1)

    def test_the_output_is_described_by_the_first_member_with_a_flow(self):
        """A1 has no MxlFlow, so B1 describes the output."""
        out = agg.operator_flows()["sets"][0]["output"]
        self.assertEqual((out["format"], out["resolution"], out["rate"]),
                         ("video", "1920x1080", "50/1"))
        self.assertIsNone(out["grouphint"])
        self.assertEqual(out["locations"], [{"node": "worker-1", "phase": "Wanted"}])

    def test_an_output_no_member_describes_says_nothing_about_its_media(self):
        self.flows = []
        out = agg.operator_flows()["sets"][0]["output"]
        self.assertIsNone(out["format"])

    def test_names_flows_in_another_domain_as_mxl_k8s_does(self):
        """<domain>.<id>, the MxlFlow name of a flow outside the primary
        domain. The operator refuses members outside the output's domain, so
        members and output share one."""
        self.sets = [self.rs(domain="studio")]
        self.flows = [video_flow("studio." + self.B1, 50), video_flow(self.A1, 25)]
        row = agg.operator_flows()["sets"][0]
        self.assertEqual(row["domain"], "studio")
        self.assertEqual(row["members"], ["studio." + self.A1, "studio." + self.B1])
        self.assertEqual(row["output"]["id"], "studio." + self.C1)
        # The primary-domain A1 is another flow; studio.B1 describes the output.
        self.assertEqual(row["output"]["rate"], "50/1")
        used, _ = agg._flow_ids_in_use()
        self.assertIn("studio." + self.C1, used)
        self.assertNotIn(self.C1, used)

    def test_a_cluster_without_the_resource_has_no_sets(self):
        """An mxl-k8s older than the CRD, or one installed with its CRDs
        skipped, has the API answer 404 for the resource: no sets, not a
        failure. Anything else is one."""
        def missing(path):
            raise urllib.error.HTTPError(path, 404, "Not Found", {}, io.BytesIO())

        def forbidden(path):
            raise urllib.error.HTTPError(path, 403, "Forbidden", {}, io.BytesIO())

        with mock.patch.object(agg, "k8s", missing):
            self.assertEqual(self.LIST(), ([], None))
        with mock.patch.object(agg, "k8s", forbidden):
            items, err = self.LIST()
        self.assertIsNone(items)
        self.assertIn("403", err)

    def test_a_listing_failure_is_reported_beside_the_flows(self):
        with mock.patch.object(agg, "redundancy_sets", lambda: (None, "forbidden")):
            res = agg.operator_flows()
        self.assertEqual((res["sets"], res["setsError"]), ([], "forbidden"))

    def test_the_output_previews_though_it_has_no_mxlflow(self):
        mtx = MtxRecorder()
        with mock.patch.object(agg, "_mtx", mtx), mock.patch.object(agg, "_idle_since", {}):
            code, res = agg.preview_add(self.C1)
        self.assertEqual(code, 200, res)
        self.assertEqual(mtx.added()["source"], f"mxl://{agg.MXL_DOMAIN}/{self.C1}")

    def test_an_output_nothing_describes_is_not_previewed(self):
        """Without a member's MxlFlow nothing says what the output carries."""
        self.flows = []
        mtx = MtxRecorder()
        with mock.patch.object(agg, "_mtx", mtx):
            code, _ = agg.preview_add(self.C1)
        self.assertEqual(code, 404)
        self.assertIsNone(mtx.added())

    def test_an_output_in_another_domain_is_not_previewed(self):
        """The media server reads the primary domain only."""
        self.sets = [self.rs(domain="studio")]
        self.flows = [video_flow("studio." + self.B1, 50)]
        mtx = MtxRecorder()
        with mock.patch.object(agg, "_mtx", mtx):
            code, _ = agg.preview_add(self.C1)
        self.assertEqual(code, 404)
        self.assertIsNone(mtx.added())

    def test_a_preview_404_says_when_the_sets_could_not_be_read(self):
        """Then the flow may be an output nobody could look up."""
        mtx = MtxRecorder()
        with mock.patch.object(agg, "redundancy_sets", lambda: (None, "forbidden")), \
                mock.patch.object(agg, "_mtx", mtx):
            code, res = agg.preview_add(self.C1)
        self.assertEqual((code, res["error"]), (404, "flow not known to the operator (forbidden)"))

    def test_the_output_id_is_taken(self):
        """A writer on the output's id would leave the set invalid, and a
        reader of it is a reader of a flow that exists."""
        used, err = agg._flow_ids_in_use()
        self.assertIsNone(err)
        self.assertEqual(used[self.C1], "redundancy set p-show.video")

    def test_the_flow_ids_fail_closed_when_the_sets_cannot_be_listed(self):
        with mock.patch.object(agg, "redundancy_sets", lambda: (None, "forbidden")):
            self.assertEqual(agg._flow_ids_in_use(), (None, "forbidden"))


class RedundancySetReaders(unittest.TestCase):
    """Readers booked against a set: its output, its members, or both."""

    A1 = RedundancySets.A1
    C1 = RedundancySets.C1

    def setUp(self):
        self.posted = []
        self.listings = 0

        def k8s_json(path, method="GET", body=None):
            self.posted.append(body)
            return 201, body

        def safe_k8s(path):
            if path.endswith("/mxlflows"):
                return {"items": [video_flow(self.A1)]}
            return {"items": []}

        def sets():
            self.listings += 1
            return (self.sets, None) if self.sets is not None else (None, "forbidden")

        self.sets = [RedundancySets.rs(members=(self.A1, RedundancySets.B1))]
        patches = [
            mock.patch.object(agg, "GEN_ENABLED", True),
            mock.patch.object(agg, "safe_k8s", safe_k8s),
            mock.patch.object(agg, "redundancy_sets", sets),
            mock.patch.object(agg, "k8s_json", k8s_json),
            mock.patch.object(agg, "snapshot_drop", lambda *a, **k: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def receiver(self):
        return self.posted[0]["spec"]["parameters"]["receiver"]

    def test_a_reader_of_the_output_books_no_receiver(self):
        """A receiver binds only to a flow with an MxlFlow and an Origin, which
        an output never has, so it would sit Pending for the whole booking."""
        code, _ = agg.flow_readers_create({"flows": [self.C1, self.A1], "count": 1})
        self.assertEqual(code, 201)
        self.assertEqual(self.posted[0]["spec"]["parameters"]["flows"], [self.C1, self.A1])
        self.assertIs(self.receiver()["enabled"], False)

    def test_a_reader_of_members_alone_keeps_its_receivers(self):
        agg.flow_readers_create({"flows": [self.A1], "count": 1, "provider": "tcp"})
        self.assertEqual(self.receiver(), {"provider": "tcp"})

    def test_lists_the_sets_once_per_booking(self):
        agg.flow_readers_create({"flows": [self.C1], "count": 1})
        self.assertEqual(self.listings, 1)

    def test_refuses_an_output_in_another_domain(self):
        """A reader reads the primary domain, and a bare id names a flow there,
        so the id of an output in another domain names nothing it can read."""
        self.sets = [RedundancySets.rs(domain="studio")]
        code, res = agg.flow_readers_create({"flows": [self.C1], "count": 1})
        self.assertEqual(code, 404)
        self.assertIn(self.C1, res["error"])
        self.assertEqual(self.posted, [])

    def test_fails_closed_when_the_sets_cannot_be_listed(self):
        self.sets = None
        code, _ = agg.flow_readers_create({"flows": [self.A1], "count": 1})
        self.assertEqual(code, 503)
        self.assertEqual(self.posted, [])


class ReaderDelivering(unittest.TestCase):
    """A reader's workload is ready once it serves, flows or not, so delivery
    is read from the endpoint its claim publishes."""

    def _claim(self, ready=True, url="http://r.ns:9102/delivering"):
        endpoints = [{"name": "metrics", "url": "http://r.ns:9102/metrics"}]
        if url:
            endpoints.append({"name": "delivering", "url": url})
        return {"status": {"handle": {"ready": ready, "endpoints": endpoints}}}

    def _answer(self, code):
        def open_(url, timeout=None):
            self.asked = url
            if code == 200:
                return mock.MagicMock(__enter__=lambda s: mock.Mock(status=200),
                                      __exit__=lambda *a: False)
            raise urllib.error.HTTPError(url, code, "", {}, None)
        return mock.patch.object(agg._probe_opener, "open", open_)

    def test_200_is_delivering(self):
        with self._answer(200):
            self.assertIs(agg._reader_delivering(self._claim()), True)
        self.assertEqual(self.asked, "http://r.ns:9102/delivering")

    def test_503_is_not_delivering(self):
        with self._answer(503):
            self.assertIs(agg._reader_delivering(self._claim()), False)

    def test_unknown_until_the_handle_is_ready_or_published(self):
        with self._answer(200):
            self.assertIsNone(agg._reader_delivering(self._claim(ready=False)))
            self.assertIsNone(agg._reader_delivering(self._claim(url=None)))


class RingLinks(unittest.TestCase):
    """A writer's or reader's ring page is linked only while it is up: the
    claim live and ready, the page routed, and its /healthz answering."""

    GEN = "generator-bars-ab12"
    READER = "generator-r-flow-00aa"
    EXTERNAL = "https://ring-generator-bars-ab12.example.test/"
    READER_EXTERNAL = "https://ring-generator-r-flow-00aa.example.test/"

    def _claim(self, name, component, external=EXTERNAL, ready=True, phase="Bound",
               end=None, deleting=False, url=None):
        ring = {"name": "ring", "url": url or f"http://{name}.ns:9102/", "api": "html"}
        if external:
            ring["externalUrl"] = external
        claim = {
            "metadata": {"name": name, "labels": {
                agg._GEN_LABEL_MANAGED: agg.GEN_MANAGER,
                agg._GEN_LABEL_COMPONENT: component}},
            "spec": {"booking": {"jobRef": "qutil/generators"}, "parameters": {}},
            "status": {"phase": phase, "handle": {"ready": ready, "endpoints": [ring]}},
        }
        if end:
            claim["spec"]["booking"]["window"] = {"end": end}
        if deleting:
            claim["metadata"]["deletionTimestamp"] = "2026-10-19T12:00:00Z"
        return claim

    def setUp(self):
        self.claims = {}
        self.probed = []
        self.answer = 200
        self.release = threading.Event()
        self.release.set()

        def safe_k8s(path):
            selector = urllib.parse.unquote(path.split("labelSelector=", 1)[1])
            want = dict(kv.split("=", 1) for kv in selector.split(","))
            return {"items": [c for c in self.claims.values()
                              if all(c["metadata"]["labels"].get(k) == v
                                     for k, v in want.items())]}

        def open_(url, timeout=None):
            if url.endswith("/delivering"):
                raise urllib.error.URLError("not under test")
            self.probed.append(url)
            self.release.wait(5)
            if self.answer is None:
                raise urllib.error.URLError("timed out")
            if self.answer >= 400:
                raise urllib.error.HTTPError(url, self.answer, "", {}, None)
            return mock.MagicMock(__enter__=lambda s: mock.Mock(status=self.answer),
                                  __exit__=lambda *a: False)

        patches = [
            mock.patch.object(agg, "safe_k8s", safe_k8s),
            mock.patch.object(agg._probe_opener, "open", open_),
            mock.patch.object(agg, "_ring_cache", {}),
            mock.patch.object(agg, "_ring_inflight", set()),
            mock.patch.object(agg, "_ring_listed", set()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.release.set)

    def _book(self, **kw):
        """A generator and a reader of chosen flows, both shaped by kw; the
        reader's route and url are its own unless kw names them."""
        self.claims[self.GEN] = self._claim(self.GEN, agg._GEN_COMPONENT, **kw)
        kw.setdefault("external", self.READER_EXTERNAL)
        kw.pop("url", None)
        self.claims[self.READER] = self._claim(self.READER, agg._READER_COMPONENT, **kw)

    def _settle(self):
        """Wait out the background refreshes a listing started."""
        deadline = time.monotonic() + 5
        while agg._ring_inflight and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertFalse(agg._ring_inflight)

    def _links(self):
        rows, standalone, _, err = agg._gen_list()
        self.assertIsNone(err)
        return rows[0]["ringUrl"], standalone[0]["ringUrl"]

    def _probe_then_list(self):
        """The first listing starts the probes; the next one reads them."""
        self._links()
        self._settle()
        return self._links()

    def _healthz(self):
        return [u for u in self.probed if u.endswith("/healthz")]

    def test_linked_while_routed_ready_and_answering(self):
        self._book()
        self.assertEqual(self._probe_then_list(), (self.EXTERNAL, self.READER_EXTERNAL))
        self.assertIn(f"http://{self.GEN}.ns:9102/healthz", self.probed)
        self.assertIn(f"http://{self.READER}.ns:9102/healthz", self.probed)

    def test_a_new_claim_links_one_rebuild_after_its_probe(self):
        self._book()
        self.assertEqual(self._links(), (None, None))
        self._settle()
        self.assertEqual(self._links(), (self.EXTERNAL, self.READER_EXTERNAL))

    def test_a_slow_probe_does_not_hold_the_listing(self):
        self.release.clear()
        self._book()
        started = time.monotonic()
        self.assertEqual(self._links(), (None, None))
        self.assertEqual(self._links(), (None, None))
        self.assertLess(time.monotonic() - started, 0.5)
        # Two listings, one probe per claim in flight.
        self.assertEqual(len(agg._ring_inflight), 2)
        self.release.set()
        self._settle()
        self.assertEqual(len(self._healthz()), 2)
        self.assertEqual(self._links()[0], self.EXTERNAL)

    def test_only_a_200_links(self):
        for answer in (200, 204, 302, 503, None):
            agg._ring_cache.clear()
            self.answer = answer
            self._book()
            want = (self.EXTERNAL, self.READER_EXTERNAL) if answer == 200 else (None, None)
            self.assertEqual(self._probe_then_list(), want, answer)

    def test_no_link_without_an_external_url(self):
        # The class published before routes shipped: the page shows plain names.
        self._book(external=None)
        self.assertEqual(self._probe_then_list(), (None, None))
        self.assertFalse(self._healthz())

    def test_no_link_once_expired_or_on_its_way_out(self):
        for kw in ({"phase": "Expired"}, {"phase": "Released"}, {"phase": "Failed"},
                   {"deleting": True}, {"ready": False},
                   {"end": "2026-01-01T00:00:00Z"}, {"end": "not a time"}):
            self._book(**kw)
            self.assertEqual(self._probe_then_list(), (None, None), kw)
        self.assertFalse(self._healthz())

    def test_a_future_window_still_links(self):
        self._book(end="2999-01-01T00:00:00Z")
        self.assertEqual(self._probe_then_list()[0], self.EXTERNAL)

    def test_refuses_an_external_url_that_is_not_http(self):
        self._book(external="javascript:alert(1)")
        self.assertEqual(self._probe_then_list(), (None, None))
        self.assertFalse(self._healthz())

    def test_refuses_an_internal_url_that_is_not_http(self):
        self._book(url="file:///etc/")
        self.assertEqual(self._probe_then_list()[0], None)
        self.assertNotIn("file:///healthz", self.probed)

    def test_probe_is_cached_across_listings(self):
        self._book()
        self._probe_then_list()
        for _ in range(5):
            self._links()
        self._settle()
        self.assertEqual(len(self._healthz()), 2)

    def test_a_url_change_within_the_ttl_probes_again(self):
        self._book()
        self.assertEqual(self._probe_then_list()[0], self.EXTERNAL)
        self.claims[self.GEN] = self._claim(self.GEN, agg._GEN_COMPONENT,
                                            url="http://elsewhere.ns:9102/")
        # The answer for the old url does not carry over to the new one.
        self.assertEqual(self._links()[0], None)
        self._settle()
        self.assertIn("http://elsewhere.ns:9102/healthz", self.probed)
        self.assertEqual(self._links()[0], self.EXTERNAL)

    def test_a_stale_answer_is_served_while_it_refreshes(self):
        self._book()
        self._probe_then_list()
        self.answer = None
        later = time.monotonic() + agg._RING_TTL + 1
        with mock.patch.object(agg.time, "monotonic", lambda: later):
            # Up a moment ago, so still linked while the refresh runs.
            self.assertEqual(self._links()[0], self.EXTERNAL)
            self._settle()
            self.assertEqual(self._links(), (None, None))
        self.assertEqual(len(self._healthz()), 4)

    def test_a_released_claim_leaves_the_cache(self):
        self._book()
        self._probe_then_list()
        del self.claims[self.READER]
        agg._gen_list()
        self.assertEqual(set(agg._ring_cache), {self.GEN})

    def test_a_probe_ending_after_release_is_not_cached(self):
        self.release.clear()
        self._book()
        self._links()
        del self.claims[self.READER]
        agg._gen_list()
        self.release.set()
        self._settle()
        self.assertEqual(set(agg._ring_cache), {self.GEN})


class ProbeStatus(unittest.TestCase):
    """A probe answers for the url a claim names, not for one it redirects to."""

    def setUp(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        self.hits = []
        hits = self.hits

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                if self.path == "/moved":
                    self.send_response(302)
                    self.send_header("Location", "/healthz")
                else:
                    self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def test_a_redirect_is_not_followed(self):
        self.assertEqual(agg._probe_status(self.base + "/moved", 1), 302)
        self.assertEqual(self.hits, ["/moved"])

    def test_a_direct_answer(self):
        self.assertEqual(agg._probe_status(self.base + "/healthz", 1), 200)

    def test_only_http_is_asked(self):
        self.assertIsNone(agg._probe_status("file:///etc/hostname", 1))


class GeneratorRatesAndMemory(unittest.TestCase):
    """UHD and rates up to 240/1, with memory sized from the grain ring.

    A writer's ring is grain rate x domain history grains and is held in the
    writer's own memory, so the fixed 1 GiB envelope OOM-kills a UHD or a
    high-rate writer as soon as its ring fills.
    """

    BASE = {"requests": {"cpu": "700m", "memory": "256Mi"},
            "limits": {"cpu": "2500m", "memory": "1Gi"}}

    def _req(self, w, h, num, den, audio=False):
        return {"label": "", "ttl": "1h", "count": 1, "node": "",
                "video": {"enabled": True, "id": "3f2c8a1e-1111-4222-8333-444455556666",
                          "pattern": "smpte", "overlayText": "", "frameWidth": w,
                          "frameHeight": h, "grainRate": {"numerator": num, "denominator": den}},
                "audio": {"enabled": audio, "id": "9b1d0000-2222-4333-8444-555566667777",
                          "sampleRate": 48000, "channelCount": 16}}

    def setUp(self):
        for p in (mock.patch.object(agg, "GEN_RESOURCES", self.BASE),
                  mock.patch.object(agg, "GEN_HISTORY_SECONDS", 2.0)):
            p.start()
            self.addCleanup(p.stop)

    def test_accepts_uhd_and_the_new_rates(self):
        for num in (30, 60, 120, 240):
            self.assertIsNone(agg._validate_generator(self._req(3840, 2160, num, 1)), num)

    def test_still_refuses_a_rate_off_the_list(self):
        self.assertIn("grain rate must be one of",
                      agg._validate_generator(self._req(1920, 1080, 100, 1)))

    def test_a_small_booking_keeps_the_configured_envelope(self):
        res = agg._gen_resources(self._req(1296, 720, 30000, 1001))
        self.assertEqual(res, self.BASE)

    def test_uhd_at_60_reserves_its_ring(self):
        # 3840 / 48 * 128 bytes a row, 2160 rows, 120 grains in 2s, plus 64 MiB.
        need = 10240 * 2160 * 120 + (64 << 20)
        res = agg._gen_resources(self._req(3840, 2160, 60, 1))
        self.assertGreaterEqual(agg._bytes(res["requests"]["memory"]), need)
        self.assertGreaterEqual(agg._bytes(res["limits"]["memory"]), int(need * 1.25))
        # CPU is left as configured: the ring decides memory, not cores.
        self.assertEqual(res["requests"]["cpu"], "700m")

    def test_the_configured_envelope_is_not_mutated(self):
        agg._gen_resources(self._req(3840, 2160, 240, 1))
        self.assertEqual(agg.GEN_RESOURCES["limits"]["memory"], "1Gi")

    def test_a_domain_without_history_keeps_ten_grains_at_any_rate(self):
        with mock.patch.object(agg, "GEN_HISTORY_SECONDS", 0.0):
            fast = agg._gen_memory_bytes(self._req(3840, 2160, 240, 1))
            slow = agg._gen_memory_bytes(self._req(3840, 2160, 30, 1))
        self.assertEqual(fast, slow)
        self.assertEqual(fast, 10240 * 2160 * 10 + (64 << 20))

    def test_audio_adds_its_own_ring(self):
        self.assertGreater(agg._gen_memory_bytes(self._req(1296, 720, 25, 1, audio=True)),
                           agg._gen_memory_bytes(self._req(1296, 720, 25, 1)))

    def test_the_claim_carries_the_sized_resources(self):
        claim = agg._gen_claim("generator-x-0001", self._req(3840, 2160, 60, 1))
        self.assertGreater(agg._bytes(claim["spec"]["parameters"]["resources"]["limits"]["memory"]),
                           1 << 30)

    def test_reads_the_quantities_a_values_file_writes(self):
        self.assertEqual(agg._bytes("1Gi"), 1 << 30)
        self.assertEqual(agg._bytes("256Mi"), 256 << 20)
        self.assertEqual(agg._bytes("1.5Gi"), 3 << 29)
        self.assertEqual(agg._bytes("500M"), 500 * 10 ** 6)
        self.assertEqual(agg._bytes(None), 0)


class AncReader(unittest.TestCase):
    """The ANC reader is a booked function, reached through its claim.

    Data flows have no transport to a browser, so the card is handed decoded
    packets instead. Where they come from is the claim's business: an address
    compiled into the aggregator would assume a namespace this app does not own.
    """

    def setUp(self):
        # _resolve_base memoises a hit, so a test that did not clear it would
        # answer from whatever ran before it.
        with agg._endpoint_lock:
            agg._endpoint_cache.clear()
        self.addCleanup(self._clear)

    def _clear(self):
        with agg._endpoint_lock:
            agg._endpoint_cache.clear()

    def test_reads_the_grain_from_the_endpoint_the_claim_publishes(self):
        seen = {}

        def http_json(base, path, method="GET", body=None):
            seen["base"], seen["path"] = base, path
            return 200, {"flow": "x", "ancCount": 1}

        with mock.patch.object(agg, "_claim_endpoint",
                               lambda *a: "http://anc-reader.prod:8080"), \
                mock.patch.object(agg, "_http_json", http_json):
            code, _ = agg.anc_grain("a0d30000-0000-4000-8000-000000000001")

        self.assertEqual(code, 200)
        self.assertEqual(seen["base"], "http://anc-reader.prod:8080")
        self.assertEqual(
            seen["path"], "/grain?flow=a0d30000-0000-4000-8000-000000000001")

    def test_looks_the_claim_up_by_the_configured_name_and_class(self):
        asked = []

        with mock.patch.object(agg, "_claim_endpoint",
                               lambda *a: asked.append(a) or None):
            agg.anc_grain("a0d30000-0000-4000-8000-000000000001")

        # The endpoint name the class publishes is "anc".
        self.assertEqual(asked, [(agg.ANC_READER_CLAIM, agg.ANC_READER_CLASS,
                                  "anc")])

    def test_says_no_reader_is_booked_rather_than_failing_the_lookup(self):
        """An install with no reader claim is a normal state, not a fault."""
        with mock.patch.object(agg, "_claim_endpoint", lambda *a: None):
            code, body = agg.anc_grain("a0d30000-0000-4000-8000-000000000001")

        self.assertEqual(code, 503)
        self.assertIn("ANC reader", body["error"])

    def test_an_explicit_address_wins_over_the_claim(self):
        """The port-forwarded dev loop, where no claim is reachable at all."""
        seen = {}

        def http_json(base, path, method="GET", body=None):
            seen["base"] = base
            return 200, {}

        def fail(*_a):
            raise AssertionError("resolved a claim despite the override")

        with mock.patch.object(agg, "ANC_PREVIEW_API", "http://127.0.0.1:8080"), \
                mock.patch.object(agg, "_claim_endpoint", fail), \
                mock.patch.object(agg, "_http_json", http_json):
            agg.anc_grain("a0d30000-0000-4000-8000-000000000001")

        self.assertEqual(seen["base"], "http://127.0.0.1:8080")

    def test_rejects_a_malformed_flow_id_before_asking_anything(self):
        def fail(*_a):
            raise AssertionError("resolved a claim for a bad flow id")

        with mock.patch.object(agg, "_claim_endpoint", fail):
            code, _ = agg.anc_grain("not-a-uuid")
        self.assertEqual(code, 400)


class Snapshot(unittest.TestCase):
    """One answer per polled endpoint, shared by everyone asking for it.

    Every panel poll used to redo the whole job -- the same lists, the same
    700 KiB of MxlFlowMirror status, the same JSON -- so the work followed the
    number of open tabs. Enough tabs and requests arrived faster than they
    retired, and the pod died of the threads that piled up.
    """

    def setUp(self):
        self.addCleanup(self._clear)
        self._clear()

    def _clear(self):
        with agg._snapshot_guard:
            agg._snapshots.clear()

    def test_builds_once_for_repeated_callers(self):
        calls = []
        produce = lambda: calls.append(1) or {"n": len(calls)}

        first = agg.snapshot("k", produce)
        second = agg.snapshot("k", produce)

        self.assertEqual(len(calls), 1)
        self.assertEqual(first, second)
        self.assertEqual(json.loads(first), {"n": 1})

    def test_rebuilds_once_the_snapshot_is_stale(self):
        """Bounded staleness is the whole trade: a panel must still move."""
        calls = []
        produce = lambda: calls.append(1) or {"n": len(calls)}

        with mock.patch.object(agg, "_SNAPSHOT_TTL", 0.0):
            agg.snapshot("k", produce)
            agg.snapshot("k", produce)

        self.assertEqual(len(calls), 2)

    def test_keys_do_not_share_an_answer(self):
        agg.snapshot("a", lambda: {"which": "a"})
        self.assertEqual(json.loads(agg.snapshot("b", lambda: {"which": "b"})),
                         {"which": "b"})
        self.assertEqual(json.loads(agg.snapshot("a", lambda: {"which": "!"})),
                         {"which": "a"})

    def test_callers_arriving_mid_build_wait_rather_than_start_another(self):
        """The case that matters: four tabs whose polls land together."""
        started, release = threading.Event(), threading.Event()
        calls = []

        def produce():
            calls.append(1)
            started.set()
            release.wait(5)
            return {"n": len(calls)}

        bodies = []
        threads = [threading.Thread(target=lambda: bodies.append(
            agg.snapshot("k", produce))) for _ in range(4)]
        threads[0].start()
        self.assertTrue(started.wait(5))
        for t in threads[1:]:
            t.start()
        release.set()
        for t in threads:
            t.join(5)

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(bodies), 4)
        self.assertEqual(len(set(bodies)), 1)

    def test_dropping_one_forces_the_next_caller_to_rebuild(self):
        """A booking just made has to be in the list the operator is looking at."""
        calls = []
        produce = lambda: calls.append(1) or {"n": len(calls)}

        agg.snapshot("generators", produce)
        agg.snapshot_drop("generators")
        agg.snapshot("generators", produce)

        self.assertEqual(len(calls), 2)


def get(path, wfile=None):
    """Drive one GET through the real handler, without a socket.

    The handler writes to whatever `wfile` it is given, so a BytesIO stands in
    for the client and a raising one stands in for a client that hung up.
    Returns (status, parsed body), or (None, None) where the fake client never
    received the response.
    """
    handler = agg.H.__new__(agg.H)
    handler.path = path
    handler.requestline = f"GET {path} HTTP/1.1"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("test", 0)
    handler.wfile = io.BytesIO() if wfile is None else wfile
    handler.do_GET()

    if not isinstance(handler.wfile, io.BytesIO):
        return None, None
    head, _, body = handler.wfile.getvalue().partition(b"\r\n\r\n")
    status = int(head.split(b"\r\n", 1)[0].split()[1])
    return status, (json.loads(body) if body else None)


class ServedFromTheSnapshot(unittest.TestCase):
    """The polled routes answer from the snapshot, not from a fresh build."""

    def setUp(self):
        self.addCleanup(self._clear)
        self._clear()

    def _clear(self):
        with agg._snapshot_guard:
            agg._snapshots.clear()

    def test_two_polls_of_a_route_cost_one_build(self):
        calls = []
        with mock.patch.object(agg, "build", lambda: calls.append(1) or {"flows": []}):
            first = get("/api/flows")
            second = get("/api/flows")

        self.assertEqual(len(calls), 1)
        self.assertEqual(first, (200, {"flows": []}))
        self.assertEqual(second, first)

    def test_each_route_has_its_own_snapshot(self):
        with mock.patch.object(agg, "build", lambda: {"which": "flows"}), \
                mock.patch.object(agg, "operator_flows", lambda: {"which": "operator"}):
            self.assertEqual(get("/api/flows")[1], {"which": "flows"})
            self.assertEqual(get("/api/operator-flows")[1], {"which": "operator"})

    def test_a_failed_build_is_reported_and_not_remembered(self):
        """Holding a 500 for a second would outlast the blip that caused it."""
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("apiserver said no")
            return {"flows": []}

        with mock.patch.object(agg, "build", flaky):
            self.assertEqual(get("/api/flows")[0], 500)
            self.assertEqual(get("/api/flows"), (200, {"flows": []}))


class InFlightCeiling(unittest.TestCase):
    """Past the ceiling a poll is refused, because queueing it killed the pod.

    The UI drops a request the moment the next tick fires, but the thread
    serving it runs to completion regardless, so an aggregator slower than the
    poll interval gained a thread per tick until it reached its memory limit.
    """

    def setUp(self):
        self.addCleanup(self._clear)
        self._clear()

    def _clear(self):
        with agg._snapshot_guard:
            agg._snapshots.clear()

    def test_refuses_a_poll_once_the_ceiling_is_reached(self):
        full = threading.BoundedSemaphore(1)
        full.acquire()
        with mock.patch.object(agg, "_inflight", full), \
                mock.patch.object(agg, "build", lambda: {"flows": []}):
            code, body = get("/api/flows")

        self.assertEqual(code, 503)
        self.assertIn("in flight", body["error"])

    def test_still_answers_the_health_probe_while_refusing_polls(self):
        """A liveness probe failing here restarts the pod the ceiling saved."""
        full = threading.BoundedSemaphore(1)
        full.acquire()
        with mock.patch.object(agg, "_inflight", full):
            self.assertEqual(get("/healthz"), (200, {"ok": True}))

    def test_releases_its_slot_when_a_route_raises(self):
        """A slot leaked per failure would shrink the ceiling to nothing."""
        one = threading.BoundedSemaphore(1)
        with mock.patch.object(agg, "_inflight", one), \
                mock.patch.object(agg, "build",
                                  mock.Mock(side_effect=RuntimeError("boom"))):
            self.assertEqual(get("/api/flows")[0], 500)
            self.assertEqual(get("/api/flows")[0], 500)


class ClientHangUp(unittest.TestCase):
    """A poll the browser abandoned is a normal end, not an error.

    switchMap drops the request as the next tick fires and the socket closes
    under the write. Left to propagate it printed a traceback per occurrence,
    which under the load that caused it cost more than the request had.
    """

    def setUp(self):
        with agg._snapshot_guard:
            agg._snapshots.clear()

    def test_a_closed_socket_does_not_raise(self):
        class Hangup(io.RawIOBase):
            def write(self, _b):
                raise BrokenPipeError(32, "Broken pipe")

        with mock.patch.object(agg, "build", lambda: {"flows": []}):
            get("/api/flows", wfile=Hangup())

    def test_a_reset_connection_does_not_raise_either(self):
        class Reset(io.RawIOBase):
            def write(self, _b):
                raise ConnectionResetError(104, "Connection reset by peer")

        with mock.patch.object(agg, "build", lambda: {"flows": []}):
            get("/api/flows", wfile=Reset())


if __name__ == "__main__":
    unittest.main()


class ServiceEndpoints(unittest.TestCase):
    """What a booked function publishes, as the page shows it.

    externalUrl is the address a person opens. Most classes publish none: a
    class carries one only where it names the resource its chart applies, so
    the key is absent rather than empty, and the page must not turn the
    in-cluster url into a link to fill the gap.
    """

    @staticmethod
    def _claim(endpoints, ready=True):
        return {"status": {"handle": {"ready": ready, "endpoints": endpoints}}}

    def test_carries_the_external_address_through(self):
        claim = self._claim([
            {"name": "ui", "url": "https://mcm.p-demo:443", "api": "https",
             "externalUrl": "https://mcm-p-demo.dmf.example.com"},
        ])
        with mock.patch.object(agg, "safe_k8s", lambda *a, **k: claim):
            got = agg.service_endpoints("mcm", "mcm")

        self.assertEqual(got, [{
            "name": "ui",
            "url": "https://mcm.p-demo:443",
            "api": "https",
            "externalUrl": "https://mcm-p-demo.dmf.example.com",
        }])

    def test_omits_the_key_where_the_class_publishes_none(self):
        claim = self._claim([{"name": "rtsp", "url": "rtsp://mtx.p-demo:8554"}])
        with mock.patch.object(agg, "safe_k8s", lambda *a, **k: claim):
            got = agg.service_endpoints("mediamtx", "mediamtx")

        self.assertNotIn("externalUrl", got[0])

    def test_publishes_nothing_until_the_handle_is_ready(self):
        claim = self._claim([{"name": "ui", "url": "https://mcm.p-demo:443",
                              "externalUrl": "https://mcm.example.com"}],
                            ready=False)
        with mock.patch.object(agg, "safe_k8s", lambda *a, **k: claim):
            self.assertEqual(agg.service_endpoints("mcm", "mcm"), [])


class BookedServices(unittest.TestCase):
    """The panel lists what is reachable, not what was configured.

    A booking the release did not make, or whose handle is not ready, has
    nothing to offer a reader. Listing it with no endpoints would read as a
    fault rather than as an absence, so it is left out entirely.
    """

    def test_omits_a_function_that_published_nothing(self):
        def endpoints(claim_name, class_name):
            if class_name == "mcm":
                return [{"name": "ui", "url": "https://mcm.p-demo:443",
                         "externalUrl": "https://mcm-p-demo.dmf.example.com"}]
            return []

        with mock.patch.object(agg, "service_endpoints", endpoints):
            got = agg.booked_services()

        self.assertEqual([s["claim"] for s in got], ["mcm"])

    def test_lists_every_booking_that_published_something(self):
        with mock.patch.object(
                agg, "service_endpoints",
                lambda c, k: [{"name": "x", "url": f"http://{k}:1"}]):
            got = agg.booked_services()

        self.assertEqual(len(got), 4)
        # An internal-only booking still appears; it just carries no link.
        self.assertNotIn("externalUrl", got[1]["endpoints"][0])

    def test_names_the_class_when_no_claim_name_is_configured(self):
        with mock.patch.object(agg, "MCM_CLAIM", ""), \
                mock.patch.object(
                    agg, "service_endpoints",
                    lambda c, k: [{"name": "ui", "url": "u"}] if k == "mcm" else []):
            got = agg.booked_services()

        self.assertEqual(got[0]["claim"], "mcm")
