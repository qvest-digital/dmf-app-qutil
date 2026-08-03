# CI and Release

## 1. Build outputs

Two, and they carry the same version:

1. **The Helm chart** under `charts/`, published as an OCI artifact. It renders
   the app and the `MediaFunctionClaim`s that book what the app consumes.
2. **The multiviewer image**, the Angular app in `ui/` built to static files
   and served by Caddy.

No media function image is built here. Each is built and released by the
repository that owns its sources, and deployed by a chart in the DMF catalog.

A rendered `k8s/` OCI manifest artifact is also published, for consumers that
reconcile the manifest tree rather than the chart.

## 2. One version for both

The chart version, the image tag and the release version are the same string.

The mechanism: the chart is packaged with `--app-version` set to the release
version, and `image.tag` is left empty in values, so the deployment's
`{{ .Values.image.tag | default .Chart.AppVersion }}` resolves the image at
exactly the chart's own version. Nothing has to keep two numbers in step
because there is only one.

Two ways to break it, both silent:

- Declaring more than one release-please package. With
  `separate-pull-requests`, multiple components produce one release PR and one
  tag *per component*, so there is no single version left to share. Use one
  package.
- Expecting a generic `extra-files` entry to bump `Chart.yaml`. Only
  `release-type: helm` or an `# x-release-please-version` marker in the file
  moves a chart version.

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

## 4. Dependency automation

Renovate manages image pins carrying an inline marker:

```yaml
# renovate: datasource=<datasource> depName=<depName> [versioning=<versioning>]
image: "<image>:<currentValue>"
```

`minimumReleaseAge: 3 days` and `prHourlyLimit: 2` keep the noise down.

The `go-mxl` version is not managed here. MXL's domain protocol requires every
reader and writer sharing a domain to link a byte-identical `libmxl.so`, so a
function image's `go-mxl` tag and the tag the mxl-k8s gateway was built from
have to match. That constraint is held in the repository that builds the
image, where a bump can be checked against what it links.
