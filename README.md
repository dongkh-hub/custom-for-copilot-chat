# Custom for Copilot Chat

**No GitHub sign-in.** BYOK models for Copilot Chat & Agent Mode — just an OpenAI-compatible URL and key.

## Quick start

1. Install and enable the extension, then **Reload Window** (requires VS Code 1.109+ with GitHub Copilot Chat installed).
2. Run **Custom Mode: Manage Models…** from the Command Palette (or click the ✨ status bar icon). On first use you go straight into the add-model wizard:
   - ① API Base URL (OpenAI-compatible, e.g. `https://api.example.com/v1`)
   - ② Display alias (the name shown in the model picker; blank = show the model ID)
   - ③ Real model ID (the `model` parameter sent to the endpoint)
   - ④ API Key (leave blank for local/intranet gateways without auth)
3. Select it in the Copilot Chat model picker (BYOK group) and start chatting.

Model groups are stored in the **user-level credential store** (not `settings.json`): shared across profiles and windows, applied immediately, no reload required.

## Commands

- **Custom Mode: Manage Models** — one dialog to add / update model ID / duplicate / delete model groups.
- **Custom Mode: Configure Agents Window Tools** — bring tools to the front in the Agents window (reversible).
- **Custom Mode: Reset Learned Reasoning Effort Limits** — clear the record of which reasoning levels each endpoint rejected.

## Troubleshooting

- **Model doesn't appear in the picker**: make sure Copilot Chat is enabled.
- **Gateway returns 400**: the extension falls back automatically through a four-level ladder; see the Output panel (Output → "Custom for Copilot Chat").
- **"Request too long"**: start a new session, or lower that model's input limit in "Manage Models…".
- **Post-hoc debugging**: request logs are persisted to `custom-for-copilot-chat.log` in the extension's global storage (macOS: `~/Library/Application Support/Code/User/globalStorage/CustomforCopilotChat.custom-for-copilot-chat/`).

## Development

```bash
npm install && npm run compile
npm run verify            # compile + i18n check + smoke tests
./scripts/dev-install.sh  # package and install into local VS Code (Reload Window after)
```

See `AIINDEX.md` for implementation details.

## Release

Publishing is fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml) (semantic-release):

1. Commit on `master` following conventional commits (`feat:` / `fix:` / `BREAKING CHANGE:` drive the version bump).
2. To release, open a PR on GitHub merging `master` into the `release` branch and merge it.
3. The workflow then: derives the version → updates `package.json` / `CHANGELOG.md` → tags `v<version>` → `vsce publish` (Azure WIF, no PAT) → creates a GitHub Release with the vsix → syncs the version back to `master`.

One-time setup: create a baseline tag (`git tag v0.1.0 && git push origin v0.1.0`), push the remote `release` branch, and configure `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` (see the workflow file header).

## License

MIT
