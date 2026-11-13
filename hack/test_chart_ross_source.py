"""The standing Ross source muxes one PES packet per AAC frame.

ffmpeg's mpegts muxer otherwise fills an audio PES up to 2930 bytes, which at
128 kb/s is about 180 ms of audio in one packet. A receiver can only present
video against the newest audio it holds, so every frame waits for the next
burst: up to 180 ms of added latency and A/V jitter on a source that exists to
be measured against.
"""

import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/qutil"
VALUES = {
    "production": {"namespace": "p-demo"},
    "ingress": {"hostname": "demo.example"},
    "rossSource": {"enabled": True},
}


def ffmpeg_args():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as fh:
        yaml.safe_dump(VALUES, fh)
        fh.flush()
        proc = subprocess.run(
            ["helm", "template", "qutil", str(CHART),
             "--namespace", "demo-app", "-f", fh.name],
            capture_output=True, text=True, check=True,
        )
    docs = [d for d in yaml.safe_load_all(proc.stdout) if d]
    (deploy,) = [d for d in docs if d["kind"] == "Deployment"
                 and d["metadata"]["name"] == "ross-source"]
    (container,) = deploy["spec"]["template"]["spec"]["containers"]
    script = container["args"][0].replace("\\\n", " ")
    (line,) = [ln for ln in script.splitlines() if "ffmpeg " in ln]
    return shlex.split(line)


class RossSourceAudioPESTest(unittest.TestCase):
    def test_one_pes_per_audio_frame(self):
        args = ffmpeg_args()
        self.assertIn("-c:a", args)
        self.assertIn("-pes_payload_size", args)
        self.assertEqual(args[args.index("-pes_payload_size") + 1], "0")

    def test_option_applies_to_the_mpegts_output(self):
        """A muxer option after the output URL is a trailing option ffmpeg
        ignores."""
        args = ffmpeg_args()
        self.assertLess(args.index("-pes_payload_size"),
                        len(args) - 1 - args[::-1].index("-f"))


if __name__ == "__main__":
    unittest.main()
