# Cudia update metadata service

This is a standalone, dependency-free Node.js 22 service for serving signed Cudia release metadata. It is passive: it does not install or update clients, proxy artifact downloads, accept uploads, run commands, or read Cudia prompts, sessions, or tokens.

## Run

Configure the Hostinger Node.js application with these values, using a deployment branch that contains this directory:

| Setting          | Value            |
| ---------------- | ---------------- |
| Application root | `deploy/updates` |
| Node.js version  | `22`             |
| Package manager  | `npm`            |
| Entry point      | `server.js`      |
| Build command    | Leave empty      |

Do not point the Hostinger application root at the monorepo root: its Bun workspace package metadata is not this standalone app's npm project. In the application root, install and start the service:

```powershell
npm ci
npm start
```

`server.js` starts the configured application even when a managed hosting runner
imports it. The side-effect-free HTTP factory lives in `app.js`; import that
module in tests or when embedding the service. Do not add a direct-execution
guard around the hosting entry's `listen()` call.

The preview deployment uses the `codex/update-service` branch. Public trust and
signed preview metadata are backed by Git commits and restored on redeploy;
private signing keys stay on the release operator's computer. The stable
manifest remains absent until a stable release is qualified, so `/ready` can
return `503` while `/health` and the preview manifest work normally.

It listens on `0.0.0.0:3000` by default. Set `HOST` and `PORT` to override the bind address and port. `PORT` must be an integer from 1 through 65535. Configure Hostinger's HTTPS domain/reverse proxy for `cyara.com.br` to route to the Node application.

The service reads only `stable.json` and `preview.json` from `CUDIA_RELEASE_DIR`, which must be an absolute path. If unset, it uses this directory's `releases` folder. Store release files on durable storage outside an ephemeral deployment checkout. Keep private signing keys in protected operator-controlled storage; never upload them to Hostinger or place them in the application or its environment. Only public verification keys belong in the service configuration. An absent or invalid release returns a generic `503`; the initial checkout intentionally has no release, so `/ready` stays unavailable until a valid stable release is published.

The public key ring is read from `trust.json` in this directory and can be supplemented or overridden by `CUDIA_RELEASE_PUBLIC_KEYS`, a JSON object mapping key IDs to Ed25519 SubjectPublicKeyInfo PEM values. The environment value is limited to 16 KiB and the combined key ring to eight keys. The checked-in `trust.json` is empty. Install only public keys that are already trusted by the updater client. Do not put private keys in this directory, deployment variables, or the service process.

## Endpoints

- `GET` and `HEAD /updates/v1/stable.json` and `/updates/v1/preview.json` validate the signed release before serving the original envelope bytes unchanged. The file is read at most 64 KiB plus one byte; a larger file is rejected. Responses are `no-store`.
- `GET` and `HEAD /health` report process liveness only.
- `GET` and `HEAD /ready` report readiness only when the stable manifest validates. This does not check the availability or contents of its remote artifacts.
- `GET` and `HEAD /` serve the Portuguese Cudia download page. It shows stable and preview releases independently, reports runtime version and sequence from each currently valid signed manifest, and lists installer and update archive availability separately. The page has inline styling and no external assets or third-party requests. Release notes are limited to signed manifest facts; the schema does not carry free-form changelog text.
- `GET` and `HEAD /download/windows?channel=preview&variant=normal&kind=archive` redirect (`307`) to the exact HTTPS artifact URL in that valid, unexpired signed manifest. `channel` is `stable` or `preview`, `variant` is `normal` or `baseline`, and `kind` is `installer` or `archive`. Defaults are preview, normal, and installer. Unknown/repeated parameters and unavailable signed artifacts are rejected. Redirect responses are `no-store`; the service does not proxy or fetch artifacts. The page describes an archive as an update for an existing installation and only offers an installer when the signed channel actually contains one. Preview is clearly labeled and is not presented as stable.

Unknown paths return `404`; methods other than `GET` and `HEAD` on known paths return `405`. There is no file-serving route or server-side release mutation endpoint.

## Manifest and publishing

The envelope is JSON with exactly `schema`, `keyId`, `payload`, and `signature`. `payload` is canonical base64 containing the exact UTF-8 payload JSON bytes; `signature` is canonical base64 Ed25519 over those decoded bytes. The payload schema and artifact fields are validated in `lib/manifest.js`; timestamps must be current and unexpired, and artifact URLs must be HTTPS without embedded credentials or fragments.

The payload contains exactly these fields:

| Field                   | Value                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `schema`                | `1`                                                                                          |
| `product`               | `"cudia"`                                                                                    |
| `channel`               | `"stable"` or `"preview"`, matching the requested endpoint                                   |
| `sequence`              | Positive safe integer; the future updater must persist and enforce its accepted sequence     |
| `version`               | Semantic version, at most 128 characters                                                     |
| `issuedAt`, `expiresAt` | Valid UTC timestamps ending in `Z`; issued at or before the current time, expiring afterward |
| `artifacts`             | One to eight unique records described below                                                  |

Each artifact has exactly `kind` (`"archive"` or `"installer"`), `platform` (`"windows"`), `arch` (`"x64"`), `variant` (`"normal"` or `"baseline"`), `url`, `size` (1 byte through 2 GiB), and `sha256` (64 lowercase hex digits). Uniqueness uses kind, platform, architecture, and variant. This initial contract supports Windows x64 only. Duplicate JSON object keys and nesting beyond 64 levels are rejected. The server verifies the signed metadata; the future updater must also download and verify the selected artifact itself.

Create release payload JSON separately, and keep the Ed25519 private key in protected storage outside the service folder. To sign and atomically publish an already valid payload, set `CUDIA_RELEASE_PRIVATE_KEY_FILE` to the absolute private-key file path and run:

```powershell
node publish.js --input C:\release\stable-payload.json --output C:\cudia-releases\stable.json --key-id release-2026
```

The publisher signs the payload's original bytes, verifies the resulting envelope with the public key derived from the supplied key, and only then atomically renames it into place. It does not generate keys, deploy releases, enforce sequence monotonicity, or publish to a remote host. Client-side public-key pinning and anti-rollback policy remain updater responsibilities; this service alone does not constitute an updater or establish trust in an unpinned key.

Run the tests with `npm test` from this directory.
