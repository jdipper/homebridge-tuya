# FastWarm active programme targets

A complete native week and Smart mode do not alone prove that a newly selected
programme's current temperature has taken effect. In a controlled Holiday/Home
round trip, all six FastWarm thermostats stored every period correctly, but their
native `SetTemp` properties retained the previous programme's current target.
The separate Hive thermostat changed its target correctly.

The FastWarm `.9` provider accepts an authenticated `activeTarget` context with
the room's configured IANA time zone. Heating Programmes `.9` supplies it for
manual and automatic selections. After verifying the full week, the provider
computes the active period, keeps Smart mode, and sends a single native `SetTemp`
only when the fresh target differs and protected controls/target still match
the reviewed baseline. It verifies the resulting target with a fresh shadow
read. No Hold/Smart cycle, native Holiday, power command, temporary job or cloud
schedule executor is introduced.

The existing control reads also request `SetTemp`, adding no query. A differing
target normally adds one individual command and one confirmation read. The `.10` provider waits up to ten seconds for an accepted native target report,
then checks the shadow after a short settling interval. A report that already
arrived avoids that long wait. At most
three read-only confirmation attempts are permitted. A nearby period boundary
can cause one bounded wait/read before any target command. Native programme
packet grouping and its one-second processing interval remain unchanged;
experimental group temperature writes are not enabled.

Unsent target commands stop at the actual authenticated dispatch boundary if
selection, availability, connection, native controls, target or active period
changes. A time-zone edit invalidates old work. An ambiguous transmitted command
is never replayed or treated as proven supersession. Automatic target intent is
journalled before dispatch. Read-only profile verification cannot clear an
active-target mismatch merely because the stored programme matches.

## Hardware evidence

A clock-confirmed pilot temporarily reduced its Smart target by 0.5°C. The first
shadow read, about 150 ms after acknowledgement, still showed the old value.
An independently received native target report then proved adoption of the lower
target. The next programmed event restored the scheduled target without another
temperature command. Fresh native reports and a shadow read corroborated that
transition. The original full week and target were restored and verified.

The first probe stopped on its premature target assertion. Its first restoration
attempt was rejected before any write because a complete backup was unavailable.
A separate fresh read proved the exact test-only schedule difference; reviewed
restoration used a fresh owned baseline and verified the complete original week.
No failed or ambiguous write was replayed. This evidence supports natural-event
hand-back on the tested thermostat. It does not establish WAN-independent
operation, every firmware, clock retention or a guarantee for an ambiguous DST
period. Complete-week and fresh target proof remain required.

The first paired `.9` round trip adopted Holiday targets on all six devices,
but five reports arrived just after its three short confirmation reads. Those
outcomes remained unconfirmed; no command was replayed. Home was restored and
independently read-verified. The `.10` report-informed wait addresses that observed
latency. Its installed Holiday/Home check is recorded in the handover.
