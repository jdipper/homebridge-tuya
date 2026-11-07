# Home, Away and Holiday programmes

This branch contains an experimental schedule editor and runtime for the FastWarm
Smart WiFi 2.0 / ET-63 product `lmtejj3f4kafi2k1`. Automated tests use simulated
thermostats. A pilot on 7 November 2026 verified six measured room temperatures
through HomeKit and a complete 28-period native programme read. A subsequent
temporary-temperature test failed; new boosts/setbacks are disabled pending
FastWarm Hold validation. Holiday programme uploads were subsequently checked
against all 28 native periods on all six rooms. Two first readbacks were one
period behind; fresh read-only checks matched the complete saved programmes and
confirmed Scheduled mode. WAN outage execution still requires a hardware test.

## Programme selection

Each room can have three independent weekly programmes: **Home**, **Away** and
**Holiday**. Every day has Wake, Leave, Return and Sleep periods with a time and a
target temperature. A period continues until the next period; none of these
profiles is a power on/off schedule.

The plugin exposes two separate HomeKit switch accessories:

- **Heating Home**: on selects Home, off selects Away after the configured delay.
- **Heating Holiday**: on selects Holiday regardless of household presence. Turning it off
  returns to the selected Home/Away state.

Each accessory contains one switch, so Home and Holiday can be selected
independently instead of relying on Apple Home's multi-switch accessory layout.
Names chosen in Apple Home are preserved.

When upgrading from the grouped **Heating Programmes** accessory, its identity
and Home switch are retained so Home/Away automations keep their existing target.
Holiday moves to a new **Heating Holiday** accessory; update any Holiday scenes
or automations to select it. Apple Home may retain the old **Heating Programmes**
name on the Home control; it can be renamed there. The migration publishes the
replacement Holiday control before removing the old grouped Holiday service.

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
leaving, setting **Heating Home** on or off respectively. A scene or
automation can turn **Heating Holiday** on when leaving overnight, and off when
returning. Presence detection belongs to Apple Home; the plugin receives only the
resulting switch state, not anyone's location.

## Editor

Open the plugin's configuration page in Homebridge. **Thermostats** shows measured
and target temperatures and the selected profile's draft status in compact room
cards. Each room's programme editor and **Room details** are collapsed until
opened. Details contain the current/next planned period, reading times, native
programme, clock settings and histories. Household options are also collapsible.
**Settings** retains the existing Homebridge configuration form.

Room headings use the room assigned in SmartLife, falling back to the device name
when no room is available. **Refresh** also refreshes these room assignments. In
**Room details**, a custom room name overrides the SmartLife room; save a blank
custom name to follow SmartLife again. These display changes do not rename the
SmartLife device, move it between rooms or change its accessory identity. A device
ID suffix distinguishes rooms with identical display names.

To start from the programmes already on the thermostats:

1. Choose **Home**, **Away** or **Holiday**. Select the rooms to work on, or leave
   none selected to load every room.
2. Choose **Load stored programmes**. Each thermostat is read independently and
   its complete programme loads into its own draft for the selected profile.
   This preserves differences between rooms. A partial or unverified read leaves
   the draft unchanged; missing periods are never guessed. An empty room editor
   also offers **Load programme from thermostat** for just that room.
3. Open a room's programme editor to change its four daily temperature periods.
   Copy controls can duplicate a day, profile or room's programme.
4. Choose **Save selected drafts**, or **Save draft** in one room, to retain the
   drafts in Homebridge. Loading and saving do not change the heating. Unsaved
   drafts remain only in the open page until saved or the editor is closed.

To prepare one programme for several rooms, choose **Edit programme for all
rooms**. This selects every room and opens one shared editor; use the room
checkboxes to narrow the selection if needed. Choose a source under **Start from
room**, then **Use this room's draft** or **Load programme from thermostat**.
The latter reads only that source thermostat into the shared editor. Edit once,
then choose **Save programme for N rooms** to save an independent copy for each
selected room. Other rooms' drafts remain unchanged. This differs from **Load
stored programmes**, which imports each room's own programme separately.

To send saved drafts to the thermostats, choose **Review & apply selected**, or
**Review & apply** in one room. The preview lists each room's changed periods.
Only the final **Apply programme changes** action uploads them and activates
scheduled (Smart) mode. Each result is checked with a fresh device readback.

Save all three profiles before enabling a room for automatic household selection.
Enrollment itself does not upload a programme. The next explicit presence/Holiday
change selects the saved profile.

Manual application of one saved profile works before automatic enrollment. It
does not change the household presence or Holiday selection. The editor shows
requested and confirmed profiles separately, including saved changes that still
need applying.

The Household panel reports progress across rooms enabled for automatic changes:
how many have confirmed the selected programme, which are updating or waiting,
and which need attention. An Away delay shows its scheduled time while Home
continues. Holiday, guest holds, preheat and recovery are shown separately from
room confirmation. Rooms outside automatic control are excluded from the total.

Room cards show their programme result and last successful confirmation time
without opening Room details. Confirmation requires the saved requested programme
to match the complete native readback, with Scheduled mode and seven-day
programming confirmed. A successful read alone does not confirm that a profile
was applied. Editing a saved programme, an incomplete read, an offline room or a
temporary override prevents a current success claim; historical confirmation
remains visible. These results describe the last verified application, rather
than continuous monitoring of changes made at the physical controller. Apple
Home's switches continue to show household selection; progress appears here in
Homebridge.

Tuya can acknowledge the final programme command before that event appears in a
device readback. Following an acknowledged upload, verification makes up to three
read-only inquiries, one second apart, until the complete programme matches.
These follow-up checks never repeat a programme or mode write. An uncertain write
error remains an error even if its diagnostic readback happens to match.

To check a previous warning without uploading again, select the intended profile
tab, open **Room details**, then choose **Verify saved Home/Away/Holiday
programme**. This reads the thermostat and compares all 28 periods with that
saved profile, checking Scheduled mode and seven-day programming. Only a complete
match records a new confirmation and clears the earlier failure. Missing or
edited drafts, offline rooms, active overrides and concurrent changes prevent a
confirmation. This action does not change the thermostat's programme, mode,
household selection or automatic enrollment.

Each room has an IANA time zone. Planned times use the last complete programme
and do not prove the physical controller's clock is correct. Check its weekday
and clock when interpreting these planned times.

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
