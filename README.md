# sl-shim

Minimal Cloudflare Worker that exposes a small SimpleLogin-compatible API surface and translates it to proxiedmail endpoints defined in `openapi.yaml`.

## Supported routes

- `GET /`
- `GET /api/v5/alias/options`
- `GET /api/v2/aliases`
- `POST /api/alias/random/new`
- `POST /api/v3/alias/custom/new`
- `POST /api/aliases/:alias_id/toggle`
- `DELETE /api/aliases/:alias_id`

Any other route returns:

```json
{ "error": null, "data": [] }
```

## Auth behavior

The shim reads the incoming `Authentication` header used by SimpleLogin clients.

- For proxiedmail `api_key` endpoints, it forwards the value as `Token`.
- For proxiedmail `api_auth` endpoints, it forwards the same value as `Authorization: Bearer ...`.

## Run

```bash
npm install
npm run dev
```

## Config

`wrangler.jsonc` defines `PROXIEDMAIL_BASE_URL` and defaults it to `https://proxiedmail.com`.