# Homebridge Tuya — FastWarm device connection

This is [jdipper’s fork](https://github.com/jdipper/homebridge-tuya) of
[homebridge-plugins/homebridge-tuya](https://github.com/homebridge-plugins/homebridge-tuya),
with measured FastWarm room temperatures, a device connection for the shared
heating controller, and security fixes.

## Shared heating controller

The local `2.7.3-jdipper.10` build separates device integration from household
control. **Heating Programmes** owns the programme editor, saved Home/Away/Holiday
drafts, household presence, Holiday return, history and the Apple Home switches.
This Tuya plugin owns Tuya authentication, normal HomeKit accessories, accepted
room-temperature reports, SmartLife room names and native FastWarm programme
reads/writes. It publishes no household switches or policy timers.

Existing `persist/TuyaThermostatProfiles.<instanceId>.json` files are left untouched
for the shared controller’s migration. They are never read to apply programmes
or resume a timer by this build. The legacy Home and Holiday accessories are
retired only after the private device provider starts successfully. The shared
controller publishes the replacement controls.

The device connection keeps its owner-only descriptor in Homebridge’s `persist`
directory and its Unix socket in the separate private `heating-runtime` directory.
Keeping sockets outside `persist` allows Homebridge to restart child bridges safely. It reuses the running plugin’s authenticated
Tuya session; Tuya credentials never pass to the shared controller or editor.
The provider buffers actual accepted temperature, target and availability events
between controller polls, with a unique identity per event and bounded memory
(200 observations per room, 2,000 in total). Startup and cached reads create no
history samples. Explicit room refresh updates SmartLife names; background
reads use the existing room cache.
Reads and previews do not change temperatures, programmes, power or mode.
Application consumes one short-lived preview, checks a fresh baseline, writes
changed periods once, and requires complete readback and Scheduled mode before
reporting confirmation. With Heating Programmes `0.1.0-jdipper.9`, it also aligns the active period’s target in Smart mode and requires a fresh native target read. Uncertain outcomes are never automatically retried. See [active-target behaviour](docs/fastwarm-active-target.md).

Heating Programmes `0.1.0-jdipper.8` adds exclusive Home/Holiday transitions in
the shared controller. This device provider advertises `automaticCancellation`
and accepts a private `/provider/cancel-automatic` request for one owned automatic
preview token. Cancellation does not open another Tuya connection, add a cloud
request, replay a command or send a rollback. It marks the owned operation obsolete
so that unsent packets and obsolete mode activation stop at command/dispatch
boundaries, including after asynchronous authentication. A submitted command is
allowed to finish while its device queue remains reserved. The controller then
prepares the latest different programme against a fresh baseline. Cancellation
does not claim a partial upload restored or confirmed a week.

The automatic fresh-baseline lease, grouped inquiry/write paths, capability cache,
fresh membership/availability/mode guards, one-shot tokens and manual preview
conflict checks remain in place. A normal profile change follows the same cloud
programme request path as `.6`; current-target alignment adds only a needed target command and its fresh confirmation. Local cancellation is used only when intent changes.

FastWarm support targets the ET-63 product `lmtejj3f4kafi2k1`, configured in Celsius
and seven-day mode. Each day has four strictly increasing periods, with targets
from 5 to 40°C in 0.5°C steps. An application will not cancel a Hold or other mode
change made after its preview.

### FastWarm upload efficiency

With Heating Programmes `0.1.0-jdipper.5` or later, automatic profile changes keep one
fresh native week reserved in the device queue while the controller checks its
saved draft. Applying that one-shot reservation saves the complete baseline in a
private operation journal, reads fresh controls, sends the changed periods, then
verifies the complete resulting week and controls. A changed programme costs
**four cloud checks plus one request per planned upload packet**; a matching week
needs two checks and no programme write. Native target data shares the existing control reads. A differing active target additionally needs one individual target command and normally one verification read. Accepted device reports wake a bounded wait before that read, allowing slow delivery without replaying commands; delayed shadows permit bounded read-only rechecks. No target command is sent when it already matches. Manual review/apply retains its independent fresh
baseline checks. Expired reservations, disconnects or observed external programme
edits stop before uploading. Verification may repeat a read; uncertain programme
writes are never retried automatically.

The default remains the verified six-byte, single-period update. Advanced
`options.fastWarmProgrammeWriteModes` entries opt in **individual device IDs**
only after a changed-programme test and complete restoration have verified the
packet shape on that thermostat:

- `grouped-events`: identical changed periods share a six-byte packet and day mask.
- `whole-days`: each changed day is sent as all four periods in one 21-byte packet.
- `grouped-days`: identical complete desired days share a 21-byte packet and day mask.

Unlisted thermostats retain single-period uploads. Two/three-period packets are
never generated. Acknowledgement alone does not prove support: unchanged writes
can appear successful even if firmware ignores them. Failed or unconfirmed
grouped uploads never fall back to another write format automatically.

Consecutive programme packets for the same thermostat wait at least one second
after the preceding cloud acknowledgement. This gives native processing time
between period updates without adding API requests. The first packet is sent
without this wait; grouped packet planning and complete-week verification remain
in place. A subsequent operation still honours any remaining interval from an
earlier packet for that thermostat. See [delivery behaviour and validation limits](docs/fastwarm-programme-delivery.md).

### Shared requests across thermostats

`options.fastWarmProgrammeGroups` can opt in an existing Tuya group after a
changed-period test and exact restoration have been verified independently on
all six members. Each entry contains a decimal `groupId` string and exactly six
unique `deviceIds`. The plugin never creates groups or changes their membership.

Only concurrent automatic operations for every configured member can share a
request. Inquiries keep a separate fresh message collector for each thermostat;
programme writes must have the same six-byte single-period packet for all six.
Different room targets, missing participants and manual operations use individual
requests. Membership is freshly checked before each shared request, and every
member must still approve dispatch after authentication.

Validated instruction definitions are cached in memory for up to 24 hours, so
baseline inquiries, writes and readbacks can reuse the same capability check.
The cache contains supported instruction types and raw-packet length limits;
it contains no thermostat readings, mode values, schedules or membership data.
It is cleared by connection recovery, device information or availability changes,
authentication recovery, failed validation or commands, and shutdown. Ordinary
short credential rotations retain it. No cache is persisted across restarts.

Each thermostat retains its own queue reservation, complete backup, fresh mode
checks and full-week confirmation. One group's acknowledgement or group status
never confirms all the rooms. Failed or uncertain group commands are not retried
as individual commands. If group membership or supported properties change, the
operation stops for review. Group requests count in the local API usage meter;
their treatment under Tuya's billing allowance must be checked separately.

With six changed rooms, one packet per room and both inquiries grouped, a Home
change needs 23 HTTP attempts with a cold capability cache or 22 with a warm one.
An identical Away packet shared by all six needs 19 cold or 18 warm. These counts
include fresh membership and individual controls before and after application;
authentication, recovery, extra readbacks, Hive and individual fallback add calls.

### Cloud request budget

HomeKit temperature reads use real cached observations while the push connection
is healthy, including quiet rooms whose temperature has not changed. They do not
start five-minute REST polling. Initial discovery hydrates missing temperatures;
unexpected push interruptions or a device coming back online can request one
coalesced recovery. Recovery is limited to six one-shot requests per rolling day
across the manager. Ordinary short credential renewals do not trigger recovery.
During an interruption, observations older than five minutes are unavailable in
HomeKit until an accepted report or recovery arrives. Cache reads never advance
the observation timestamp.

Concurrent expired-token requests share one refresh. The owner-only
`persist/TuyaApiUsage.<instanceId>.json` counter records actual HTTP attempts,
including retries, authentication and push-connection renewal, in fixed categories.
It stores no request URLs, headers, bodies, device IDs or credentials. Heating
Programmes displays these local counts under **Tuya API usage**. They measure
this plugin instance from the displayed start time, not Tuya billing or other apps.
Counters survive restarts and reset with the UTC month; accounting failures do
not interrupt heating. Repeated restarts still incur new discovery requests.

## Installation and settings

The npm package remains **`@jdipper/homebridge-tuya`**, displayed as
**Homebridge Tuya (jdipper FastWarm)**. This local development build has not been
published to npm. Keep the shared-controller build and this provider together
when deploying the migration.

Tuya connection settings and normal accessories continue to use the existing
Homebridge configuration. Open this plugin’s settings to edit credentials and
accessory settings; open **Heating Programmes** to manage heating programmes.
See [advanced options](ADVANCED_OPTIONS.md), [supported devices](SUPPORTED_DEVICES.md)
and [FastWarm temperature support](docs/fastwarm-temperature.md).

## Development

```sh
npm install
npm run lint
npm run build
npm test -- --runInBand --watchman=false
```

Wire-protocol tests and private provider tests run without accessing devices.
The provider has no automatic startup, reconnect or report-triggered uploads.

The security and measured-temperature changes remain separate from the private
household/controller feature for upstream contributions. This fork is not a
separately Homebridge-verified release.
