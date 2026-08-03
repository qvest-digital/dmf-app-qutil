#!/usr/bin/env python3
"""Render the chart under several value sets and reject duplicate mapping keys.

`helm lint` and `helm template` both accept a duplicated mapping key and keep
the last one. Flux installs through a kustomize post-renderer that refuses the
document instead, so a chart that templates cleanly can still fail to install
with `mapping key ... already defined`. Duplicating a label out of a shared
labels helper is the easy way to write one.

Usage: hack/check-render.py charts/qutil
"""
import subprocess
import sys
import tempfile

import yaml


class Strict(yaml.SafeLoader):
    pass


def reject_duplicates(loader, node, deep=False):
    seen = []
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(f"duplicate key {key!r}")
        seen.append(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)


Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, reject_duplicates)

# Required values plus one case per toggle that changes which objects render.
BASE = {
    "production": {"namespace": "production-demo-app"},
    "ingress": {"hostname": "demo.example"},
}
CASES = {
    "defaults": {},
    "no-pull-secret": {"imagePullSecret": {"enabled": False}},
    "no-test-sources": {"testSources": {"enabled": False}},
    "no-bookings": {
        "mediamtx": {"enabled": False},
        "compositor": {"enabled": False},
        "writers": {"enabled": False},
    },
    "no-ingress": {"ingress": {"enabled": False, "hostname": "demo.example"}},
    "no-audio-writer": {"writers": {"audio": {"enabled": False}}},
}


def render(chart, values):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as fh:
        yaml.safe_dump({**BASE, **values}, fh)
        fh.flush()
        return subprocess.run(
            ["helm", "template", "qutil", chart, "--namespace", "demo-app", "-f", fh.name],
            capture_output=True,
            text=True,
        )


def main(chart):
    failed = False
    for name, values in CASES.items():
        proc = render(chart, values)
        if proc.returncode != 0:
            print(f"FAIL {name}: helm template: {proc.stderr.strip().splitlines()[-1]}")
            failed = True
            continue
        objects = 0
        for doc in proc.stdout.split("\n---\n"):
            if not doc.strip():
                continue
            source = next((l for l in doc.splitlines() if l.startswith("# Source:")), "?")
            try:
                obj = yaml.load(doc, Loader=Strict)
            except yaml.YAMLError as exc:
                print(f"FAIL {name}: {source}: {exc}")
                failed = True
                continue
            if obj:
                objects += 1
        if not failed:
            print(f"ok {name}: {objects} objects")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "charts/qutil"))
