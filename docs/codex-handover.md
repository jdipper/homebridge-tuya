# Codex handover: FastWarm heating plugins

Updated: 17 November 2026.

## Starting point

Repository: https://github.com/jdipper/homebridge-tuya
Branch: `fix/holiday-programme-transitions`
Draft PR: https://github.com/jdipper/homebridge-tuya/pull/1
Code checkpoint before this handover: `6d1b866b7955331be5f22801e8cd40c343dfd8c3`.

Start from this branch, not main: it contains fixes that must be retained. The current npm package is `@jdipper/homebridge-tuya`, version `2.7.2-jdipper.2`. The fixes are not published or installed on the user's Homebridge, and no live thermostat commands were issued during this work.

## User's objective and architecture

The user wants two separate Homebridge plugins:

1. A thermostat interface plugin that owns device connections, credentials, readings, device capabilities/limits, native programme encoding, serialized writes and verified readbacks. It exposes individual thermostat accessories in Apple Home.
2. A scheduling/profile plugin that owns saved Home/Away/Holiday programmes, the editor, household selection, return/preheat settings and application progress. It exposes Heating Home and Heating Holiday.

Only the thermostat interface plugin should open device connections. Manual thermostat controls and programme updates must use its shared per-device queue.

Connect the plugins through a small, versioned local API with operations for device discovery/capabilities, reading state, reading programmes, applying programmes, operation progress and cancellation. The existing authenticated private socket implementation is a useful starting point, but currently belongs to the combined scheduling runtime and its UI. Cross-plugin communication must also work when the plugins run in separate child bridge processes.

The scheduler supplies a complete normalized weekly programme. The interface plugin translates it into native commands and reports verified, partial or failed results. Keep Tuya datapoints and local credentials out of scheduler logic.

For FastWarm, retain native weekly programmes: the scheduler selects/uploads a profile; the thermostat handles the daily periods. WAN outage execution still requires a live test.

Suggested first implementation milestone: extract the device/provider boundary from the existing cloud implementation, preserving behaviour and tests. Then introduce a local provider and extract the scheduling plugin. Do not claim local compatibility without a device test.

## Behaviour already implemented on this branch

- Holiday on shows Home off while retaining separately remembered occupancy.
- Home on atomically ends Holiday, clears its return/preheat deadline, and selects Home. An arrival automation operating Home on has the same effect.
- Holiday off restores Home/Away using the latest remembered occupancy. Unknown occupancy is not assumed to mean Away.
- Home off during Holiday remembers absence without cancelling Holiday.
- No departure grace period remains in Homebridge. The setting, UI and settings route were removed, and old saved countdown fields are discarded.
- A new automatic selection obtains a fresh programme baseline rather than depending on an old editor read.
- The apply path retains its fresh backup/conflict check. Manual previews remain bound to their reviewed programme/baseline.
- Confirmation requires all 28 periods to match after Scheduled mode activation, with mode and seven-day grouping confirmed.
- Later, different selections survive earlier upload failures; the failed identical request is not automatically replayed.
- New automatic intent stops obsolete event writes at command boundaries and skips obsolete mode activation. A submitted command must finish; writes never overlap. The latest programme is then applied from a fresh baseline.
- Startup/reconnect must not blindly replay interrupted or failed writes.
- New temporary boost/setback activation remains disabled because the original Hold implementation failed hardware validation. Do not silently re-enable it during the refactor.

The user will handle any departure delay in an Apple Home automation/shortcut. Returning must invalidate that external delayed action before selecting Home; selecting Home alone cannot cancel a sleeping shortcut that later sends Home off. A pending-departure helper was proposed, with a restartable timer or per-run identifier for overlapping departures. No external helper or shortcut has been created.

## Existing code to inspect

- `src/platform.ts`: runtime startup and accessory publication.
- `src/accessory/ThermostatProfileAccessory.ts`: Home/Holiday controls and legacy accessory migration.
- `src/device/schedule/ThermostatRuntime.ts`: currently combines household policy, jobs, persistence, history, Tuya access and UI API.
- `src/device/schedule/ThermostatProfiles.ts`: profile validation and state transitions.
- `src/device/schedule/ThermostatControlPolicy.ts`: occupancy, guest hold and Holiday deadlines.
- `src/device/schedule/FastWarmSchedule.ts`: native programme codec/collector.
- `src/device/schedule/FastWarmScheduleManager.ts`: cloud programme transport, write serialization, fresh reads and verification.
- `src/device/schedule/ThermostatRuntimeServer.ts`: authenticated private IPC.
- `homebridge-ui/`: current combined editor and relay.
- `test/device/thermostatRuntime.test.ts`, `test/device/fastWarmScheduleManager.test.ts`, `test/accessory/thermostatProfileAccessory.test.ts`: important regression scenarios.

Read `docs/fastwarm-profiles.md`, `docs/fastwarm-roadmap.md`, `docs/fastwarm-boost-investigation.md` and `homebridge-ui/README.md` for further evidence. Some investigation notes are historical; distinguish them from current implemented behaviour.

## Hardware and local-control evidence

The user's thermostats are FastWarm ET-63 / Smart WiFi 2.0, product ID `lmtejj3f4kafi2k1`. Existing pilot documentation refers to six rooms.

| Native DP | Meaning |
| --- | --- |
| 101 | Power |
| 102 | Target temperature, Celsius tenths |
| 103 | Control mode: smart / holiday / hold |
| 105 | Measured room temperature, Celsius tenths |
| 106 | Floor temperature |
| 110 | Programme grouping/adaptive flags; preserve unrelated bits |
| 119 | Raw weekly heating programme |
| 122 | Programme inquiry |

Each week has seven days and four events per day (Wake/Leave/Return/Sleep). Our codec handles six-byte single-event updates and 21-byte full-day reports. A complete-day report format is not proof that a full-day write is supported.

Primary local-control evidence:
- https://github.com/make-all/tuya-local/issues/4935 reports local DPS and basic controls for the exact same product ID. The maintainer says basic functionality is covered by the Jiahong ET61+ definition. This does not establish complete local programme read/write support.
- https://github.com/jasonacox/tinytuya documents discovery and the required device ID, IP, protocol version and local key. Local keys can be retrieved during setup via Tuya cloud and change on re-pairing.
- https://github.com/codetheweb/tuyapi is the proposed Node.js local transport library. Its releases document protocol 3.5 support. It has not yet been added to this project.

First live milestone should be one thermostat: read local state, request/collect the entire programme, back it up, make one controlled event change and restore it, then test a full profile and WAN-independent execution. Local connection and programme compatibility have not yet been tested on the user's hardware.

Many Tuya devices allow one local client at a time. Keep connection ownership in the thermostat plugin. Keep keys private and out of logs, browser data and committed configuration. Do not add automatic cloud fallback that could duplicate or replay an uncertain write.

## Reported fault still needing live evidence

The user showed a Smart Life Monday programme:
- Wake 05:30, 12°C
- Leave 08:30, 20°C
- Return 17:00, 12°C
- Sleep 22:00, 12°C

They also reported no programme restoration when switching Holiday off. Tests now cover mixed programmes and dropped restore requests, but the exact cause of the remaining 20°C period is unconfirmed. Do not present it as resolved on hardware.

## Validation and migration

`npm ci --ignore-scripts`, `npm run lint` and `npm run build` succeeded. There are 629 passing offline tests across 34 suites after the last code change; the UI cache-reference test passed after its script hash was refreshed.

The pure offline command used was:

```sh
npm test -- --runInBand --watchman=false --testPathIgnorePatterns test/home.test.ts test/custom.test.ts test/ui-server.test.ts test/device/thermostatRuntimeServer.test.ts
```

The home/custom suites use a real Tuya account. The two socket suites were excluded after an earlier full run failed to create Unix sockets with `listen EPERM` in this execution environment; they should be run in an environment that permits sockets. Do not weaken production IPC to accommodate that limitation.

The editor's script hash in `homebridge-ui/public/index.html` must match the first 12 hex characters of schedule.js's SHA-256 after script changes.

Preserve saved per-room programmes, enrollment, history and meaningful Apple Home names. Plan accessory identity migration explicitly: moving between plugin owners or child bridges may require re-pairing or updating automations, so do not promise transparent migration without verifying it.

Continue with the architecture refactor on a feature branch and keep the existing PR fixes available. No npm publication, merge or live installation update has been performed.
