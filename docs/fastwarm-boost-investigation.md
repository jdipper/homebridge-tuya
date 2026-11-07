# FastWarm fixed-duration boost investigation

Investigation date: 7 November 2026. Product: FastWarm Smart WiFi 2.0 / ET-63,
`lmtejj3f4kafi2k1`.

The requirement is a temporary temperature that lasts for its chosen duration,
including across normal programme events, and ends during an internet outage.
A command executed in the cloud at the deadline does not satisfy that requirement. A local
Homebridge timer can satisfy a WAN-only outage requirement if it can reach the
thermostat over the LAN; it does not protect against Homebridge or LAN failure.

The user prefers Tuya API queries for this investigation. Direct LAN work is
deferred; it is not a prerequisite for the API route. Cloud configuration can
still support offline expiry if it installs a suitable task on the thermostat
before connectivity is lost. A cloud-only execution task cannot provide that
guarantee.

**New boosts remain disabled.** Both transport preview and start reject activation
before any cloud read or write, with no configuration bypass. Explicit recovery
remains available. This investigation added no heating commands, timer tasks,
programme changes or network interruptions. Following explicit user approval,
Device Timer was subscribed and authorized for project Test2. The earlier
controlled test below is historical evidence, not a successful boost validation.

## Observed behaviour

The first test thermostat, identified here only by suffix `…cdrjgm`, began in
Scheduled (`smart`) mode at 20°C. The authorized request was 20.5°C for one minute.

| Operation or observation | Result |
| --- | --- |
| Combined native command `SetTemp: 205`, `ControlMode: hold` | API acknowledgement succeeded; subsequent native properties reported Hold at 22°C. |
| Explicit return to `ControlMode: smart` | Native properties reported Scheduled at 20.5°C, rather than 20°C. |
| Explicit restoration of `SetTemp: 200` while Scheduled | Native readback confirmed Scheduled at 20°C. |

The test did not establish a reliable activation or automatic expiry. It shows
that a combined mode/target write cannot be treated as an atomic transition to
the requested Hold temperature. It also shows that returning to Scheduled mode
does not necessarily clear a previous temporary setpoint. Separate remembered
targets or mode-dependent command handling are plausible explanations; the
precise firmware behaviour is not yet established. The incorrect atomic-write
and resume assumptions were in our implementation, not evidence of a firmware
defect.

A subsequent read-only operation-log query (`type: 5,7`, with no code filter)
returned standardized `temp_set` history for the same test. Cloud log timestamps
record a report of 205 at 10:58:06.127 UTC and 220 at 10:58:06.231 UTC, 104
milliseconds later. Subsequent records report 205 at 10:58:56.719 and 200 at
11:00:10.924. These records corroborate the unexpected target, but do not establish
how long the physical thermostat held either value. They do not include native
mode transitions, prove that entering Hold recalled a stored target, or establish
MCU command ordering.

## Native capabilities and terminology

The project-native model query confirmed the relevant property definitions. Raw
properties are distinct from the plugin's standardized Tuya codes.

| DP | Native code | Relevant meaning |
| --- | --- | --- |
| 101 | `power1` | Native Boolean power state; `power` is not this product's native code. |
| 102 | `SetTemp` | Temperature target, scale 1; 200 represents 20°C in Celsius mode. |
| 103 | `ControlMode` | Thermostat `holiday`, `smart`, `hold`. |
| 107 | `TemperUnitChange` | Boolean false is Celsius on this product. |
| 119 | `week_program` | Thermostat heating programme, four events per day. |
| 120 | `type` | `0` Thermostat, `1` Timer. |
| 123 | `ControlMode2` | Explicitly described as Timer Holiday/Smart/Hold modes. |
| 124 / 125 | `timer_week_program` / `week_mode` | Separate Timer programme and its grouping. |
| 127 | `holdtime` | Writable numeric duration field; its relationship to thermostat Hold is unverified. |

The [FastWarm manual](https://ww2.fastwarm.com/document/download/07b07210-3733-4f8e-a65d-202dc73f6a3b)
distinguishes three behaviours: a Scheduled temperature adjustment lasts only
until the current event ends (printed page 12); thermostat Hold lasts until
cancelled (page 14); countdown settings appear under Timer clock mode and select
on/off output (pages 18–20). Consequently, Scheduled overrides can end too early
for a fixed-duration boost, while the manual does not establish a heating Hold
countdown. DP127's name alone is insufficient evidence. Switching to Timer mode
would change control semantics and is not a boost solution.

An independent owner's [exact-product Tuya Local report](https://github.com/make-all/tuya-local/issues/4935)
contains successful local DP reads and matching model definitions, including the
Timer description of DP123. That is useful feasibility evidence for LAN access;
it does not prove compatibility or countdown behaviour on these six devices.

## Read-only findings from this investigation

- A 15-second passive discovery window on Homebridge observed none of the six
  thermostats. Silence does not establish lack of LAN support: network placement,
  broadcast visibility and device behaviour remain unknown. Thermostat LAN
  addresses have not been established. This route is now deferred in favour of
  API queries; no further LAN discovery or address request is needed for the
  current investigation.
- A project-authenticated thing read succeeded. A local key is available for a
  future local status check, but no key, access token or full device identifier is
  included in this document or exposed to the editor.
- The initial read-only project request to
  `GET /v2.0/cloud/timer/device/{device_id}` for `…cdrjgm` returned code `28841101`:
  “No permissions. This API is not subscribed.” This establishes a project API
  permission limitation, not whether the thermostat supports local schedules.
- The project initially listed five authorized services without Device Timer.
  Tuya's service page offered Basic Edition at $0 with a Long-Lived validity
  period. After user approval, the console's Free Trial flow subscribed Device
  Timer and authorized Test2. Its resource table now shows Permanent validity and
  In service, and its Authorized Projects table lists Test2. The displayed
  effective date is 7 November 2026 at 12:41:33.
  [Service listing](https://www.tuya.com/vas/commodity/DEVICE_TIMER).
- After authorization, the public timer-list query succeeded for all six online
  thermostats. Each returned an empty list. This resolves API access but supplies
  no existing task whose execution mode or device-download state can be examined.
  No task was created or modified. Neither the current public query nor the
  documented legacy query exposes a conclusive module-local capability flag.
- The legacy `GET /v1.0/devices/{device_id}/timers` query also succeeded for
  `…cdrjgm` and returned an empty list. These task lists are separate from the
  thermostat's native weekly heating programme; empty lists do not mean that
  programme is absent.
- A seven-day operation-log query for timing events (`type: 10`) succeeded for
  `…cdrjgm`, returning no logs and `has_next: false`. There is no existing timing
  event in that response from which to infer execution location. An initial
  command/report query with a mixed raw/standard code filter returned a parameter
  error; removing the code filter and querying `type: 5,7` succeeded and supplied
  the historical temperature reports above.
  [Operation logs](https://developer.tuya.com/en/docs/cloud/bdc1e6f858?id=Kcp2l3tqdozts).
- The existing plugin uses cloud API/MQTT transport. It has no implemented LAN
  transport or confirmed module-local timer integration.

## Candidate approaches

| Approach | Fixed duration across programme events | Expiry without WAN | Expiry without Homebridge | Current conclusion |
| --- | --- | --- | --- | --- |
| Thermostat MCU Hold countdown | Only if a heating countdown actually exists | Potentially | Potentially | Unverified; documentation points to an indefinite heating Hold and a separate Timer countdown. |
| One-off tasks downloaded to the Tuya Wi-Fi module | Potentially, with verified Hold activation and restoration actions | Potentially, after confirmed download | Potentially | Preferred capability to investigate; not established for this product. |
| Homebridge deadline with direct LAN control | Potentially, with verified Hold activation and restoration | Yes, if the LAN path works | No | Useful fallback for WAN-only resilience; requires a new local transport. |
| Temporary overlay in the stored weekly programme | Only where all required events fit | Potentially, once fully written and verified | Potentially | Reject as the default boost design: four-slot limit, partial writes and persistent weekly mutations. |

### Module-local one-off tasks

Tuya documents a separate module schedule facility: downloaded DP tasks can run
offline, but product enablement and device support must be established. That
framework documentation is not a capability declaration for the ET-63.
[Tuya Local Schedule](https://developer.tuya.com/en/docs/iot-device-dev/TuyaOS-iot_abi_device_local_timer?id=Kd5s8n8503nyh).
The English FAQ describes a 15-second delay to reduce flash writes. Its
[Chinese version](https://developer.tuya.com/cn/docs/iot-device-dev/TuyaOS-iot_abi_device_local_timer?id=Kd5s8n8503nyh)
clarifies that this delay follows each schedule setting; it does not establish
that every task runs 15 seconds after its due time. Allow schedule download and
flash persistence to settle before testing offline execution, and measure actual
expiry timing separately.

The panel timer API documents one-time tasks and exposes `runMode`: 0 denotes
cloud execution, 1 local execution. A successful creation response or timer ID
alone does not establish that a task was downloaded or will run offline. Nor is
that panel SDK API automatically interchangeable with the project's REST API or
the plugin's existing Smart Home session.
[Tuya Cloud Timer](https://developer.tuya.com/en/docs/iot/cloud-timing-interface?id=K9m1dlbzt0kdz).

The documented REST timer query lists time, date, repeat pattern, actions and
enablement, but no execution-location or device-download acknowledgement field.
[REST timer query](https://developer.tuya.com/en/docs/cloud/5f40e70e79?id=Kconlsrgn2i9z).
The official Panel SDK's `getDpLastTimer` and `getDpsLastTimer` use named app RPCs
(`s.m.linkage.timer.nearest.get` and `s.m.linkage.timer.nearest.bat.get`) through
`TYSdk.apiRequest`. They require an authenticated app/panel context, not merely
Test2's REST project credentials or a developer-console browser login. No
documented equivalent REST route has been established. Product timer enablement
is an advanced product feature, so absence of a corresponding DP is not proof
that the module lacks local timers.
[Panel API context](https://developer.tuya.com/en/docs/iot/common-app-sdk?id=K9m1dldk26u64),
[Product features](https://developer.tuya.com/en/docs/iot/define-product-features?id=K97vug7wgxpoq).

Before relying on this route, establish product support, an accessible supported
API, confirmed local execution (for example `runMode: 1`), confirmation that the
task reached the device, correct date and
time-zone handling, and controlled offline execution. A one-off Smart-mode task
alone is not yet a valid resume action: our earlier trace retained 20.5°C after
returning to Smart. Neither multi-DP action ordering nor an exact end-to-end Hold
sequence has been validated. Task download must be confirmed before beginning an
indefinite Hold; uncertain activation or task outcomes must not be blindly retried.

### Direct LAN fallback (deferred)

Tuya supports local DP exchange, and the exact-product owner report makes a
read-only status probe worthwhile once network placement and addresses are
known. Protocol version, authentication, readback and operation during WAN loss
still need verification on these devices.
[Tuya LAN control](https://developer.tuya.com/en/docs/iot-device-dev/TuyaOS-iot_abi_lan_dev_ctrl?id=Kcogloltxvej1).

A local deadline would need durable state, one serialized writer per thermostat,
fresh ownership checks and local readback. LAN control removes the WAN dependency;
it does not add a countdown to the thermostat. Homebridge, router/Wi-Fi and
thermostat power remain dependencies. A restart or uncertain result requires
explicit reconciliation, not replaying an old boost.

### Why a weekly overlay is not the default

An overlay would replace affected native programme events with boost targets and
insert a restoration event at the requested end. An arbitrary endpoint can need
a fifth daily event, exceeding the four-event format. Grouped weekdays can also
affect other days. Sequential writes are not atomic and can leave a partial week.

Even a correctly written overlay repeats the following week until removed; the
device cannot restore the original table merely because one boost ended. Cleanup
would require a durable backup and comparison with the live programme, preserving
later edits made in SmartLife or at the panel. This trades an expiring temperature
for persistent programme mutations and cannot be presented as an ordinary boost.

## Restoration must use the programme at expiry

The correct end state is Scheduled mode and the target for the native period
active **at the deadline**, not necessarily the target captured when the boost
started. A boost can cross multiple events, midnight or a time-zone transition.

Use a complete verified programme and a verified thermostat clock/time zone.
Where possible, re-read the programme before restoration so subsequent
user edits are respected. Restoring a cached target without reconciling those
edits could overwrite the user's intent. A module task with a precomputed target
has the same conflict problem if the programme changes after task download.
Native schedule re-evaluation, if available, would be preferable but must be
demonstrated. Confirm both mode and target; Smart mode alone is insufficient.

## Staged validation plan

The next unresolved capability cannot be established from the empty timer lists
and timing logs. REST task creation and subsequent online execution could be
tested through API calls, but successful responses alone would not establish
offline expiry. The API-first route needs supported execution-mode/download
metadata or product-specific confirmation before an offline claim can be made.
A controlled, separately authorized test could use child lock ON then OFF on one
identified thermostat, leaving its temperature and heating mode unchanged. An
online test establishes only that scheduled commands work. Offline proof must
deny internet access to the **thermostat itself** after tasks have downloaded and
settled, and observe execution at the panel or over a verified LAN connection.
Blocking only Homebridge's cloud access would leave the thermostat reachable by
Tuya and would not prove device-local execution. Room identification, network
placement, observation and explicit recovery must be established before that test.

### 1. Finish read-only capability checks

1. Completed: authorize the approved Device Timer service, query all six public
   task lists, query the first device's legacy list and timing logs, and retrieve
   the earlier test's command/report history. Keep credentials owner-only and
   out of reports.
2. Establish a supported way to obtain app/panel timer metadata through APIs, or
   obtain product-specific confirmation of local timer support. The currently
   available REST project access does not establish this capability. Do not
   treat named app RPCs as guessed public REST paths.
3. Seek a documented thermostat-specific countdown or native clear-override
   action rather than assuming Timer fields apply. Historical standardized
   temperature reports do not replace native mode evidence.
4. Leave LAN discovery and authenticated local probes deferred unless the user
   later chooses that route.
5. Keep activation gated while the protocol and failure guarantees remain unknown.

### 2. Present a concrete controlled-test proposal

Obtain fresh, explicit authorization for the selected device, target, duration,
mode transitions, possible transient stored Hold temperature, observation method
and restoration actions. The previous one-minute test approval does not authorize
another boost or an outage. An internet-isolation test needs separate agreement
on its exact scope and recovery; Homebridge/LAN must remain available when testing
WAN-only failure.

### 3. Validate activation and restoration while online

Record a fresh complete programme, current event, clock, mode and target. Observe
the native SmartLife Hold workflow or a documented command sequence one step at a
time, with bounded readback. Do not repeat the combined mode/target assumption or
use JSON key order as a sequencing guarantee. Reject unexpected states and perform
the specifically authorized restoration. Check the target appropriate at expiry,
including a test that crosses a natural programme boundary. Avoid rewriting the
weekly programme to manufacture that boundary.

### 4. Validate the chosen offline expiry mechanism

For module tasks, confirm one-time configuration, local run mode and download
before starting Hold. Prove that expiry restores the intended programme target
with the cloud unavailable and without a Homebridge expiry command. For the LAN
fallback, prove local status and restoration while WAN access is absent, then
state the remaining Homebridge/LAN dependencies plainly. Record actual timing,
mode and target at each stage, and verify no repeating task or programme mutation
remains. If ordered restoration cannot be represented safely, keep the feature
disabled rather than claim a fixed-duration guarantee.

Prepare and test any candidate transport behind the activation gate before its
controlled hardware test. Enable user-facing boosts only after the hardware
checks pass. Homebridge failure, thermostat power loss, clock
retention, DST and conflicting manual edits remain separate validation cases.
