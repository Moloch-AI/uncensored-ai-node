# Releasing

A release is a GitHub release with a tag `vX.Y.Z`; the
[release workflow](.github/workflows/release.yml) does the rest. The package is meant for npm
under the name `molochai`. The owner publishes the first registry version by hand; from the
second one on, only GitHub Actions publishes.

## Status: not on npm yet

`molochai` has not been published to the npm registry, and nobody holds that name for us. Until
it is published, the README installs from GitHub
(`npm install github:Moloch-AI/uncensored-ai-node#vX.Y.Z`) and tells readers not to run
`npm install molochai`. If someone else registered the name first, an npm install instruction
would send users to a stranger's package, in a project that holds their API key. So the
README switches to `npm install molochai` only in the change that makes the first registry
publish, and that change is pushed only after the publish succeeded
([step 1](#1-publish-the-first-registry-version-by-hand-with-the-readme-switch)).

## What the release workflow does

Publishing a GitHub release starts three jobs:

| Job | Permissions | What it does |
|---|---|---|
| Check, build and pack | `contents: read` | Fails unless the tag is `v` + the `version` in `package.json`. Runs `npm ci`, biome, `tsc`, the unit tests with coverage, the integration tests against the mock server and the build. Packs the package once and checks that tarball with publint and Are the Types Wrong (attw). |
| Attach the tarball to the release | `contents: write` | Uploads the `.tgz` to the GitHub release. |
| Publish to npm | `id-token: write`, environment `npm` | Only when the repository variable `PUBLISH_TO_NPM` is `true`. Publishes the same `.tgz` with `npm publish --provenance --access public` through npm trusted publishing (OIDC): no npm token is stored anywhere. A GitHub pre-release goes to the `next` dist-tag instead of `latest`. |

Run by hand (Actions → Release → Run workflow), it only runs the first job: a full dry run that
publishes and uploads nothing.

The tarball holds 22 files: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md` and
`dist/` (`client`, `core`, `errors`, `helpers`, `index`, `sse`, `streaming`, `types` and
`version`, each as `.js` and `.d.ts`). `npm pack --dry-run` prints the list.

## One-time setup

npm has no "pending publisher": a trusted publisher can only be configured for a package that
already exists. So the first version is published by hand, and CI publishes from the next one.

### 1. Publish the first registry version by hand, with the README switch

`X.Y.Z` below is the first version that goes to npm: 0.1.1 if the tag `v0.1.1` does not exist
yet, otherwise the next patch version. You need the npm account that will own the package,
with two-factor authentication on, and Node 20 or newer.

Publish first and push afterwards, so that no pushed README ever points at an npm name we do
not hold yet.

1. In a fresh clone of `main`, make one commit with all of these:
   - if `X.Y.Z` is a new version, the version change from [Each release](#each-release),
     step 1;
   - `README.md`: replace the Installation section with the text below, which makes
     `npm install molochai` the instruction and keeps the GitHub install as the alternative;
   - `RELEASING.md`: replace the "Status: not on npm yet" section with one sentence saying that
     the package is on npm as `molochai` from `X.Y.Z` on;
   - `CHANGELOG.md`, under `X.Y.Z`: "First version on the npm registry. The README now installs
     with `npm install molochai`."

   The new Installation section:

   ````markdown
   ## Installation

   ```bash
   npm install molochai
   ```

   To install a release tag straight from GitHub instead:

   ```bash
   npm install github:Moloch-AI/uncensored-ai-node#vX.Y.Z
   ```

   npm then clones the repository, installs its build tools and runs the `prepare` script,
   which compiles `dist/`. This takes longer than a registry install.
   ````

2. Tag that commit locally and publish from a clean checkout of the tag. Nothing is pushed yet:

   ```bash
   git clone https://github.com/Moloch-AI/uncensored-ai-node.git molochai-release
   cd molochai-release
   # make and commit the changes from step 1, then:
   git tag -a vX.Y.Z -m vX.Y.Z
   git checkout vX.Y.Z
   git status --short        # must print nothing
   npm ci                    # installs the dev tools; `prepare` builds dist/
   npm run check             # biome, tsc, tests, build, publint, attw
   npm pack --dry-run        # compare the file list with the one above
   npm login
   npm publish --access public
   npm logout
   ```

   CI has not seen this commit yet, so you may also run the integration tests against the mock
   server first ([CONTRIBUTING.md](CONTRIBUTING.md)). `npm publish` runs `prepare` again, so it
   publishes a fresh build, and it asks for a one-time password when 2FA is on for writes. Do
   not add `--provenance`: npm can only create provenance in CI, so this one version has none.
   `npm logout` revokes the session token that `npm login` created.
3. Check that `npm view molochai version` prints `X.Y.Z` and that
   `https://www.npmjs.com/package/molochai` shows this README.
4. Only now push the commit and the tag, and create the GitHub release from the existing tag:

   ```bash
   git checkout main
   git push origin main vX.Y.Z
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md
   ```

   With `PUBLISH_TO_NPM` unset, the release workflow checks the tag, attaches the tarball and
   publishes nothing.

If anything fails before `npm publish` succeeds, nothing has left your machine: delete the
local tag (`git tag -d vX.Y.Z`), fix the problem and repeat step 2. If npm refuses the name
because someone else already holds `molochai`, do not push the commit; see
[the scoped alternative](#alternative-a-scoped-name-under-an-npm-organization).

### 2. Create the GitHub environment and variable

- **Environment `npm`**: Settings → Environments → New environment → `npm`. Under
  "Deployment branches and tags", choose "Selected branches and tags" and add a rule of type
  Tag with the pattern `v*`, so only release tags can publish. Recommended: under "Required
  reviewers", add yourself; every npm publish then waits for your approval in the workflow run.
  The environment needs no secrets.
- **Variable `PUBLISH_TO_NPM`**: Settings → Secrets and variables → Actions → Variables → New
  repository variable, name `PUBLISH_TO_NPM`, value `true`. While it is unset (or anything but
  `true`), releases still get the checks and the attached tarball, and nothing is published.
  Set it together with step 3: a release published while it is `true` but no trusted publisher
  exists fails at the publish step.

### 3. Configure the trusted publisher on npmjs.com

Do this when the version after `X.Y.Z` is ready to release, because of the expiry below.

On npmjs.com, open the package `molochai` → Settings → Trusted Publisher → GitHub Actions, and
enter:

| Field | Value |
|---|---|
| Organization or user | `Moloch-AI` |
| Repository | `uncensored-ai-node` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

A new trusted-publisher configuration must make its first successful publish within 2 days, or
it expires and can no longer be used or edited. Configure it, set `PUBLISH_TO_NPM`, and publish
the GitHub release for that version within those 2 days. If it expired, delete it on npmjs.com,
create it again, and publish within 2 days.

Trusted publishing needs npm CLI 11.5.1 or newer and Node 22.14.0 or newer. The publish job
runs Node 24 and installs npm 11.21.2 if the bundled npm is older than 11.5.1. npm also checks
that `repository.url` in `package.json` matches the GitHub repository; it does
(`git+https://github.com/Moloch-AI/uncensored-ai-node.git`).

### 4. After the first publish from CI

- Check the provenance as described in [Verify provenance](#verify-provenance).
- npmjs.com → the package → Settings → Publishing access → select "Require two-factor
  authentication and disallow tokens". Trusted publishing keeps working; tokens can no longer
  publish.
- npmjs.com → Access Tokens: revoke any token you no longer need.

## Each release

1. Set the version, for example 0.1.2:

   ```bash
   npm version 0.1.2 --no-git-tag-version   # package.json and package-lock.json
   ```

   Then set `VERSION` in `src/version.ts` to the same value (a unit test fails if they differ),
   move the "Unreleased" notes in `CHANGELOG.md` under `## [0.1.2] - YYYY-MM-DD`, and update
   the tag in the GitHub install command in `README.md`.
2. Run `npm run check`, commit, push to `main`, and wait for CI to pass.
3. Create the GitHub release: Releases → Draft a new release → Choose a tag → type `v0.1.2`
   ("Create new tag on publish", target `main`) → title `v0.1.2` → paste the CHANGELOG notes →
   Publish release. With the GitHub CLI:
   `gh release create v0.1.2 --target main --title v0.1.2 --notes-file notes.md`.
4. Watch Actions → Release. If the environment has required reviewers, approve the publish job.
5. Verify the result as below.

If the tag check fails, nothing was published: delete the release and the tag
(`git push --delete origin v0.1.2`), fix the version, and release again. npm never accepts the
same version twice, so if a version did publish, fix forward with a new patch version.

## Verify provenance

For a version that the workflow published (0.1.2 in these examples; the first registry
version, published by hand, has no provenance):

- The page `https://www.npmjs.com/package/molochai/v/0.1.2` has a Provenance section that links
  to the source commit, `release.yml` and the workflow run.
- `npm view molochai@0.1.2 dist.attestations` prints the attestation URL and
  `predicateType: 'https://slsa.dev/provenance/v1'`. Empty output means no provenance.
- In a project that installed it, `npm audit signatures` reports verified registry signatures
  and verified attestations.
- The registry has the same bytes as the GitHub release asset, because the workflow publishes
  the file it attached. These two lines must be equal:

  ```bash
  gh release download v0.1.2 --repo Moloch-AI/uncensored-ai-node --pattern '*.tgz'
  echo "sha512-$(openssl dgst -sha512 -binary molochai-0.1.2.tgz | openssl base64 -A)"
  npm view molochai@0.1.2 dist.integrity
  ```

## Alternative: a scoped name under an npm organization

If you prefer the package under an organization (for example `@molochai/sdk`) instead of the
unscoped `molochai`:

1. On npmjs.com, create the organization `molochai` (Add Organization; the free plan covers
   public packages). Its scope is `@molochai`.
2. Change the repository:
   - `package.json`: `"name": "@molochai/sdk"`, and add `"publishConfig": { "access": "public" }`
     (scoped packages are private by default; this keeps a manual `npm publish` public).
   - Every place that imports the package by name: `"molochai"` becomes `"@molochai/sdk"` in
     `README.md` (the install command and every `import ... from "molochai"`), the five files
     in `examples/`, the `paths` entry in `tsconfig.json`, and the `ERR_REQUIRE_ESM` row in the
     README's Troubleshooting table.
   - This file: `molochai` becomes `@molochai/sdk` in the npm commands and URLs (for example
     `npm view @molochai/sdk@0.1.2 dist.attestations` and
     `https://www.npmjs.com/package/@molochai/sdk`); the tarball is named
     `molochai-sdk-<version>.tgz`.
   - A CHANGELOG entry that says the package name changed.
   - Nothing changes in `src/` (the `User-Agent` stays `molochai-node/<version>`), in the tests,
     or in `release.yml`, which reads the name from `package.json`.
3. Publish the first version by hand as a member of the organization with publish rights,
   following [step 1](#1-publish-the-first-registry-version-by-hand-with-the-readme-switch)
   with `@molochai/sdk` in place of `molochai` (the README switch then says
   `npm install @molochai/sdk`). Then configure the trusted publisher in that package's settings
   with the same four values as above.

npm does not hold the unscoped name `molochai` for you; anyone can publish it while it is free.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The publish job does not run | `PUBLISH_TO_NPM` is not exactly `true`, or the run was started by hand. |
| The publish job waits | The `npm` environment requires a reviewer: approve it in the run. |
| The publish job cannot start: environment protection rules | The `npm` environment allows only tags `v*`; the release tag must match. |
| `npm publish` fails with an authentication error (`ENEEDAUTH`, 401 or 404) | No trusted publisher, it expired, or one of its four values differs from this repository (the workflow filename is `release.yml`, the environment `npm`). |
| npm rejects the provenance because of the repository | `repository.url` in `package.json` must match `https://github.com/Moloch-AI/uncensored-ai-node`. |
| `You cannot publish over the previously published versions` | That version is on npm already. Release a new version. |
| The first `npm publish` is refused with 403 for `molochai` | Someone else holds the name. Do not push the README switch; use the scoped alternative. |
