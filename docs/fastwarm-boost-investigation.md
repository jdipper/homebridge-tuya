# FastWarm fixed-duration boost investigation

Investigation date: 7 November 2026. Product: FastWarm Smart WiFi 2.0 / ET-63,
`lmtejj3f4kafi2k1`.

The requirement is a temporary temperature that lasts for its chosen duration,
including across normal programme events, and ends during an internet outage.
A cloud command scheduled for later does not satisfy that requirement. A local
Homebridge timer can satisfy a WAN-only outage requirement if it can reach the
thermostat over the LAN; it does not protect against Homebridge or LAN failure.

**New boosts remain disabled.** Both transport preview and start reject activation
before any cloud read or write, with no configuration bypass. Explicit recovery
remains available. This investigation added no heating commands, timer tasks,
programme changes, permission changes or network interruptions. The earlier
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
  broadcast visibility and device behaviour remain unknown. Network information
  is awaiting the user; thermostat LAN addresses have not been established.
- A project-authenticated thing read succeeded. A local key is available for a
  future local status check, but no key, access token or full device identifier is
  included in this document or exposed to the editor.
- A read-only project request to
  `GET /v2.0/cloud/timer/device/{device_id}` for `…cdrjgm` returned code `28841101`:
  “No permissions. This API is not subscribed.” This establishes a project API
  permission limitation, not whether the thermostat supports local schedules.
- The project lists five authorized services and does not include Device Timer.
  Tuya's Device Timer service page offers Basic Edition at $0 with a Long-Lived
  validity period, while the developer console labels activation Free Trial.
  Subscription and project authorization have not been changed; approval was
  requested before adding its timer read/write permissions.
  [Service listing](https://www.tuya.com/vas/commodity/DEVICE_TIMER).
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
It also documents an execution delay of approximately 15 seconds, which must be
included in the promised timing tolerance rather than treating expiry as exact
to the second.

The panel timer API documents one-time tasks and exposes `runMode`: 0 denotes
cloud execution, 1 local execution. A successful creation response or timer ID
alone does not establish that a task was downloaded or will run offline. Nor is
that panel SDK API automatically interchangeable with the project's REST API or
the plugin's existing Smart Home session.
[Tuya Cloud Timer](https://developer.tuya.com/en/docs/iot/cloud-timing-interface?id=K9m1dlbzt0kdz).

Before relying on this route, establish product support, an accessible supported
API, `runMode: 1`, confirmation that the task reached the device, correct date and
time-zone handling, and controlled offline execution. A one-off Smart-mode task
alone is not yet a valid resume action: our earlier trace retained 20.5°C after
returning to Smart. Neither multi-DP action ordering nor an exact end-to-end Hold
sequence has been validated. Task download must be confirmed before beginning an
indefinite Hold; uncertain activation or task outcomes must not be blindly retried.

### Direct LAN fallback

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
Where possible, re-read the programme locally before restoration so subsequent
user edits are respected. Restoring a cached target without reconciling those
edits could overwrite the user's intent. A module task with a precomputed target
has the same conflict problem if the programme changes after task download.
Native schedule re-evaluation, if available, would be preferable but must be
demonstrated. Confirm both mode and target; Smart mode alone is insufficient.

## Staged validation plan

### 1. Finish read-only capability checks

1. Establish the Homebridge and thermostat network placement and LAN addresses
   from the user's network information. Do not infer device addresses from a
   shared public address in cloud metadata.
2. Attempt a bounded, authenticated local status read for one identified device,
   without sending control DPs. Keep credentials owner-only and out of logs.
3. Inspect existing SmartLife timer capabilities and task metadata without saving
   a timer. Determine whether local execution and download confirmation are
   exposed; distinguish absent capability from the project's missing permission.
4. Review timestamped native reports from the earlier test and obtain any intact
   DP127 descriptions. Seek a documented thermostat-specific countdown or native
   clear-override action rather than assuming the Timer fields apply.
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
