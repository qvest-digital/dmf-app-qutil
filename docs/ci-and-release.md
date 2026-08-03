# CI and Release

## 1. Build outputs

Two, and they carry the same version:

1. **The Helm chart** under `charts/`, published as an OCI artifact. It renders
   the app and the `MediaFunctionClaim`s that book what the app consumes.
2. **The multiviewer image**, the Angular app in `ui/` built to static files
   and served by Caddy.

No media function image is built here. Each is built and released by the
repository that owns its sources, and deployed by a chart in the DMF catalog.

## 2. One version for both

The chart version, the image tag and the release version are the same string.

The mechanism: the chart is packaged with `--app-version` set to the release
version, and `image.tag` is left empty in values, so the deployment's
`{{ .Values.image.tag | default .Chart.AppVersion }}` resolves the image at
exactly the chart's own version. Nothing has to keep two numbers in step
because there is only one.

`Chart.yaml` carries `# x-release-please-version` on both `version` and
`appVersion`, and the `extra-files` entry names `type: generic`. The type is
not optional decoration: a bare path string makes release-please infer an
updater from the extension, and the `yaml` updater reformats the document,
strips every comment (the markers with them) and moves `version` alone. The
generic updater replaces the first version on each annotated line and leaves
the rest of the file untouched.

The published artifact survives that either way, because the packaging step
passes `--version` and `--app-version` explicitly. What breaks is a render
straight from a checkout, which resolves an image one release behind.

The other way to break the shared version: declaring more than one
release-please package. With `separate-pull-requests`, multiple components
produce one release PR and one tag *per component*, so there is no single
version left to share. Use one package.

## 3. Releases

release-please reads conventional commits and opens a release PR. Merging it
bumps the version, updates `CHANGELOG.md`, tags, and publishes a GitHub
release. The tag is what triggers publishing.

That last step depends on `RELEASE_PLEASE_TOKEN`. A tag pushed with the
default `GITHUB_TOKEN` starts no further workflow, so the publish would never
fire. The token needs `contents: write` and `pull_requests: write` on this
repository.

Changelog sections follow the conventional-commit type: `feat`, `fix`, `deps`,
`perf`, `revert`, `refactor`, `build`, `ci` and `chore` are visible; `docs`,
`style` and `test` are collected but hidden.

## 4. Chart checks

`helm lint` runs on every pull request, and `hack/check-render.py` renders the
chart under one value set per toggle and parses the result strictly.

The second one exists because helm accepts a duplicated mapping key and keeps
the last, while the post-renderer Flux installs through refuses the document.
A chart that lints and templates cleanly can therefore still fail to install
with `mapping key ... already defined`. Repeating a label that the shared
labels helper already sets is the easy way to write one.

## 5. Dependency automation

Renovate runs on `config:recommended`. `minimumReleaseAge: 3 days` keeps a
just-published version out until it has settled. `prHourlyLimit: 0` removes the
rate limit; the option defaults to 2, so it has to be set rather than omitted.

The one third-party image the chart runs is pinned by digest in chart values
and carries no marker, so nothing bumps it automatically.

The `go-mxl` version is not managed here. MXL's domain protocol requires every
reader and writer sharing a domain to link a byte-identical `libmxl.so`, so a
function image's `go-mxl` tag and the tag the mxl-k8s gateway was built from
have to match. That constraint is held in the repository that builds the
image, where a bump can be checked against what it links.
