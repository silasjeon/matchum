# Releasing matchum

## Prepare

1. Update the version in `package.json` and `extension/manifest.template.json` together.
2. Run `npm test` on macOS and confirm the GitHub Actions Linux and macOS jobs pass.
3. Run a default install into isolated paths, rerun it as an update, run `matchum-doctor`, then
   uninstall it. `test/install.mjs` automates this without touching the real installation.
4. Test a fresh Chrome profile manually: load the installed extension, enable Allow User
   Scripts, verify `status`, `tabs`, `exec`, config reload, recipe reload, and `ext-reload`.
5. Confirm a fresh config is inert and no core component makes an external network request.

## Audit the public history

- Review `git log main --format=fuller` and scan `main` with a secret scanner.
- Remove private session links and other development-only metadata from the release commit.
- Push `main` explicitly. Do not push the local `archive/dev-history` branch or use
  `git push --all`/`--mirror` for the public remote.
- Verify generated `extension/manifest.json`, identity keys, host wrappers, and internal
  `docs/` notes are absent from `git archive main`.

## Publish

1. Tag the reviewed commit as `v<version>`.
2. Publish release notes covering behavior, security implications, migrations, and known limits.
3. Install once from the tagged checkout and run `matchum-doctor` again.

The installer retains one managed runtime at `~/.local/share/matchum.previous` for local
rollback. User config, state, and the extension identity are never removed by the uninstaller.
