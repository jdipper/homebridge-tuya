# Home, Away and Holiday programmes

This branch contains an experimental schedule editor and runtime for the FastWarm
Smart WiFi 2.0 / ET-63 product `lmtejj3f4kafi2k1`. Automated tests use simulated
thermostats. A read-only pilot on 7 November 2026 verified six measured room
temperatures through HomeKit and a complete 28-period native programme read.
Reversible schedule/override writes and a WAN outage still require hardware tests.

## Programme selection

Each room can have three independent weekly programmes: **Home**, **Away** and
**Holiday**. Every day has Wake, Leave, Return and Sleep periods with a time and a
target temperature. A period continues until the next period; none of these
profiles is a power on/off schedule.

The Homebridge accessory **Heating Programmes** exposes two switches:

- **Heating Someone Home**: on selects Home, off selects Away.
- **Heating Holiday**: on selects Holiday regardless of household presence.

Presence changes during Holiday are remembered. Turning Holiday off selects Home
if anyone is home, or Away if everyone is out. Holiday can end manually or at an
optional return time. Set the initial household presence before using the controls;
unknown presence is never assumed to mean that the home is empty.

The default Away grace is 30 minutes; Home resumes as soon as someone arrives.
The editor can change this delay, including setting zero for immediate Away.
A guest hold keeps the Home programme selected until its chosen deadline even
when all household members are out. Holiday takes priority over a guest hold.
Actual occupancy remains visible separately from the effective heating choice.

An optional Holiday preheat lead selects the Home programme before the planned
return. At the return time, Holiday ends and the latest presence/guest hold
selects Home or Away. These are Homebridge timers and need a working Tuya
connection; they are separate from the thermostat's stored weekly programme.
An overdue timer after restart requires explicit recovery instead of replaying
old commands. Unknown occupancy at Holiday return also requires review.

Create Apple Home automations for the first person arriving and the last person
leaving, setting **Heating Someone Home** on or off respectively. A scene or
automation can turn **Heating Holiday** on when leaving overnight, and off when
returning. Presence detection belongs to Apple Home; the plugin receives only the
resulting switch state, not anyone's location.

## Editor

Open the plugin's configuration page in Homebridge. **Thermostats** shows measured
and target temperatures, last-read native programmes and saved profile drafts.
**Settings** retains the existing Homebridge configuration form.

1. Read the programme from each thermostat. A partial response stays partial;
   unknown events are never filled with guessed values.
2. Copy the complete native programme into a profile or enter all seven days.
   Copy controls can duplicate a day, profile or room's programme.
3. Save the draft. Saving does not send it to a thermostat.
4. Review and apply the selected profile. The preview lists event changes;
   applying it uploads the programme and explicitly activates scheduled (Smart)
   mode. Changes are checked using a fresh device readback.
5. Save all three profiles before enabling that room for automatic household
   selection. Enrollment itself does not upload a programme. The next explicit
   presence/Holiday change selects the saved profile.

Manual application of one saved profile works before automatic enrollment. It
does not change the household presence or Holiday selection. The editor shows
requested and confirmed profiles separately, including saved changes that still
need applying.

Room aliases are local display names; SmartLife names and accessory identities
are preserved. The dashboard shows the last reported and locally received
temperature times, plus the current and next planned period from the last
complete programme. Each room has an IANA time zone. Planned times do not prove
the physical controller's clock is correct. Confirm its weekday and clock before
using next-period override expiry; ambiguous daylight-saving transitions cannot
be used for that expiry option.

## Temporary temperatures

A room can use a temporary target from 5–40°C in half-degree steps, ending at an
explicit time within 24 hours or at its next verified programme boundary. The
preview names the room, target, deadline and Homebridge/internet requirement.
Starting selects native Hold without rewriting any weekly events. Native Hold
has no verified device countdown, so Homebridge must send Scheduled mode at the
deadline. If the bridge or connection stops, the Hold temperature can continue.

The transport reads the current power, unit, mode and target before changing
anything; it only starts from powered-on Scheduled mode in Celsius. A target or
mode changed outside the override prevents restoration from overwriting it.
Commands are single-attempt and read back; an uncertain outcome is shown as
recovery-required. A failed expiry does not retry automatically. After restart,
an unfinished override always needs explicit review/resume. Presence changes
during the override are remembered and applied after successful restoration.

## Local history and restore

History starts from genuine reports received while this build runs; it does not
backfill cached values as new measurements. Room readings, target reports and
online/offline events remain distinct. Device measurement timestamps are kept
separate from local receipt times. Genuine steady readings can be retained at a
five-minute cadence. History is bounded to 30 days, downsampled and size-limited;
temperature writes are batched to reduce disk writes, with a shutdown flush.
No additional sensor polling or energy estimation is introduced.

Saved drafts and complete confirmed native reads create immutable programme
versions, capped at 50 per device. Repeated identical versions are deduplicated.
Restoring puts the chosen version into a saved Home, Away or Holiday draft. It
does not upload it: review and apply remain separate actions with fresh device
conflict checking. Older files migrate without inventing historical timestamps.

For this first version, select **seven-day programming in SmartLife** before
applying profiles, and read the thermostat again. The editor checks the grouping
before writes and confirmation. It does not silently alter grouping, adaptive
start, sensor selection, floor limits, power or temperature units. Celsius is the
verified wire format.

## Outages and conflicts

Only the programme already uploaded to a thermostat is available to its built-in
clock without a cloud connection. Switching to another profile through this
plugin requires internet access. Clock retention after a thermostat power loss
and daylight-saving changes remain separate hardware checks.

A weekly upload consists of individual event commands. Interrupted uploads can
leave a mixture of old and new events. Each thermostat reports its own result;
the UI never treats an HTTP acknowledgement as proof of the resulting programme.
The last readback and saved templates persist locally, so they can be reviewed
on the LAN while cloud operations are unavailable.

Before applying, the runtime reads a complete backup and checks that it matches
the preview's baseline. An edit made at the wall panel or in SmartLife causes a
conflict instead of being silently overwritten. Failed writes and restored
in-progress operations do not automatically replay when the internet or
Homebridge returns. Read the device and explicitly retry after reconciling the
programme.

## Process boundary

The running platform owns Tuya authentication, MQTT, programme collection and
presence selection. The temporary configuration UI server uses private local IPC
to that runtime; it creates no second Tuya login and exposes no cloud credentials
to the browser. Closing the editor does not stop an operation or the Apple Home
controls. Runtime discovery records and profile files stay under Homebridge's
persist directory with owner-only permissions.
