# sl-shim

Cloudflare Worker shim that exposes a SimpleLogin-compatible API surface on top of proxiedmail endpoints documented in `openapi.yaml`.

The goal is pragmatic app compatibility rather than a full reimplementation of the SimpleLogin backend.

## Supported routes

- `GET /`
- `POST /api/auth/login`
- `GET /api/user_info`
- `GET /api/setting`
- `PATCH /api/setting`
- `GET /api/v2/setting/domains`
- `GET /api/v5/alias/options`
- `GET /api/v2/aliases`
- `POST /api/v2/aliases`
- `GET /api/v2/mailboxes`
- `POST /api/alias/random/new`
- `POST /api/v3/alias/custom/new`
- `PATCH /api/aliases/:alias_id`
- `PUT /api/aliases/:alias_id`
- `GET /api/aliases/:alias_id/activities`
- `GET /api/aliases/:alias_id/contacts`
- `POST /api/aliases/:alias_id/contacts`
- `POST /api/aliases/:alias_id/toggle`
- `DELETE /api/aliases/:alias_id`

Any other route returns:

```json
{ "error": null, "data": [] }
```

## Behavior notes

- `GET /api/v2/aliases` requires `page_id` and returns 20 aliases per page.
- `GET /api/aliases/:alias_id/activities` requires `page_id` and returns 20 activities per page.
- `GET /api/aliases/:alias_id/contacts` paginates locally with 20 contacts per page.
- `GET /api/v5/alias/options` deduplicates domains before returning suffixes.
- `POST /api/v3/alias/custom/new` accepts `mailbox_ids` and returns both `alias` and `email` in the created alias payload.
- Alias and mailbox ids are shim-generated stable integers derived from proxiedmail identifiers.

## Auth behavior

The shim reads the incoming `Authentication` header used by SimpleLogin clients.

- For proxiedmail token-authenticated endpoints, it forwards the value as `Token`.
- For proxiedmail bearer-authenticated endpoints, it forwards the same value as `Authorization: Bearer ...`.
- `POST /api/auth/login` exchanges SimpleLogin-style email/password credentials for a proxiedmail API token and returns a SimpleLogin-style login payload.

## Local development

```bash
npm install
npm run dev
```

Syntax-check the worker with:

```bash
npm run check
```

Wrangler serves the worker locally. If you want to test from another device on your LAN, bind dev to `0.0.0.0` in your local workflow.

## Config

`wrangler.jsonc` defines `PROXIEDMAIL_BASE_URL` and defaults it to `https://proxiedmail.com`.

For local testing, provide credentials or API tokens through your usual Wrangler env flow or a non-committed local env file.

## Limits

- This is a compatibility shim, not a full SimpleLogin clone.
- Some payloads are adapted from proxiedmail data and may omit SimpleLogin fields that proxiedmail does not expose.
- Unknown routes intentionally fall back to the minimal empty response above because the mobile app tolerates that for some surfaces.