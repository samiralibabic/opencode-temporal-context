# Releasing

## Before every release

1. Confirm `package.json` contains the intended version and supported OpenCode range.
2. Run `npm ci`, `npm test`, and `npm run pack:check`.
3. Confirm the release tag will be exactly `v<package version>`.
4. Push the commit, then push the release tag.
5. Verify the package from the npm registry before creating the matching GitHub release.

The `publish.yml` workflow validates that the tag matches `package.json`, reruns all tests against the packed artifact and released OpenCode binary, and publishes with provenance.

## First publish only

npm Trusted Publishing cannot create an unclaimed package. Bootstrap `0.1.0` once with a temporary granular npm token:

1. Create a short-lived granular npm access token with read/write package access and **Bypass 2FA** enabled. The unclaimed package cannot yet be selected individually, so use the narrowest available account-level package scope and shortest practical expiration.
2. Add it to this GitHub repository as the `NPM_TOKEN` Actions secret.
3. Push the `v0.1.0` tag. `publish.yml` uses the token and `npm publish --provenance` to create the package with provenance.
4. Verify `opencode-temporal-context@0.1.0` from the public registry.
5. In the package settings on npmjs.com, configure GitHub Actions as a Trusted Publisher for `samiralibabic/opencode-temporal-context` and workflow filename `publish.yml`. Under Allowed Actions, explicitly permit direct `npm publish`.
6. Delete the `NPM_TOKEN` repository secret and revoke the temporary npm token.
7. Restrict traditional token publishing in the npm package settings after the OIDC publisher has been verified.

## Later publishes

Push the release tag with no `NPM_TOKEN` secret configured. npm CLI detects GitHub's OIDC environment and uses the Trusted Publisher configured for `publish.yml`.

Do not submit ecosystem listings until the first registry package has been installed and tested successfully.
