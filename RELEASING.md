# Releasing HuginnDB

Cutting a release is a matter of bumping the version, pushing a tag, reviewing the draft release that the CI workflow produces, and clicking **Publish**. The actual installer is built by GitHub Actions, not on the maintainer's machine — a Windows `-setup.exe` (NSIS; see CLAUDE.md gotcha #21 for why not MSI/WiX), plus a Linux `.deb`/`.AppImage` if that leg of the build matrix is enabled.

## One-time setup — signing keys

`tauri-plugin-updater` only installs updates whose `latest.json` carries a signature it can verify against the public key embedded in `tauri.conf.json`. You generate the keypair **once**, put the public key in the repo, and hand the private key + its password to GitHub Actions through secrets.

### 1. Generate the keypair

From the repo root, on your own machine:

```powershell
pnpm tauri signer generate -w $HOME\.tauri\huginndb.key
```

When asked, pick a password. You can leave it empty, but it's better to set one — you'll save it as a GitHub secret.

The command writes two files:

| File                              | What it is                          | Where it goes                                   |
| --------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `~/.tauri/huginndb.key`           | Encrypted **private** signing key   | GitHub secret `TAURI_SIGNING_PRIVATE_KEY`       |
| `~/.tauri/huginndb.key.pub`       | **Public** verification key         | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

> ⚠️ Store the private key + password in your password manager (1Password / Bitwarden / etc.) as well. **If you lose them, every existing installation will reject any future signed update** — you'd need to generate a new keypair and walk users through a manual reinstall.

### 2. Embed the public key

Open `~/.tauri/huginndb.key.pub` (it's a single base64 line), copy its contents, and paste them as the value of `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Replace the `REPLACE_WITH_PUBLIC_KEY_FROM_TAURI_SIGNER_GENERATE` placeholder. Commit and push — the public key is not a secret.

### 3. Add the secrets in GitHub

Go to **Settings → Secrets and variables → Actions → New repository secret** and create both:

| Secret name                              | Value                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`              | **Full content** of `~/.tauri/huginndb.key`. Easy copy on Windows: `Get-Content $HOME\.tauri\huginndb.key \| Set-Clipboard`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`     | The password from step 1. Leave empty if you didn't set one.                                            |

`GITHUB_TOKEN` is injected automatically by Actions; you don't need to add it.

### 4. Smoke test

- Confirm both secrets show up under **Settings → Secrets and variables → Actions**.
- Trigger the workflow manually once against a throwaway tag, e.g. `v0.2.1-rc1`:

  ```powershell
  git tag v0.2.1-rc1
  git push origin v0.2.1-rc1
  ```

  Then check **Actions → release**. The job should finish green and create a draft release containing the installer **and** a `latest.json` whose `signature` field is non-empty.
- Don't publish the draft if you don't want this to become the "latest" release; just delete it after the check.

## Regular release flow

1. Bump the version everywhere it's duplicated (they must stay in sync):
   - `src-tauri/Cargo.toml` → `[package].version`
   - `src-tauri/mcp-server/Cargo.toml` → `[package].version` (the MCP connector's own crate; not load-bearing for the release, but kept in sync for sanity)
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
2. Move the matching block from `## [Unreleased]` to a new dated section in `CHANGELOG.md`.
3. Commit, push, then tag:

   ```powershell
   git commit -am "chore(release): cut 0.2.2"
   git tag v0.2.2
   git push origin main --tags
   ```

4. Wait for the **release** workflow to finish in Actions. A draft release will appear in **Releases**.
5. Sanity-check the draft: the installer and `latest.json` are attached, the file sizes look reasonable, the release notes link to the changelog.
6. Click **Publish release**. Installed copies of HuginnDB 0.2.1+ will see the update on their next launch and prompt to install it.

## What happens on the user's side

- At launch, the app calls `latest.json` at the URL configured in `tauri.conf.json` → `plugins.updater.endpoints`.
- If the version field is greater than the running version, a toast appears once, and a red dot lands on the settings gear.
- The user clicks **Install and relaunch** → the plugin verifies the signature with the embedded public key → downloads the signed installer → installs → relaunches.
- If the user clicks **Later**, the toast won't reappear for that version, but the gear badge persists until the install runs.
