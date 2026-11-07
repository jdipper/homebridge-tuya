# FastWarm thermostat support

This development roadmap covers the FastWarm Smart WiFi 2.0 / ET-63 product
`lmtejj3f4kafi2k1`. It records verified capabilities separately from features that
still need implementation and device testing.

The development branch contains the temperature fix, programme transport,
Home/Away/Holiday profile state, private runtime/UI relay, Apple Home selector
switches and a shared editor. It also includes host-timed overrides, planned
now/next periods, Holiday return/preheat, Away grace/guest hold, temperature
history and programme version restore. A read-only pilot on 7 November 2026
verified six measured temperatures and one complete native programme. Live
schedule/override commands and offline execution still need hardware validation.
See [the programme guide](fastwarm-profiles.md).

The selected policy is household occupancy: anyone home selects Home, everyone
away selects Away, and Holiday overrides both. All three are independent weekly
temperature programmes with four periods per day. Holiday ends manually or at
an optional return time, then uses the latest household presence/guest hold.
Native adaptive start, open-window detection and floor-sensor controls remain
deferred; this work does not expose or change them.

## Intended behaviour

| Requirement | Proposed implementation |
| --- | --- |
| Actual room temperature in Apple Home | Read raw `RoomTemper` (DP105), scale 1, and expose HomeKit `CurrentTemperature`. Preserve existing standard setpoint and power commands. |
| Read the thermostat's programme | Request the programme, collect all day/event reports and show completeness and last confirmation time. |
| Different behaviour when occupied | Use an Apple Home arrival/departure automation to select a Homebridge Home/Away control. The choice between separate programmes and a temporary setback remains a user preference. |
| Continue heating without internet | Upload the active programme to each thermostat and let its built-in clock run it. Verify WAN outage behaviour on hardware before claiming this is proven. |
| Edit all thermostats together | Add a schedule page to this plugin's Homebridge UI, with copying between days/rooms, validation, explicit apply and per-device readback results. |

The standard HomeKit Thermostat service has no weekly programme characteristic.
Apple Home can expose temperatures, setpoints and simple automation controls; a
Homebridge custom UI is the proposed timetable editor.

## Evidence

The device's cloud model declares these properties:

| DP | Code | Access | Purpose |
| --- | --- | --- | --- |
| 101 | `power1` | read/write | Native power state; used only for override preflight/readback, never changed by overrides |
| 102 | `SetTemp` | read/write | Target temperature, scale 1 |
| 103 | `ControlMode` | read/write | `smart`, `holiday`, `hold` |
| 105 | `RoomTemper` | read | Room temperature, scale 1 |
| 110 | `Event_Adaptive_Set` | read/write | Programme grouping and adaptive start bits |
| 119 | `week_program` | read/write | Heating event times and target temperatures |
| 122 | `inquire` | write | Request reports of the weekly heating programme |
| 124 | `timer_week_program` | read/write | A separate on/off timer programme |
| 125 | `week_mode` | read/write | Grouping for that separate timer programme |

The standard instruction specification omits measured room temperature and the
heating programme. The raw shadow endpoint provides them:

```
GET /v2.0/cloud/thing/{device_id}/shadow/properties
```

A verified example of DP119 is `QAMWAAB4`, which represents Sunday, Sleep,
22:00, 12 C. It is one event, not a complete week. A six-byte event update is:

```
day bitmap | event | hour | minute | temperature high byte | temperature low byte
```

Days use Monday=1 through Sunday=64. Events are Wake=0, Leave=1, Return=2,
Sleep=3. Temperature is an unsigned big-endian integer in tenths of a degree.
The model also describes a full-day report containing one day bitmap followed
by four five-byte event records. Capture actual full-day reports before enabling
schedule writes in a released integration.

Programme settings in DP110 share a value: bit 0 selects seven separate days
versus grouped weekdays, and bit 1 controls adaptive start. Preserve other bits
when editing either setting.

## Runtime and UI

The long-running platform owns the existing Tuya API and MQTT clients, a schedule
collector, profile storage and serialized device writes. A Homebridge custom UI
server relays requests to this runtime through private, instance-scoped local
IPC. The UI server must not create a second Smart Home login: the plugin already
warns that concurrent logins can invalidate tokens. The UI server itself only
exists while its settings window is open.

Only sanitized device and schedule data reaches the browser. Do not expose the
startup `TuyaDeviceList` snapshot: it contains local keys and location data, and
is not a live state store. Serve UI assets locally so existing drafts and last
confirmed schedules remain viewable on the LAN during a WAN outage.

Suggested operations are list thermostats, read programme, validate draft, apply
programme and select profile. Closing the editor must not stop report collection,
an in-progress operation or presence handling.

## Applying programmes

1. Read and back up the complete current programme. Keep unknown events unknown;
   do not populate missing entries with defaults.
2. Validate each draft, including chronological Wake/Leave/Return/Sleep times,
   and compare its base revision with the latest device programme, including
   edits made in SmartLife or at the wall panel.
3. Show which thermostats and events will change. Send only the intended changes
   using Tuya's Send Property API and record progress durably.
4. Request a fresh complete programme, compare the result and mark each thermostat
   verified, partial or failed. A successful HTTP response alone is insufficient.
5. Keep failed drafts available for explicit retry. Do not silently upload an old
   draft after reconnection.

A full week may take 28 event writes. The operation is not atomic: a connection
failure can leave a mixture of previous and new events. Grouping identical
changes can reduce calls but must not conceal per-event outcomes. Schedule edits
must not incidentally change power, sensor selection, floor limits or operating
mode. Activating a programme in `smart` mode is a separate, visible operation.

The pure collector's `complete` flag means all 28 day/event slots exist. It does
not prove that they form a fresh snapshot from the latest inquiry. Scope each
collection to an explicit read session and require fresh reports before using
it as a backup, overwrite base or confirmation of an applied programme.

Tuya's existing MQTT ordering correction treats each DP as one scalar value.
Before integrating the collector, preserve original schedule reports before this
correction, or order them by day/event identity. Otherwise one day's chunk can
overwrite a different day's report.

## Presence and outages

There is no verified evidence that these thermostats store two named programmes
at once. If separate Home/Away programmes are selected, keep templates in
Homebridge and upload the chosen programme on a presence change. During an
internet outage the device can only execute the programme it already has; a new
presence change cannot reach it through this cloud integration. A programme
interrupted during upload needs reconciliation after connectivity returns.

For a single programme with an Away setback, verify temporary override and resume
semantics before implementation. A Hold setting can prevent the normal programme
from resuming. Avoid frequent whole-week uploads when a verified temporary
override would satisfy the requested behaviour.

## Review and validation sequence

1. Temperature support: exact-product raw enrichment, live updates and honest
   unavailable-data handling, without changing standard controls.
2. Schedule codec and collection: pure encoding/decoding tests, timestamps,
   malformed input, grouped days, duplicates and completeness; then collect a
   full programme from one real thermostat.
3. Read-only multi-thermostat UI, then one reversible event edit with device
   readback, followed by complete-week and multiple-device operations.
4. Presence controls and recovery tests after the desired Home/Away policy is
   chosen.
5. Hardware outage checks: WAN-only interruption, Homebridge restart, thermostat
   power cycle, clock retention, reconnection and daylight-saving behaviour.

The codec tests and local software checks do not prove real-device writes,
offline clock behaviour or successful installation on the user's Homebridge.

## References

- [Upstream plugin](https://github.com/homebridge-plugins/homebridge-tuya)
- [FastWarm WiFi 2.0 manual](https://ww2.fastwarm.com/document/download/07b07210-3733-4f8e-a65d-202dc73f6a3b)
- [Tuya Send Property](https://developer.tuya.com/en/docs/cloud/c057ad5cfd?id=Kcp2kxdzftp91)
- [Tuya message types](https://developer.tuya.com/en/docs/iot/message-type?id=Kavqerli65a1u)
- [Homebridge custom UI](https://github.com/homebridge/plugin-ui-utils)
- [HomeKit service definitions](https://github.com/homebridge/HAP-NodeJS/blob/029e8165680a0f17a3d02714b0aec3c379c7bc93/src/lib/definitions/ServiceDefinitions.ts#L1409)
- [Apple Home automations](https://support.apple.com/en-ph/guide/iphone/iph6d50ec543/ios)
