# Publishing the FastWarm fork to npm

This fork publishes as **`@jdipper/homebridge-tuya`**. Its registry versions and
update channel belong to the `jdipper` npm account. Keep the upstream
`@homebridge-plugins/homebridge-tuya` package separate.

The `Publish fork to npm` workflow is manual and runs only against `main` in
`jdipper/homebridge-tuya`. Its default **check** operation builds and uploads a
compiled archive without contacting npm to publish. **stage** and **publish**
submit that checked archive using npm trusted publishing; no npm token is stored
in the repository or GitHub secrets. The submission step clears token variables
and uses a registry-only npm configuration, so it must authenticate through OIDC.
The original upstream release workflow
keeps its existing upstream-only guard.

## First publication

An npm account and enabled 2FA are required. Sign-in and 2FA prompts belong to the
account owner. Use Node 24 and npm 11.21.2 for the commands below; the workflow
uses those same tool versions.

1. Push the reviewed package and workflow changes to `main`.
2. Run **Publish fork to npm** with operation **check**. Review the compiled
   archive and SHA256 checksum in its workflow artifact.
3. From a terminal signed into npm as `jdipper`, use `npm login` if needed. Check
   `npm whoami` before the first publication.
4. Extract the checked archive into a new directory. From the extracted `package`
   directory, submit it with:

   ```sh
   npm stage publish --ignore-scripts --access public --tag latest
   ```

   This initial submission creates a public `0.0.0-stage` placeholder if the
   package does not exist. The real version stays unavailable until approval.
   Review it in npm's **Staged Packages** tab and approve with 2FA when ready.
   See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

The initial authenticated submission establishes the package under your npm
account. Do not attempt the workflow's OIDC publication modes before its trusted
publisher has been configured on the package.

## Connect GitHub trusted publishing

In the npm package's **Settings → Trusted publishing**, add GitHub Actions with:

| Setting | Value |
| --- | --- |
| Organization or user | `jdipper` |
| Repository | `homebridge-tuya` |
| Workflow filename | `publish-npm.yml` |
| Environment | Leave blank; this workflow does not select a GitHub environment |

Staging is available to the trusted publisher. Enable **Allow npm publish** only
if you want the workflow's explicit **publish** operation to release directly.
The **stage** operation always leaves a separate npm review and 2FA approval.
No dist-tag management permission is needed for the workflow.

A newly configured trusted publisher must complete its first successful publish
within two days or be recreated. Configure it when ready to release the next
version. Use a new package version for that first workflow publication: npm
cannot reuse a version that is already staged or published. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Later releases and update channels

Update `package.json` and both root version fields in `package-lock.json`, commit
to `main`, then manually run the workflow with the intended operation and tag.
Each run tests offline, lints, builds, checks the compiled package and keeps its
archive as an artifact. The two cloud-account integration tests are excluded.
Publishing operates on that same archive rather than rebuilding it.

Choose **latest** for normal installation and Homebridge's ordinary update
discovery for this fork. The workflow names the tag explicitly, including for a
prerelease version such as `2.7.2-jdipper.2`. Choose **beta** for an opt-in testing
channel; users must explicitly install the beta tag or version. The version's
prerelease suffix and the npm distribution tag are separate settings. See
[npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).

Publishing is not Homebridge verification. Continue to describe the programme
features and hardware validation limits in the README.

If a submission reports an error, inspect the npm package and staged versions
before rerunning it. The workflow does not automatically retry a publication.
