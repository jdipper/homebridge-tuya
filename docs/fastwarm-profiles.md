# Home, Away and Holiday programmes

This branch contains an experimental schedule editor and runtime for the FastWarm
Smart WiFi 2.0 / ET-63 product `lmtejj3f4kafi2k1`. Automated tests use simulated
thermostats. A pilot on 7 November 2026 verified six measured room temperatures
through HomeKit and a complete 28-period native programme read. A subsequent
temporary-temperature test failed; new boosts/setbacks are disabled pending
FastWarm Hold validation. Native weekly programme uploads and WAN outage
execution still require hardware tests.

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
the physical controller's clock is correct. Check its weekday and clock when
interpreting these planned times.

## Temporary temperatures

**New temporary temperatures are unavailable.** On 7 November 2026, a controlled
test requested 20.5°C for one minute from Scheduled mode at 20°C. The combined
target/Hold command instead reported Hold at 22°C. Returning to Scheduled mode
retained 20.5°C rather than restoring 20°C. The test thermostat was explicitly
restored to Scheduled mode at 20°C, confirmed by native readback.

This means the tested command sequence does not provide a reliable boost and
resume. Both API preview/start operations are blocked, and the editor omits the
activation form. There is no opt-in bypass. Existing active/recovery records
retain their explicit restoration controls. Correct Hold target semantics and
scheduled-target restoration must be verified on hardware before this feature
can be enabled. Native Hold also has no verified device countdown; any future
host-timed expiry would require Homebridge and the Tuya connection to remain
available.

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

The intended offline behaviour is for the thermostat's built-in clock to run
the programme already uploaded to it; this has not been verified by a WAN outage
test. Switching to another profile through this plugin requires internet access.
Clock retention after a thermostat power loss and daylight-saving changes remain
separate hardware checks.

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
