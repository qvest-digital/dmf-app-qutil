# Contributor notes (Claude and humans)

Rules for working in this repository. Read them before opening a PR or
running an automated assistant against this tree.

This repo is the MXL DMF demo: writer pods produce uncompressed v210
flows into an MXL domain, mxl-k8s bridges them across nodes over EFA
RDMA, mediamtx and a C++/GStreamer compositor consume them zero-copy,
and a single-file browser multiviewer plays the result.
`docs/architecture.md` explains every component; `README.md` is the
60-second story. The rules here keep changes consistent with them.

## STOP. Use a git worktree.

Before ANY mutation of this repository -- edit, write, commit,
branch create, push, rebase, `gh pr create` -- the very first
action of the session is to set up a dedicated `git worktree`.
This rule has no exceptions. There is no change small enough to
skip it: typos, single-line fixes, doc-only PRs, even edits to
this file itself all require the same worktree dance.

The repository is worked on by multiple parallel sessions and
editors at once, and more than one clone of it exists on the same
machine. Two writers in the same tree corrupt staging state, step
on each other's branches, and lose work without warning -- the
rule exists to make that physically impossible, not to be polite
about it.

Worktrees ALWAYS live under `<repo>/.claude/worktrees/`. Not next
to the repo, not in `/tmp`, not anywhere else -- that path is the
project's established convention and the location the harness
manages.

The preferred path is to delegate the mutation to a sub-agent
with `isolation: "worktree"` on the Agent call. The harness then
creates `<repo>/.claude/worktrees/agent-<id>/` automatically with
a unique id, so two concurrent sub-agents never share a path. Do
not assume a worktree from earlier in the session is still
mounted.

For a manual worktree (no sub-agent), pick a short random tag so
two sessions on the same topic never collide:

```sh
git fetch origin
id=$(openssl rand -hex 4)
git worktree add .claude/worktrees/<topic>-$id -b <topic> origin/main
cd .claude/worktrees/<topic>-$id
```

All subsequent edits, commits, and pushes happen from the
worktree.

The only thing allowed in the main checkout is read-only
inspection: `git log`, `git diff`, `git status`, `gh pr view`,
reading files, grep / find. Anything that touches the index, the
working tree, the branch list, or the remote is out.

When the PR has merged, drop the worktree, the local branch, and
the now-stale remote tracking ref:

```sh
git worktree remove .claude/worktrees/<topic>-<id>
git branch -D <topic>
git fetch --prune origin
```

Sub-agent worktrees clean themselves up; the teardown block above
is for the manual `git worktree add` case.

## The cluster is downstream of git

`k8s/` is the deliverable. CI renders it and pushes it as an OCI
artifact (`ghcr.io/qvest-digital/mxl-dmf-demo-app-manifests`) that
Flux reconciles; a change is live only after merge, artifact push
and reconcile. There is no `kubectl apply -f k8s/` path and no
local compose stack.

- Change the cluster through git: branch, PR, merge, let Flux
  reconcile. `kubectl` is for reading and verifying -- `get`,
  `describe`, `logs`, `port-forward`. `kubectl edit`, `patch`,
  `apply`, `scale`, and `delete` against demo objects are out;
  Flux reverts them and the diff is lost.
- Get explicit approval before merging a PR, before anything that
  touches a live cluster, and before any other hard-to-reverse
  action.
- Nothing in CI validates the manifests. A broken kustomization
  surfaces only as a Flux reconcile failure on the cluster, so run
  `kustomize build k8s/` locally on every change under `k8s/`
  before opening the PR.

## Repository layout

| Path | Contents |
| --- | --- |
| `compositor/` | C++17/GStreamer compositor (`src/main.cpp`) plus vendored mxl headers under `vendor/mxl/`. Built by `build-compositor.yml` into a GHCR image. |
| `k8s/` | The deployed manifests, `config/` (mediamtx config, Caddyfile, `index.html`), and `metrics/aggregator.py`. Rendered by kustomize, pushed as an OCI artifact. |
| `docs/` | `architecture.md` (component deep-dive), `ci-and-release.md` (pipelines, tags, Renovate). |
| `.github/` | The two build workflows and the release-please config. |

Constraints that bite when ignored:

- `k8s/kustomization.yaml` mounts `config/` and `metrics/` through
  `configMapGenerator`. The hash suffix is what forces a rolling
  restart when a config file changes -- don't replace the
  generators with static ConfigMaps, and don't move a file out of
  `config/` without updating the generator.
- Anything that copies `k8s/` must copy the whole tree, not a flat
  `*.yaml` glob. Dropping `config/` makes kustomize fail inside
  Flux with a missing-file error.
- `compositor/vendor/mxl/` holds upstream libmxl headers verbatim.
  Don't hand-edit them; the runtime `libmxl.so` comes from the
  `go-mxl-runtime` base image and must match.
- `k8s/metrics/aggregator.py` is mounted from a ConfigMap and runs
  on stock `python:3.12-slim`. Standard library only -- no
  `requirements.txt`, no pip install, no second module.
- `k8s/config/index.html` is a single file with no build step and
  no bundler; `hls.js` from a CDN is the only external
  dependency. Keep it that way.
- Flow identity follows the `d4d00000-…-00000000000n` scheme,
  where `n` is the tile index. Adding or renaming a flow touches
  five places at once: `writer-deployment.yaml`, the compositor's
  `MXL_FLOW_IDS`, the mediamtx path in `config/mediamtx.yml`, the
  tile in `config/index.html`, and `metrics/aggregator.py`.

## Load-bearing runtime constraints

Two constraints are architectural. Breaking them produces silent
runtime failure, not a build error. `docs/architecture.md` §8 has
the full rationale.

- **go-mxl lock-step.** `ARG GO_MXL_TAG` in
  `compositor/Dockerfile.mxlk8s` must equal the tag the deployed
  mxl-k8s gateway was built from. A mismatch makes cross-node
  mirror reads return garbage or `FLOW_INVALID`. Renovate opens
  the bump as a `deps(compositor)` PR; merge it only once the
  gateway is on the same tag. Never hand-bump it to make a build
  pass.
- **mediamtx must be the qvest fork.** `ghcr.io/qvest-digital/
  mediamtx-mxl` carries the MXL static-source plugin and producer
  pacing. Upstream mediamtx has neither, so the four per-flow
  paths in `config/mediamtx.yml` stop resolving.

Two frontend behaviours are also load-bearing, both of them fixes
for observed breakage: the `MV` registry's `visibilitychange`
teardown (background WebRTC decode otherwise starves other
applications on the machine) and the `window.__mvDebug.counts()`
hook that makes the teardown verifiable from the console. Don't
drop either while refactoring the player code.

## Documentation

- Keep `README.md`, `docs/`, and code comments tight. State facts;
  don't speculate.
- Don't invent behaviour. If you can't verify it by reading the
  manifests, `main.cpp`, `aggregator.py`, `index.html`, or the
  libmxl headers, leave it out.
- Treat comments and docs as a whole rather than appending to
  them. Revalidate the surrounding text and remove what went
  stale: superseded observations, narration of the incident that
  motivated a past change, and named real clusters or hostnames.
- Don't add SPDX headers or copyright lines to new files unless
  you're preserving existing ones from an external source.

## Branches and PRs

- Direct commits to `main` are off by default. Every change opens
  a feature branch and a PR against `main`. Commit directly to
  `main` only when the maintainer has explicitly approved it for
  that specific change.
- Force-pushes are off by default. Force-pushing to `main` is
  prohibited. Force-pushing to a feature branch is only permitted
  with explicit approval, because another editor may be reviewing
  the branch or checked out against it.
- Merge PRs with **Squash and merge**. release-please derives the
  version bump and changelog from the resulting single commit on
  `main`, and a merge of dozens of intermediate commits would bury
  the release-relevant ones. (Older history contains merge
  commits; that is not the pattern to copy.)
- Delete the feature branch on the remote as soon as the PR is
  merged. Stale remote branches confuse the next contributor's
  `git fetch` and inflate `git branch -r` output.
- A PR touching `k8s/**` builds a `pr-<N>`-tagged manifests
  artifact that a terraform PR environment can point at. Assume a
  reviewer may be running against it before merge.

### Squash commit format for release-please

GitHub's squash-merge uses the PR title as the resulting commit
subject (with the PR number appended) and the PR body as the
commit body. release-please parses that commit on `main`. Two
consequences:

1. **PR title is Conventional Commits.** Write it in
   `<type>(<scope>): <subject>` form just as if it were a single
   commit subject. Subject `<= 72` chars, imperative mood.
2. **Multiple release-relevant changes go in the PR body, at the
   bottom, one per line.** release-please reads additional
   conventional-commit footer lines and emits one changelog entry
   per line. Add them after the prose, separated by a blank line:

   ```
   fix(multiviewer): tear down players when the tab goes hidden

   Background WebRTC decode kept running after visibilitychange and
   starved other applications. The MV registry now closes every
   PeerConnection and hls.js instance and rebuilds only the active
   scene on return.

   fix(metrics): report sourceNode for locally read flows
   ```

## Commits

- Use Conventional Commits with a scope naming the area changed.
  Canonical scopes: `compositor`, `k8s`, `mediamtx`,
  `multiviewer`, `metrics`, `ci`. History contains synonyms
  (`frontend`, `ui`, `viewer`, `demo`) -- don't add more.
- Renovate's go-mxl bumps use `deps(compositor)`; leave that type
  in place, the changelog has a "Dependencies" section for it.
- `docs`, `style`, and `test` commits are collected but hidden
  from the published changelog.
- Breaking changes get `!` (`feat(k8s)!: …`) or a
  `BREAKING CHANGE:` footer.
- Subject line ≤ 72 chars, imperative mood ("add", "fix", not
  "added", "fixes"). Body wraps at 72.
- Prefer small, focused commits.

### Message content

A commit message documents why a change exists, in terms that stay
useful when read alone, years later, by someone with no memory of
the work that produced it. The same rules apply to PR
descriptions.

- Explain *why*. The diff shows *what*; don't restate it.
- Stay scoped to this repository and this change. No speculation
  about upstream, downstream, future work, or follow-ups. If
  something was deliberately left out of the diff, name it and the
  reason -- only when that omission matters for understanding the
  present change.
- Reference another repository or project only when its state is
  the direct reason for the change (a go-mxl bump, a gateway
  version the compositor must match, a fork the image is pinned
  to). Context for reviewers, gratitude, or cross-linking belongs
  in the PR thread or an issue, not the commit.
- Write declarative facts. No personal pronouns ("I", "we",
  "you"). Don't address a reader: no "note that…", "as you can
  see…", "we decided to…", "this should help…".
- Don't narrate. No history of what was tried first, what failed,
  or what alternatives were considered.
- No filler verbs without specifics. "Clean up", "improve",
  "refactor" alone tell nothing; either name the actual change or
  drop the line.
- No checklists, "Summary" / "Test plan" sections, marketing
  phrasing, or emojis. Those belong in the PR description if
  anywhere.
- No tool-authored `Co-Authored-By:` trailers -- the message
  describes the change, not the process that produced it.
- Cross-reference an issue or PR only when its content is itself
  the reason for the change (`closes #N` where the issue is the
  why). Vague "see #N for context" pointers do not belong here.

## Versioning and tags

- Releases are a `1.0.0-rc.N` pre-release series managed by
  release-please (`release-type: simple`, `prerelease-type: rc`,
  `include-v-in-tag: true`). Merging the release PR bumps
  `.github/release-please-manifest.json`, updates `CHANGELOG.md`,
  cuts a `v*` tag and publishes a GitHub release.
- The `v*` tag triggers the manifests build; the published release
  triggers the compositor build, which tags the image with the
  version minus the leading `v`.
- Don't hand-tag, hand-bump the manifest, or hand-edit
  `CHANGELOG.md` -- let the workflow do it.

## Verifying a change

There is no unit test suite; nothing here is covered by an
automated assertion. Verification is manual and specific to what
was touched:

- Manifests: `kustomize build k8s/` must succeed and its diff must
  be the intended one.
- Compositor: build the image locally
  (`docker build -f compositor/Dockerfile.mxlk8s compositor/`). It
  compiles with `-Wall -Wextra -Wpedantic`; warnings are signal.
- Aggregator: `python3 -m py_compile k8s/metrics/aggregator.py`
  catches syntax breakage without a cluster. Endpoint behaviour
  needs a running cluster.
- Frontend: `window.__mvDebug.counts()` returns `{pc, hls}` and
  both must read zero while the tab is hidden.
- Never claim a runtime behaviour works without having watched it
  work. Reading the manifest is not evidence that Flux reconciled
  it.

## When in doubt

Ask the maintainer before changing the flow UUID scheme, the
mediamtx image or its fork, the pinned `GO_MXL_TAG`, the OCI
artifact repository or tagging scheme, or the release strategy.
When a request leaves scope, cluster, or intent open, put the
question to the user before implementing. When asked for a plan,
deliver the plan and stop.
