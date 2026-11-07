# Thermostat editor

The custom UI uses locally served HTML, CSS and JavaScript. It needs no frontend
framework or CDN. The **Settings** tab shows the existing Homebridge schema form;
the host's Save button retains its normal configuration behaviour. The editor's
**Save draft** button stores a complete Home, Away or Holiday weekly programme in
the running Tuya platform without uploading it to a thermostat.

When no thermostat runtime is discovered, the UI opens Settings by default so
the plugin's ordinary connection and accessory configuration stays available.
The Thermostats tab remains available with discovery status and Refresh.

Each thermostat must have all three complete profiles saved before automatic
household selection can be enabled. Presence follows whether anyone is home;
Holiday temporarily selects a third programme. The household controls make
clear that changing this intent can upload programmes to enabled thermostats.

Manual application has two steps: request a server-side immutable preview, then
submit that preview's ID using the explicit Apply button. Unsaved edits must be
saved first. The preview lists changed periods and the runtime's warnings,
including activation of scheduled mode. The UI does not automatically apply
drafts, including after reconnection. Reads and applies run in the platform;
closing this editor does not stop them.

## Runtime relay

The UI SDK server is a temporary child process. It never authenticates with
Tuya. Its CommonJS entry point dynamically imports the ESM
`@homebridge/plugin-ui-utils` SDK, leaving the plugin's module format unchanged.

The server discovers `persist/TuyaRuntime.<instanceId>.json` beneath
`homebridgeStoragePath`. A version 1 descriptor contains `instanceId`, the exact
plugin package name, `socketPath`, `token` and `pid`. Only instance IDs are
returned to the browser. All other descriptor fields remain server-side. The
relay accepts only the expected socket path for that instance, canonical IDs
and tokens, and owner-only discovery files on Unix.

The SDK request handler forwards allowlisted JSON requests with HTTP POST over
the runtime's local socket, authenticated using its Bearer token. Frontend
requests may include `instanceId`; it is required when several runtimes are
discovered. The relay removes this routing field before forwarding the body.

| SDK route | Payload |
| --- | --- |
| `/instances` | No payload; returns `{ instances: [{ id }] }` |
| `/thermostats` | No payload |
| `/schedules/read` | `{ deviceIds }` |
| `/profiles/save` | `{ deviceId, profile, schedule, enabled }` |
| `/schedules/apply` | `{ deviceIds, profile, preview: true }`, then `{ previewId }` |
| `/presence` | `{ home: boolean }` |
| `/holiday` | `{ active: boolean }` |

All runtime actions return a full sanitized view. The editor polls every two
seconds while a thermostat is reading, queued or applying, otherwise every ten
seconds. Failures retain open drafts and display the error without initiating
new writes. Saved profiles and last-read schedules remain available from the
local runtime when Tuya is unreachable. Unfinished edits remain in the open page
until saved or the editor is closed.

## Verification

Run `node --check homebridge-ui/server.js` and
`node --check homebridge-ui/public/schedule.js` after editing. Preview with a
simulated `window.homebridge` request implementation before installing on a real
Homebridge instance. Verify empty and partially read programmes, dirty drafts
across refreshes, copying, full-day validation, preview cancellation and expiry,
per-device partial failures, multi-instance routing and the existing schema form.
The preview fixture must never connect to the production runtime socket.

`test/ui-server.test.ts` additionally forks the real SDK server with the same
environment variables supplied by Homebridge UI 4.73. It checks private runtime
relay, routing, secret isolation and descriptor validation over temporary local
sockets. This exercises the SDK protocol; it does not start a Homebridge host.

Official API documentation: [Homebridge Plugin UI Utils](https://github.com/homebridge/plugin-ui-utils).
