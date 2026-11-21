# musicbrainz-bot

The MusicBrainz bot service of [Music Maniacs](https://github.com/MusicManiacs). A small Node service
(Playwright + Chromium) that **only knows how to drive MusicBrainz**: it receives the URL of a pre-seeded
MusicBrainz form, opens it with the bot account's session, verifies the form, submits it and returns the
MBID, the edit IDs and screenshots. It knows nothing about Music Maniacs submissions, queues or databases.

This is the code that edits MusicBrainz, published so it can be audited, as the
[MusicBrainz Code of Conduct for bots](https://musicbrainz.org/doc/Code_of_Conduct/Bots) asks.

## What it does

- Logs in at metabrainz.org with the bot account (username + password), on start-up and again whenever the
  session expires.
- `event`: opens the seeded *Add event* form, checks it, clicks **Enter edit**, reads the event MBID from the
  redirect, checks that the relationships and links exist on the event page, and reads the bot's edit IDs
  from the event's edit history.
- `event_art`: downloads `image_url`, uploads it as a **Poster** through the *Add event art* form and returns
  the new edit ID.
- Takes a screenshot before and after every submit.
- Handles **one request at a time** (a second one gets `409 busy`), pauses between submits and keeps at least
  one second between page loads.

## What it never does

- It never submits when anything is in doubt: a seeded field missing or different, a relationship that points
  to text instead of an entity, a validation error, an empty edit note, an unexpected button, the Internet
  Archive reporting problems. It answers `invalid` and clicks nothing.
- It never edits or deletes existing entities, never votes, never merges.
- It never opens a URL other than the expected form on the requested server.
- It never retries a submit by itself. If **Enter edit** was clicked and the outcome is unknown it answers
  `uncertain`; the caller must look for the entity before trying again.
- It never targets `musicbrainz.org` unless `MB_ALLOW_PRODUCTION=true` is set explicitly. The default is
  `test.musicbrainz.org` only.
- It never writes the password or the service token to logs, responses or the image (every log line goes
  through a redactor).

## API

Everything except `GET /health` needs `Authorization: Bearer $BOT_SERVICE_TOKEN`. The service is meant to run
on an internal network, not exposed to the internet.

### `POST /edits`

```json
{ "kind": "event", "server": "test", "url": "https://test.musicbrainz.org/event/create?edit-event.name=...&rels.0.type=<link-type-gid>&rels.0.target=<mbid>&edit-event.url.0.text=...&edit-event.edit_note=..." }
```

```json
{ "kind": "event_art", "server": "test", "url": "https://test.musicbrainz.org/event/<mbid>/add-event-art?add-event-art.edit_note=...", "image_url": "https://.../flyer.jpg" }
```

- `kind`: `event` or `event_art` (`place` and `artist` answer `501` until they are implemented).
- `server`: `test` or `production`.
- `url`: the form on that server (`/event/create` or `/event/<mbid>/add-event-art`). Fields are seeded with the
  same query parameters MusicBrainz documents for seeding (`edit-event.*`, `rels.N.type`, `rels.N.target`,
  `edit-event.url.N.text`, `<form>.edit_note`). The URL is the single source of truth for what the bot expects
  to find in the form.
- `image_url`: required for `event_art`; JPEG, PNG or GIF (decided by its bytes), at most `IMAGE_MAX_BYTES`.

Response (`200` whenever the bot ran; the outcome is in `status`):

```json
{
  "status": "created",
  "mbid": "…",
  "edit_ids": ["5001", "5002"],
  "candidates": [],
  "captures": [{ "label": "before", "id": "<run>-before", "url": "/captures/<run>-before" },
               { "label": "after",  "id": "<run>-after",  "url": "/captures/<run>-after" }],
  "error": null,
  "verification": { "ok": true, "missing": [] },
  "warnings": []
}
```

| `status` | Meaning |
|---|---|
| `created` | The edit was entered. For `event`, `mbid` is the event, `edit_ids` are the bot account's edits in the event's history, and `verification.missing` lists any relationship or link that did not show up on the event page (`verification.ok = false`: the event exists, the caller completes it). For `event_art`, `edit_ids` are the new open edits (the poster edit is voted, not auto-applied). |
| `invalid` | Nothing was sent (or MusicBrainz sent the form back with errors and no edit was entered). `error = { code, message, problems[] }`; `problems` lists every difference found. |
| `uncertain` | **Enter edit** was clicked and the redirect never arrived. Do not retry without checking MusicBrainz first. |
| `duplicates` | Reserved for `place` / `artist` (Story #4): possible duplicates shown by the form, with `candidates`. |

Error codes in `error.code` include `bad_seed`, `form_not_found`, `form_check_failed`, `server_rejected`,
`no_redirect`, `login_failed`, `account_mismatch`, `image_unavailable`, `upload_failed`, `unexpected_error`.

Request-level errors use the shape `{ "error": { "code", "message" } }`: `400` malformed request (`invalid_body`,
`invalid_kind`, `invalid_server`, `invalid_url`, `invalid_image_url`), `401` bad token, `403`
`server_not_allowed`, `409` `busy`, `413` body too large, `501` kind not implemented, `503` `not_configured`
(no bot credentials).

### `GET /account?server=test`

Verifies the session and reads whether the account has the *Bot* user type from its profile page.

```json
{ "server": "test", "username": "MusicManiacs_bot", "logged_in": true, "is_bot": false, "user_types": [], "error": null }
```

With wrong credentials it answers `200` with `logged_in: false` and `error: { code: "login_failed", … }`.

### `GET /health`

No token. `{ "status": "ok", "version", "credentials_configured", "busy", "logged_in": { "test": true } }`.

### `GET /captures/:id`

The PNG of a capture listed in a response (token required). Captures are kept `CAPTURES_TTL_DAYS` days.

## Configuration

Credentials only come from environment variables.

| Variable | Default | |
|---|---|---|
| `BOT_SERVICE_TOKEN` | – | **Required.** The service refuses to start without it. |
| `MB_BOT_USERNAME`, `MB_BOT_PASSWORD` | – | The bot account. Without them `/edits` and `/account` answer `503`. |
| `MB_ALLOW_PRODUCTION` | `false` | Only the literal `true` allows `server: "production"`. |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | |
| `DATA_DIR` | `data` (`/data` in the image) | Captures. |
| `CAPTURES_TTL_DAYS` | `14` | |
| `PAUSE_BETWEEN_SUBMITS_MS` | `5000` | Minimum time between two **Enter edit** clicks. |
| `NAV_INTERVAL_MS` | `1000` | Minimum time between two page loads. |
| `LOGIN_MAX_AGE_HOURS` | `12` | Log in again after this long even if the session is alive. |
| `MB_USER_AGENT` | `MusicManiacsBot/<version> (+repo URL)` | Appended to the browser's user agent. |
| `NAVIGATION_TIMEOUT_MS`, `SUBMIT_TIMEOUT_MS`, `LOGIN_TIMEOUT_MS`, `IMAGE_MAX_BYTES`, `CHROMIUM_SANDBOX` | see `src/config.js` | |

## Run

```sh
npm ci && npx playwright install chromium
BOT_SERVICE_TOKEN=... MB_BOT_USERNAME=... MB_BOT_PASSWORD=... npm start
```

Docker (the base image already has Chromium; the Playwright version in `Dockerfile` must match `package.json`):

```sh
docker build -t musicbrainz-bot .
docker run --rm -p 3000:3000 -v mbbot-data:/data \
  -e BOT_SERVICE_TOKEN -e MB_BOT_USERNAME -e MB_BOT_PASSWORD musicbrainz-bot
```

## Tests

```sh
npm test
```

The tests run a real Chromium against a local HTTPS server that stands in for `test.musicbrainz.org` and
`test.metabrainz.org` (any other host fails to resolve, so tests cannot reach the internet). The pages it
serves are:

- **Recorded from MusicBrainz** (`test/fixtures/recorded/`): the metabrainz.org login page, a Bot and a regular
  editor profile, an event page with its relationships and a link, and its edit history. `npm run
  record-fixtures` records them again (read-only, no account needed).
- **Reconstructed** (`test/helpers/fake-mb.js`): the *Add event* form, the *Add event art* form and the edit
  lists with the editor visible. They only render for a logged-in user, so they were written by hand from the
  markup of [musicbrainz-server](https://github.com/metabrainz/musicbrainz-server) (commit `42caf9a`). The
  smoke test below is what covers that difference with the real site.

## Live smoke test (test.musicbrainz.org only)

Needs an account on <https://test.metabrainz.org> (created by a person; the bot has none yet).

```sh
MB_BOT_USERNAME=... MB_BOT_PASSWORD=... npm run smoke
```

By default it logs in, prints `/account` and opens the seeded *Add event* form passing every check **without
submitting** (dry run). Captures go to `data/smoke/captures`. To really submit a test event to
`test.musicbrainz.org`:

```sh
SMOKE_SUBMIT=true SMOKE_ARTIST_MBID=<artist in test> SMOKE_PLACE_MBID=<place in test> \
SMOKE_IMAGE_URL=https://.../poster.png \
MB_BOT_USERNAME=... MB_BOT_PASSWORD=... npm run smoke
```

The smoke script never targets production.

## Maintainer and bot rules

Maintained by Music Maniacs. The bot account must be created with a name that says it is a bot and whose it
is (for example `MusicManiacs_bot`), and the *Bot* user type must be requested from the MusicBrainz team
**before the first edit on production**. Edit notes left on its edits must reach a maintainer.

## License

MIT, see [LICENSE](LICENSE).
