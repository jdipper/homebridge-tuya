# FastWarm local control

The optional connection targets the exact ET-63 product already supported by
this fork, using protocol 3.5 and Celsius. It retains the Tuya provider identity,
existing accessory IDs and shared Heating Programmes IPC contract. It does not
create another household controller.

## Transport and ownership

One local owner serializes status queries, programme inquiries and native
commands for each selected device. Incoming TCP fragments are assembled by
declared length with bounded buffering. AES-GCM authenticates each frame;
session negotiation checks the keyed challenge before accepting reports.
Session nonces and GCM IVs do not depend on the clock, and nonce tracking uses
constant memory. Authentication or framing failures close the connection.

Commands have no implicit reconnect, retry, alternate packet encoding or cloud
fallback. A successful socket write is a dispatch receipt, not proof that the
thermostat stored or adopted the change. A disconnect after dispatch leaves an
unknown outcome. Read-side reconnection may establish a new generation but
cannot replay an earlier command.

Native mappings used by this connection are DP101 power, DP102 target, DP103
mode, DP105 measured temperature, DP107 units, DP108 keypad lock, DP110 programme
settings, DP119 programme packet and DP122 programme inquiry. Ordinary status and
DP-refresh commands did not return a complete programme on the tested firmware.
The full-week read therefore sends the established `inquire=true` report request;
it does not send new programme or heating-control values.

## Programme safeguards

An inquiry reserves the per-device local queue, obtains a status barrier, waits
for earlier programme echoes to settle, and opens a fresh report collector at
dispatch. It requires all 28 day/event pairs and a settling interval. Conflicting,
malformed, missing or stale reports cannot produce a confirmed fingerprint.
Accepted LAN reports are isolated from cloud reports for selected devices.

The existing schedule planner and durable application journal remain in use.
LAN uploads are restricted to one event and one day per packet, with at least
the existing interval between writes. Grouped-day and whole-day opt-ins used by
the cloud path do not enable those shapes locally. Programme writes never
implicitly change power or mode. Explicit activation and current-target
alignment retain the existing preview, timezone, freshness and supersession
guards and require native status readback.

Local connection generations govern automatic baseline ownership; a cloud MQTT
outage does not cancel a healthy local operation. Cloud groups containing a
selected LAN device are excluded so the device cannot receive duplicate cloud
and local commands. Cloud-only group optimisations otherwise retain their
existing behaviour.

## Credentials and startup

Configuration contains only a device ID, private IPv4 address, protocol and
enabled flag. The key import page accepts only configured instance/device pairs.
It returns key-presence flags, clears password inputs and never returns a key.
The private keystore enforces a strict schema, owned regular files, mode 0600,
bounded reads, no symlink traversal and serialized atomic updates.

Vetted startup metadata is stored separately without credentials, coordinates or
network addresses. A restored cache is always offline until authenticated LAN
status arrives. A temperature cache read does not fabricate a measurement time,
and reconnects require a new accepted measurement before reporting availability.
Fahrenheit observations are never interpreted as Celsius. The first discovery
still requires cloud access; a failed cloud startup does not create unknown
devices or retire cached accessories.

## Validation boundaries

The earlier controlled hardware investigation proved status, all 28 native
programme reports, one future-day period modification and exact restoration on
one thermostat. Current targets and protected settings were preserved. This is
bounded evidence, not proof of every firmware or multi-period delivery pattern.
The Node implementation also passed full-week readback and the same bounded
future-period change/restoration before rollout. Its authenticated report parser
accepts the defined nonzero version-header metadata used by this firmware.
Hardware results and installed versions are recorded in the handover.

Offline tests cover encrypted TCP peers, fragmentation and coalescing, challenge
and GCM failures, command restrictions, cancellation and ambiguous writes,
inquiry freshness, complete-week validation, manager observations and unit
changes, cloud isolation, mixed groups, shared-provider operations, private key
handling and offline startup. The two repository suites requiring real cloud
account configuration are excluded from the offline run.

Wire layout and session derivation were checked against
[TinyTuya 1.19.0](https://github.com/jasonacox/tinytuya/tree/v1.19.0/tinytuya/core).
This implementation uses Node primitives and does not add a third-party local
client or a Python runtime dependency.
