# Home, Away and Holiday programmes

This branch contains an experimental schedule editor and runtime for the FastWarm
Smart WiFi 2.0 / ET-63 product `lmtejj3f4kafi2k1`. Automated tests use simulated
thermostats. A complete live programme read, one reversible write and a WAN outage
test are required before treating the feature as hardware-verified.

## Programme selection

Each room can have three independent weekly programmes: **Home**, **Away** and
**Holiday**. Every day has Wake, Leave, Return and Sleep periods with a time and a
target temperature. A period continues until the next period; none of these
profiles is a power on/off schedule.

The Homebridge accessory **Heating Programmes** exposes two switches:

- **Heating Someone Home**: on selects Home, off selects Away.
- **Heating Holiday**: on selects Holiday regardless of household presence.

Presence changes during Holiday are remembered. Turning Holiday off selects Home
if anyone is home, or Away if everyone is out. Holiday has no automatic expiry in
this version. Set the initial household presence before using the controls;
unknown presence is never assumed to mean that the home is empty.

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
