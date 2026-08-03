# dmf-app-qutil - working rules

The Qvest DMF and MXL utility app: an Angular multiviewer and a metrics
aggregator, shipped as one Helm chart and one image on one release version.
It books the media functions it consumes and implements none of them.

## STOP. Use a git worktree.

Before ANY mutation of this repository -- edit, write, commit, branch create,
push, `gh pr create` -- set up a dedicated worktree first. No change is small
enough to skip it; parallel sessions in one tree corrupt staging state and
lose work.

Worktrees live under `<repo>/.claude/worktrees/`, nowhere else.

```sh
git fetch origin
id=$(openssl rand -hex 4)
git worktree add .claude/worktrees/<topic>-$id -b <topic> origin/main
```

The main checkout is read-only: `git log`, `git diff`, `git status`, reading
files, grep. Anything touching the index, the working tree, the branch list or
the remote happens in the worktree.

## Boundaries

- **This repo builds no media function.** mediamtx is `dmf-mf-mediamtx`, the
  compositor is `dmf-mf-mxl-compositor`, the writers are `dmf-mf-mxl-writer`.
  Their charts and catalog entries live in `dmf-catalog`. Never recreate a
  function chart, a `MediaFunctionClass`, or a function image here.
- What belongs here: the UI, the aggregator, and the claims that book what
  they consume.
- **Nothing static describes a flow.** A tile asks mediamtx for a path when it
  opens and releases it when it closes, over the mediamtx HTTP API. A static
  per-flow path in a config file is a regression: changing one restarts the
  server, and a claim's parameters do not take effect on a bound claim at all.
- Reach a booked function through the endpoints its claim publishes
  (`status.handle.endpoints`), never through a hardcoded Service name. The
  namespace a booking lands in is not this app's to assume.
- Configuring a function over its API is this app's job. Writing `Configured`
  or `Connected` conditions onto a claim is not; those belong to an element
  manager the lifecycle plane defines.

## Releases

One release-please package covers the repository. The chart version, the image
tag and the release version are the same string: the chart publishes with
`--app-version` set to the release version and the image tag is left empty, so
the deployment resolves the image at the chart's own version. Splitting them
into separate release-please components produces one tag per component and
breaks that.

## Voice

- Terse. Say the thing, stop. No preamble, no recap, no restating the task.
- No filler adjectives (robust, seamless, comprehensive, production-grade).
- Comments explain *why*, not *what*. Delete comments that restate the code.
- Revalidate docs and comments as a whole rather than appending to them.
  Remove stale references, cluster names and addresses, and guesses about
  downstream use.
- Write declarative facts. No personal pronouns, no addressing a reader.
- Don't narrate what was tried first or what failed.
- ASCII only, including commit messages and PR descriptions. No em-dash, no
  typographic quotes, no emoji.
- Conventional commits, imperative, subject <= 72 chars, body wrapped at 72.
  The type decides the bump; the scope names the area. Breaking changes get
  `!` or a `BREAKING CHANGE:` footer.
- A PR title is the squash subject on main and follows the same rules.
- No ticket numbers in code, commits or docs.
- No `Co-Authored-By` trailers, no checklists, no "Summary" sections.

## Before finish

`helm lint charts/*`, `hack/check-render.py charts/qutil` and the UI test suite
pass. No hardcoded Service address for a booked function. No static per-flow
path anywhere.

`helm lint` alone is not enough: it accepts a duplicated mapping key, and the
post-renderer Flux installs through refuses the document. That is what
`check-render.py` catches.
