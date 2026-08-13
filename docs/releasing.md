# Publishing RecallNest

RecallNest publishes to the public npm registry from `.github/workflows/publish.yml` using npm Trusted Publishing and GitHub Actions OIDC. The workflow does not use an `NPM_TOKEN`, does not create GitHub Releases, and only publishes stable `vX.Y.Z` tags that point to commits reachable from `main`.

## One-time account setup

Complete these settings before pushing the first release tag.

### GitHub environment

1. Open **Settings → Environments → New environment** in `AliceLJY/recallnest`.
2. Name the environment exactly `npm-publish`.
3. Under **Deployment branches and tags**, select **Selected branches and tags** and add the tag rule `v*`.
4. Add the repository maintainer as the required reviewer.
5. Leave **Prevent self-review** disabled so the sole maintainer can approve a release they initiated.
6. Disable administrator bypass for the environment if the setting is available.
7. Do not add environment secrets or variables.
8. Confirm **Settings → Actions → General → Workflow permissions** remains read-only. The workflow grants only its two explicit job-level permission sets.

### npm Trusted Publisher

1. Sign in to npmjs.com with the account that has write access to `recallnest` and has 2FA enabled.
2. Open the `recallnest` package **Settings** page.
3. Confirm that no unknown Trusted Publisher is already configured. Do not overwrite an existing publisher until its owner and use are understood.
4. Add a **GitHub Actions** Trusted Publisher with these exact values:

   - Organization or user: `AliceLJY`
   - Repository: `recallnest`
   - Workflow filename: `publish.yml`
   - Environment name: `npm-publish`
   - Allowed actions: `npm publish` only

5. Save the configuration with the required interactive 2FA confirmation, then reopen it and verify every case-sensitive field.
6. Do not create a granular access token or add an npm secret to GitHub.

After the first successful OIDC release and provenance check, the maintainer may separately choose **Require two-factor authentication and disallow tokens** under npm **Publishing access**. Make that policy change only after Trusted Publishing has been proven by a real required release; it does not disable OIDC.

## No-publish validation

After a workflow change reaches `main`, run the positive preview:

```bash
gh workflow run publish.yml --ref main -f publish=false
```

The `verify` job must pass and the `publish` job must be skipped. The preview runs the frozen install, doctor, complete test suite, tracked-credential scan, package-content check, TypeScript build, and `npm pack --dry-run --ignore-scripts`. It does not request an OIDC token or publish a package.

The tag guard can be tested without creating a tag:

```bash
gh workflow run publish.yml --ref main -f publish=true
```

This run must fail in `Verify immutable release input` because `main` is not a tag. The publish job must not start or enter the `npm-publish` environment.

Do not create a placeholder version or tag to test OIDC. npm does not provide a complete no-publish check for a Trusted Publisher claim; the first required release is the final integration proof.

## Normal release

1. Update `package.json`, `.claude-plugin/marketplace.json`, user-facing release notes, and every other version surface required by the repository contracts.
2. Run the local verification commands:

   ```bash
   bun install --frozen-lockfile
   LOCAL_MEMORY_CONFIG=config.json.example bun run src/cli.ts doctor --ci
   bun test
   npm run test:tracked
   npm run test:package
   bun build src/cli.ts --target bun --outdir /tmp/ts-check
   npm pack --dry-run --ignore-scripts
   ```

3. Commit and push `main`, then wait for the exact commit's `CI` workflow to pass.
4. Reconfirm that the working tree is clean and local `main` equals `origin/main`.
5. Create the lightweight stable version tag on that commit and push only that tag:

   ```bash
   set -euo pipefail
   git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
   test -z "$(git status --porcelain)"
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
   VERSION="$(node -p "require('./package.json').version")"
   test "$(node -p "require('./.claude-plugin/marketplace.json').plugins[0].version")" = "${VERSION}"
   git merge-base --is-ancestor HEAD origin/main
   git tag "v${VERSION}"
   git push origin "v${VERSION}"
   ```

6. Wait for the publish workflow's verify job, review the immutable version/commit shown by the run, and approve the `npm-publish` environment.
7. After npm accepts the package, verify all of the following before creating a GitHub Release:

   - `recallnest@X.Y.Z` is publicly readable.
   - The `latest` dist-tag equals `X.Y.Z`.
   - npm displays provenance linked to `AliceLJY/recallnest`, `publish.yml`, and the exact tagged commit.
   - A clean install reports `X.Y.Z` for both `recallnest --version` and `local-memory --version`.
   - `npm audit signatures` does not report an invalid signature or attestation.

8. Create the GitHub Release manually from the same tag, using reviewed release notes. Do not create the Release before npm and provenance verification succeed.

Never move or force-update a pushed version tag. If the tagged content is wrong, fix it on `main` and release a new version.

## Failure recovery

### Failure before npm accepts the package

Test, tag, ancestry, and environment failures do not change npm. A transient job failure can be rerun on the same tag.

If npm clearly rejects the publish and the version is not visible in the public registry, correct external npm or GitHub environment configuration and dispatch the same tag again:

```bash
gh workflow run publish.yml --ref vX.Y.Z -f publish=true
```

The recovery still requires environment approval. If the error is in the workflow stored in that tag, a fix committed only to `main` will not change the old tag's workflow. Do not move the tag; use a new version after fixing the workflow, or design a separately reviewed rescue workflow.

### Ambiguous npm result

Query the public registry before retrying. If `name@version` exists, treat npm as having accepted it and do not publish it again, even if a later verification step failed. Continue by checking `latest`, package contents, and provenance. If provenance is missing, record the release as already published and repair the process in the next version; the same npm version cannot be republished to add provenance.

If the version is definitely absent, npm status is healthy, and the tagged input is still correct, rerun the workflow on the same tag. A registry `404` alone cannot prove that a version was never published and unpublished, so never build an automatic retry loop around it.

### npm succeeds but the GitHub Release fails

Do not rerun npm publishing. Create or repair the GitHub Release manually from the existing immutable tag.

### A GitHub Release was published too early

If npm is absent but the tag is correct, recover npm with the workflow dispatch command above. If the tag content is wrong, return the Release to draft and use a new version and tag:

```bash
gh release edit vX.Y.Z --draft
```

## Interactive emergency fallback

Prefer OIDC recovery. Use a local interactive publish only when GitHub Actions or OIDC is unavailable and the release cannot wait. This fallback has no GitHub Actions provenance.

1. Fetch the immutable tag into a clean checkout, prove that it is reachable from `main`, and repeat every verification command from the normal release process:

   ```bash
   set -euo pipefail
   TAG='vX.Y.Z'
   git fetch origin "refs/tags/${TAG}:refs/tags/${TAG}"
   git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
   git switch --detach "${TAG}"
   git merge-base --is-ancestor HEAD origin/main
   ```
2. Confirm that the candidate is stable, absent from the registry, and newer than `latest`:

   ```bash
   EXPECTED_VERSION="$(node -p "require('./package.json').version")" node <<'NODE'
   (async () => {
     const pkg = require('./package.json');
     const version = process.env.EXPECTED_VERSION;
     const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
     const versionUrl = `${packageUrl}/${encodeURIComponent(version)}`;
     const [versionResponse, packumentResponse] = await Promise.all([
       fetch(versionUrl, { redirect: 'error' }),
       fetch(packageUrl, { redirect: 'error' }),
     ]);

     if (versionResponse.ok) throw new Error(`${pkg.name}@${version} already exists`);
     if (versionResponse.status !== 404) {
       throw new Error(`Version preflight returned HTTP ${versionResponse.status}`);
     }
     if (!packumentResponse.ok) {
       throw new Error(`Package preflight returned HTTP ${packumentResponse.status}`);
     }

     const packument = await packumentResponse.json();
     const latest = packument['dist-tags']?.latest;
     const parseStable = (value) => {
       const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
       if (!match) throw new Error(`Expected stable SemVer, got ${value || '<missing>'}`);
       return match.slice(1).map(BigInt);
     };
     const candidate = parseStable(version);
     const current = parseStable(latest);
     let comparison = 0;
     for (let index = 0; index < candidate.length; index += 1) {
       if (candidate[index] > current[index]) { comparison = 1; break; }
       if (candidate[index] < current[index]) { comparison = -1; break; }
     }
     if (comparison <= 0) throw new Error(`${version} must be newer than latest ${latest}`);
     console.log(`Preflight passed: ${pkg.name}@${version} is newer than latest ${latest}`);
   })().catch((error) => {
     console.error(error);
     process.exit(1);
   });
   NODE
   ```

3. Run `npm login --auth-type=web` and complete the official browser authentication.
4. Publish with an interactive 2FA confirmation:

   ```bash
   npm publish --registry https://registry.npmjs.org --access public --tag latest --ignore-scripts
   ```

5. Verify the registry version, `latest`, package contents, and clean-install behavior. Record explicitly that this fallback release has no GitHub Actions provenance.
6. Run `npm logout` after verification.

Do not create a long-lived `NPM_TOKEN`, a bypass-2FA automation token, or a GitHub Actions npm secret for this fallback.
