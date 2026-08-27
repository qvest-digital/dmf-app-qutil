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


class JoinedPreview(unittest.TestCase):
    """One path carrying a video flow and an audio flow together.

    Picture and sound are separate flows and nothing downstream rejoins them,
    so a card that wants both names both.
    """

    VIDEO = "b2000000-0000-0000-0000-000000000001"
    AUDIO = "aea7b9e9-1e5b-4333-9ac4-8689053a77de"

    def setUp(self):
        self.mtx = MtxRecorder()
        self.flows = {self.VIDEO: video_flow(self.VIDEO), self.AUDIO: audio_flow(self.AUDIO)}
        patches = [
            mock.patch.object(agg, "_mtx", self.mtx),
            mock.patch.object(agg, "_known_flow", lambda u: self.flows.get(u)),
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
        other = "b2000000-0000-0000-0000-000000000002"
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
        other = "b2000000-0000-0000-0000-000000000002"
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

    def test_a_different_pair_moves_it(self):
        self.mtx.existing.add(f"preview-{self.UUID}")
        self.mtx.configs[f"preview-{self.UUID}"] = {"mxlAudioChannels": "1,2"}
        agg.preview_add(self.UUID, channels="7,8")
        replaces = [c for c in self.mtx.calls if "/paths/replace/" in c[0]]
        self.assertEqual(len(replaces), 1)
        self.assertEqual(replaces[0][2]["mxlAudioChannels"], "7,8")

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

    VIDEO = "b2000000-0000-0000-0000-000000000001"
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
            code, res = agg.preview_del("b2000000-0000-0000-0000-000000000001")
        self.assertEqual(code, 200)
        self.assertEqual(mtx.deleted, [])

    def test_still_rejects_a_malformed_flow_id(self):
        code, _ = agg.preview_del("not-a-uuid")
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
