# Codex handover: shared Heating Programmes

Updated: 18 November 2026.

## Repositories, checkpoints and deployment state

Household heating is already split into device providers and a shared scheduler.
Do not repeat the old combined-plugin extraction or install its runtime beside
the shared owner.

| Component | Source | Last verified installed build |
| --- | --- | --- |
| Heating Programmes | `jdipper/homebridge-heating-programmes` ([PR #2](https://github.com/jdipper/homebridge-heating-programmes/pull/2)) | `0.1.0-jdipper.9` (17 November; unchanged) |
| Tuya device provider | `jdipper/homebridge-tuya` ([PR #4](https://github.com/jdipper/homebridge-tuya/pull/4)) | `2.7.3-jdipper.12` (18 November) |
| Hive device provider | `@jdipper/homebridge-hivehome-control` | `1.1.0-jdipper.4` (17 November; unchanged) |

The earlier household-transition updates were merged before their installation:

- [Shared PR #1](https://github.com/jdipper/homebridge-heating-programmes/pull/1),
  merge `e44e043ac80a63f901591df448b638540933a897`.
- [Tuya PR #2](https://github.com/jdipper/homebridge-tuya/pull/2),
  merge `649edd377e03ae0e55d2a50e569dbad71697a24e`.

Historical transition-port checkpoints:
- Shared: `f8dab72c2a9afc18073701c6414a29e4b3f4ee39`.
- Tuya: `aeb9ed78e9a3f4cf2bb9667af4ec98b26dfe713e`.

The public Shared repository has a clean history: the previously verified `.7`
source snapshot followed by this port, now merged into `main`. Private workspace
history, runtime files and installation receipts are not published.
Public commit authors use the GitHub handle and noreply address.

In the existing workspace, the publishable Git checkouts are
`public-repositories/homebridge-heating-programmes` and
`public-repositories/homebridge-tuya`. The older local repositories retain private
history for reference only; do not push all their branches or their old history.

The original Holiday work remains available in
[Tuya draft PR #1](https://github.com/jdipper/homebridge-tuya/pull/1), branch
`fix/holiday-programme-transitions`, checkpoint
`ec4d73eeb54f646fec117124aa60976ddc02c82c`. That is an older combined-plugin
implementation and a reference for the fixes, not the deployment baseline.

The earlier shared-Holiday port installed Heating Programmes `.8` and Tuya `.7`
from checked local archives. Settings, saved profiles, history and pairing data
were backed up and preserved. The programme-delivery follow-up below supersedes
that Tuya build; Heating Programmes and Hive remain unchanged. These local builds
have not been published to npm.

## FastWarm LAN control (installed `.12`)

The `.13` local-only follow-up adds an explicit `fastWarmLocalOnly` option.
With vetted metadata and private keys already present, startup bypasses cloud
login, discovery and MQTT entirely. A rejecting API preserves the manager
interface while preventing accidental cloud calls from other accessory paths.
Normal cloud/mixed behaviour is retained when the option is absent or false.
The optional **Refresh from SmartLife** UI action uses a separate bounded,
read-only API session; it updates selected names and room assignments, retains
vetted schemas and status, meters its HTTP attempts and requires a child-bridge
restart. It does not change keys or heating values. Failed or incomplete reads
retain the prior metadata. The action is available for SmartLife Home projects.
See [local-only operation](fastwarm-local-control.md#explicit-local-only-mode).

The full offline suite passes **879 tests in 47 suites**, including real private
IPC startup, the cloud-denying API, unchanged mixed-mode paths and explicit
metadata-refresh failure cases. Build and source lint pass. The deployment
helpers additionally cover transactional rollback, six retained local selections,
private key/metadata preservation and complete native verification. Installation
evidence for the follow-up will be recorded after the live read-only checks.

`feat/fastwarm-lan-control` adds an optional transport inside the existing Tuya
provider. The initial pilot selected one thermostat; the configuration-only
rollout on 18 November selected all six FastWarm thermostats. Hive retains its
existing connection. Shared controller code, programme policy and grouped
Home/Holiday controls are unchanged.

The `.11` pilot was installed from checked archive SHA-256
`c5009ab72e64bf46b9433e7c1110a532efda97b5e0aa569653542b608405adc1`,
built from `e00d75c9ff1cfa42973cb0cb064d1dc9ea6505dd`. Static verification
confirmed one LAN thermostat and five cloud thermostats, with keys, configuration,
profiles, history and pairings preserved and unchanged Shared/Hive processes.
One subsequent read verified all **168 native periods and six fresh Home targets**
against the captured weeks. It issued no heating-value commands; five cloud
`inquire=true` requests are semantic reads recorded as control traffic by the
existing API meter. Home remained on and Holiday off.

The live setup page exposed an identifier mismatch: Homebridge removes `_bridge`
before constructing a child platform, while the page hashed raw configuration
including that field. The running LAN connection and private key were correct,
but the page reported a missing key. `.12` corrects only the UI's derivation,
matching the existing provider identity without moving keys or changing runtime
control code. A new immutable release is used for this follow-up.

The `.12` follow-up was installed from archive SHA-256
`d6652472f014f4a5a6537e6d61f3f3a5ac483b67302e22b98a335ff0d2f13463`,
built from `9d49dacbcb66117f4bb4abba78f406182f9cdd4a`. All compiled runtime
files are byte-identical to `.11`; package metadata changes only the version.
The static verifier confirmed the unchanged local selection and private key,
existing group/pairing identities and unchanged Shared/Hive processes. Both the
server handler and the live setup page now recognise the existing private key.
No key migration or thermostat command was required for the UI correction.
The 20 UI tests and 57 UI deployment checks pass. These installed archives
remain immutable; subsequent handover edits record deployment evidence only.

After the `.12` restart, a new single read verified all 168 native periods and
six fresh Home target confirmations again. Original native fingerprints, saved
profiles, policy, programme history and grouped control identities were retained.
That pilot check used one local thermostat and five cloud thermostats; its only
cloud control traffic was the five semantic inquiry requests. No programme,
target, power or mode command was sent during either installation. Home remains
on and Holiday off. Broad multi-period LAN delivery and physical WAN-disconnect
startup still require separate bounded hardware validation.

### Six-device LAN rollout, 18 November

The remaining five FastWarm thermostats passed authenticated protocol 3.5 status
and complete native-week preflight checks against their saved Home programmes.
The rollout retained the original local thermostat's selection and key and added
the five verified selections and private keys. Keys remain in the owned,
instance-scoped mode-0600 store and never enter normal configuration or public
documentation. The installer changed no package, runtime code, metadata or
accessory cache. The installed Tuya version remains `2.7.3-jdipper.12`.

Only the Tuya child bridge was restarted. Static verification confirmed six LAN
temperature sources and six recognised private keys, with the same provider and
accessory identities, grouped Home/Holiday controls, saved profiles, household
policy, retained programme history and unchanged Shared/Hive processes. A single
subsequent read verified all **168 native periods and six fresh Home targets**
against saved Home and the captured native fingerprints. Programme/control HTTP
counters were unchanged: this all-LAN verification needed no cloud inquiry
requests. No programme, target, power or mode value was written. Home remained
on and Holiday off.

The cloud request-budget examples below describe the cloud transport. Selected
LAN devices use local status, native programme and control requests; the plugin
still retains its existing cloud discovery and MQTT lifecycle. This rollout did
not add a cloud-disabled startup mode or establish physical WAN-disconnection
startup. Broad multi-period LAN delivery remains a separate bounded hardware
test; the earlier single future-period write/restoration is its current live
write evidence.

See [local control](fastwarm-local-control.md) for configuration, key storage,
transport ownership and validation limits. The implementation uses Node's built-in
TCP and crypto modules, with no Python or new package dependency. Exact-product
metadata and a private protocol 3.5 key are required. Selected local devices never
fall back to cloud writes, including when their key is absent or LAN unavailable.
Cloud groups containing a local member are bypassed; all-cloud optimisations stay
in place. LAN programme packets are restricted to one event and one day and retain
the existing delivery interval and full-week verification.

The Node hardware readiness check received all 28 periods, matching saved Home,
with the existing target and Smart mode unchanged and no cloud API calls. It found
an authenticated protocol-header difference in unsolicited reports: the version's
12 metadata bytes can be nonzero. The parser now accepts that defined header
shape, covered by an encrypted peer regression. Authentication is still required.
The controlled Node write test also passed: a future Sunday Leave period was
raised by 0.5°C, all 28 periods were checked, then the exact original week was
restored and checked. The current target, Smart mode and protected settings stayed
unchanged. Exactly two programme commands were dispatched, without replay or
cloud API calls. A first test preflight stopped before any mutation because it
required optional unsupported DPs; the corrected helper records only supported
optional fields while requiring all essential controls. Its 30 offline safety
tests and the static installer/verifier's 61 tests pass.

The complete offline suite passes **816 tests in 44 suites**; build and lint pass.
The two suites requiring real cloud-account configuration are excluded.

Private local keys and vetted startup metadata live in separate owned mode-0600
files scoped to the existing provider instance. Normal configuration contains no
key. The plugin UI can import keys without returning them. A cloud startup failure
can use previously vetted metadata and fresh authenticated LAN observations;
non-local devices remain offline in that case. Physical WAN-disconnect startup
and broad multi-period LAN delivery remain untested. The first metadata seed must
come from a previously established exact-product discovery, not a guessed device.

## Programme delivery follow-up (installed and hardware checked)

Tuya `2.7.3-jdipper.8` ([PR #3](https://github.com/jdipper/homebridge-tuya/pull/3))
adds per-device spacing between consecutive native programme packets after an
observed middle-period write was acknowledged but absent from complete readbacks.
It is installed and passed static verification. Only the Tuya child bridge was restarted; the shared
controller and Hive processes, grouped controls, pairing identities,
configuration, saved profiles and historical programme versions were preserved.
Fresh read-only checks established complete 28-period weeks for all six FastWarm
thermostats with zero programme warnings. The controlled hardware test described
below then exercised the multi-packet delivery interval.

The installed archive was built from
`bf14951529230c0cf84661fe91b8c209a5ab420a`. It remains immutable. Subsequent edits
to these handover documents do not replace that archive or change its runtime
code or dependencies. [PR #3](https://github.com/jdipper/homebridge-tuya/pull/3)
records the change for this fork's `main` branch.

See [delivery behaviour and validation limits](fastwarm-programme-delivery.md)
for the regression, timing policy and guarded hardware test. The build passes
**539 offline tests in 34 suites**, including local socket integration tests and
12 pacing tests. The previous implementation fails the new core regression.
Build, standard lint and explicit schedule-manager lint pass. The static
installer/verifier passes **39 tests**; the guarded hardware-test helper passes
**15 offline tests**.

A controlled test passed on two thermostats after their physical clocks and
weekdays were confirmed. It increased each of a future Sunday's four period
targets by 0.5°C, retaining their change times. Each complete 28-period week was
verified, then the original week was restored using a fresh conflict-checked
baseline and all 28 periods were verified again. All four test/restoration phases
confirmed successfully, with no failed-phase replay or manual corrections.
The observed programme-command attempt count matched the planned 16 packets.
Saved household drafts and current-day programme periods were preserved.

This is bounded evidence for the installed build, tested devices and packet
pattern. It does not establish the exact earlier failure cause or guarantee
other firmware, network outages or every possible programme. Full native
readback and visible failure handling remain required.

## Active-target follow-up (installed and hardware checked)

The current paired contract is Heating Programmes `0.1.0-jdipper.9` and Tuya
`2.7.3-jdipper.10`, tracked by [Shared PR #2](https://github.com/jdipper/homebridge-heating-programmes/pull/2)
and [Tuya PR #4](https://github.com/jdipper/homebridge-tuya/pull/4). Checked local
archives were installed with backups; no npm publication was performed. Runtime
source checkpoints are Shared `80671d931c7c28b36ac9b0395e7cdc69f9a86196`
and Tuya `dfbed06ac894dd11c5a73d5be7f99eceaa799987`. Later handover/README-only
commits do not replace those immutable archives or alter installed runtime code.

The earlier week-storage fixes alone did not activate the new programme's current
temperature: all six FastWarm weeks matched Holiday while native targets retained
Home values. A clock-confirmed pilot then adopted an explicit 0.5°C Smart target
reduction, and its next native event restored the scheduled target without another
temperature command. Its original full week and target were restored and verified.
This establishes natural-event hand-back on the tested device while connected;
it does not constitute a WAN-disconnection or universal firmware test.

Shared now supplies the room's validated IANA time zone for both reviewed and
automatic Tuya applications. The provider verifies the full week and Scheduled
controls, aligns a differing current target with one native `SetTemp` command,
and requires a fresh native shadow target match. It retains Smart mode and the
uploaded native schedule. Hold/Smart cycles, power changes, native Holiday,
boosts and future execution jobs are not introduced. Time-zone edits invalidate
reviewed work; dispatch guards cover newer intent, native edits, connection and
availability changes, and period boundaries. Read-only profile verification also
requires fresh active-target proof. An explicit review can confirm current state
without relabelling a historical unknown operation as successful.

The first `.9` paired test adopted the correct targets on all six devices, but
five native reports arrived just after its three short read checks. Those results
remained unknown and were never replayed. Home was restored and independently
read-verified. Tuya `.10` waits locally for an accepted native target report for
up to ten seconds, then uses a fresh shadow GET as proof. At most three read-only
checks remain; a stale shadow cannot overwrite a newer accepted target report.

The final installed Holiday → Home test passed on all seven thermostats:
**28 periods per thermostat in each direction, 392 period comparisons**, with all
current targets matching each programme's active period. All 12 FastWarm automatic
operations confirmed. Final Home, zero programme warnings, saved drafts, household
policy, grouped control identities/names and pairing data were verified. Hive's
provider and process remained unchanged. All six FastWarm physical clocks and
weekdays were user-confirmed for the test; clock metadata was updated separately.

The `.9` pair required only Tuya and Shared child restarts. The `.10` follow-up
restarted only Tuya, preserving the running Shared and Hive processes. Both
static verifiers sent no thermostat commands. Initial probe/readiness checks and
the `.9` timing failures are retained in private evidence; none is represented
as an unqualified pass.

Programme grouping, the capability cache and the `.8` per-device packet spacing
are unchanged. Native `SetTemp` shares the existing control GETs. A matching
target adds no command or read; a differing target normally adds one individual
command and one proof GET. MQTT-informed waiting avoids predictable stale reads;
there is no new temperature polling between profile changes. Base request counts
below describe programme storage and must include this conditional target cost
when budgeting profile switches.

Current validation: **590 Tuya tests in 36 suites**, including local sockets and
all group/request-count regressions; **289 Shared tests**, including 21 new
contract/freshness/time-zone cases. Build and standard/explicit nested lint pass.
Paired and single-provider static installer/verifier suites pass **40** and **50**
tests. The Shared full suite used its existing frozen legacy validator through a
temporary workspace alias, removed afterward; it added no published runtime data.
See [active-target behaviour and evidence](fastwarm-active-target.md).

## Existing architecture and ownership

- Tuya owns authentication, device connections, measured temperatures, room
  discovery, native programme encoding, device queues and verified readbacks.
- Hive retains its own authentication, device accessories and guarded whole-week
  schedule operations. Its provider version does not change for this port.
- Heating Programmes owns the shared editor, saved Home/Away/Holiday drafts,
  enrollment, household intent, guest hold, Holiday return/preheat, history and
  progress for both systems.
- Providers and scheduler communicate over authenticated, versioned private Unix
  sockets. Separate child bridges are supported. Sockets live in the owner-only
  `heating-runtime` directory beside `persist`; JSON descriptors remain in
  `persist`. Vendor credentials never pass to the editor or scheduler.
- The persisted scheduler file is `persist/HeatingProgrammes.json`. Legacy Tuya
  profile files are read only for the existing one-time migration, not re-imported
  to replace newer shared settings.

The installed paired builds preserve one **Heating** accessory, UUID seed
`@jdipper/homebridge-heating-programmes:controls`, with ordinary Switch services
using stable `home` and `holiday` subtypes. Configured names are Heating Home and
Heating Holiday; custom names and the grouped accessory identity are retained.
Do not restore the older two-accessory migration from the reference PR.

## Ported household behaviour

- Holiday on shows Home off while remembering actual household occupancy.
- The grouped Home switch uses `/home`: Home on atomically ends Holiday, clears
  its return/preheat settings and selects Home. First-arrival automations using
  that switch have the same effect.
- `/presence` remains an occupancy-only route. The editor's Someone home and
  Everyone away buttons remember occupancy without cancelling Holiday.
- Home off during Holiday remembers absence without ending Holiday.
- Holiday off restores the latest remembered Home/Away choice. Unknown occupancy
  is not assumed to mean Away; an active guest hold can supply effective Home.
- Home/Away selections are immediate. The Away-delay setting, UI and settings
  route are removed. Old countdown fields are discarded without a startup upload.
- Guest hold and Holiday return/preheat remain separate deadline features. An
  overdue deadline after restart requires explicit recovery.
- A new automatic request prepares its own fresh Scheduled baseline. Manual
  previews retain their reviewed baseline and expiry/conflict checks.
- Later different requests survive earlier failed uploads. Failed identical
  requests and genuinely unknown outcomes are never automatically replayed or
  reported confirmed merely because a diagnostic read happens to match.
- A newer selection aborts obsolete automatic work. The provider finishes any
  submitted command, stops unsent commands, then releases the same device queue
  before the latest request prepares a fresh baseline. Writes do not overlap.
- Authenticated proof of a known supersession can permit a fresh latest request
  even after a Home/Away/Home round trip. A cancellation flag alone cannot turn
  an unknown native write into a safe identical retry.
- Obsolete success cannot confirm a newer request. Explicit selection after
  restart can restore a newer profile blocked behind a different interrupted
  request; startup and timer refreshes do not replay that request themselves.

An external delayed departure remains the automation's responsibility. Arrival
must invalidate the pending departure before selecting Home. Selecting Home
cannot cancel a sleeping shortcut that later sends Home off. Overlapping runs
need a restartable helper or per-run identifier. No external helper or shortcut
has been created by this work.

## Cancellation contract and API budget

The Tuya `.7` and `.8` providers advertise `automaticCancellation: true`. The
authenticated `/provider/cancel-automatic` route accepts only an owned automatic
preview token and does not wait behind that preview's applying queue. The callback reaches the
native packet guards and existing post-authentication HTTP dispatch guard.
Cancellation is local IPC, not another Tuya cloud connection or command.

Shared `.8` remains compatible with the earlier `.6` device provider by allowing
the already submitted apply operation to finish before preparing the latest
selection. That provider does not advertise or promise per-command cancellation.
Use the paired `.7` or later provider to obtain that stronger behaviour. Hive's
single whole-week command is allowed to finish once submitted; an obsolete unsent
preview is consumed/discarded locally without another cloud read or upload.

Preserve the validated optimisations: queue-owned one-shot fresh baselines,
grouped native inquiries and writes, memory-only capability caching, fresh group
membership/availability/mode checks and complete per-room readbacks. Do not add a
second controller baseline read or fall back to individual commands after an
uncertain group result.

For six changed FastWarm rooms, grouped inquiries and one packet per room, the
expected Home path requires 23 Tuya HTTP attempts cold or 22 warm. One identical
Away packet shared by all six is expected to require 19 cold or 18 warm. These
are projected normal paths backed by offline request-count regressions. The
no-change check was measured live at nine cold and eight warm. Authentication,
retries and unrelated polling are extra; none of these counts is a guarantee of
Tuya billing. Retain the distinction when estimating a monthly request budget.

Guarded Hive changes retain three cloud reads and one schedule upload; an already
matching week uses two reads and no upload. Hive traffic is separate from Tuya.

## Relevant code

In `homebridge-heating-programmes`:
- `src/controller/Controller.ts`, `ControlPolicy.ts`: shared policy, state queue,
  latest-intent handling, failed-request identity and lifecycle.
- `src/platform.ts`: stable grouped controls and `/home` handler binding.
- `src/tuya/TuyaIpcTransport.ts`: guarded preview ownership and local cancellation.
- `src/hive/`: single-week guarded upload, cancellation before submission and
  unchanged native Holiday/demand preconditions.
- `homebridge-ui/`: editor relay, immediate-selection help and script cache hash.

In `homebridge-tuya`:
- `src/device/schedule/TuyaProgrammeProvider.ts`,
  `TuyaProgrammeProviderServer.ts`: owned automatic leases and cancellation IPC.
- `src/device/schedule/FastWarmActiveTarget.ts`: time-zone/current-period calculation.
- `src/device/schedule/FastWarmScheduleManager.ts`: native command boundaries,
  fresh baselines and full-week verification.
- Existing `FastWarmGroupCommandBroker.ts` and `TuyaOpenAPI.ts` dispatch guards
  remain the foundation for grouping and authenticated request safety.

## Hardware evidence and limits

FastWarm hardware is ET-63 / Smart WiFi 2.0, product `lmtejj3f4kafi2k1`, with seven
days and four periods per day. Existing cloud group tests changed one period on
all six group members and verified exact restoration. Six-byte event writes and
complete individual weekly readbacks are validated. A 21-byte full-day report
alone is not proof that the corresponding full-day write is supported.

The historical mixed-Monday incident retains simulated regressions; its exact
physical cause is not established. The installed Holiday/Home round trip now has
the bounded full-week and active-target hardware evidence above. Do not generalise
that result to every firmware, DST boundary or WAN outage.

Do not enable temporary boosts/setbacks: the original combined Hold command failed
and later online sequence/timer results do not establish reliable restoration
across a changing native programme boundary. Keep the historical boundary jobs
and evidence frozen; do not rearm or reschedule them as part of this port.

WAN-independent execution of an uploaded week, thermostat clock retention/DST,
remain distinct hardware checks. The bounded LAN evidence and optional transport
are described above; it does not establish universal firmware compatibility or
WAN-independent startup. No automatic cloud fallback is introduced.

## Validation and deployment safeguards

- Shared: `npm test` builds the plugin and passes all **289** offline tests,
  including the Unix-socket transport, editor relay and owner-lock suites.
- Tuya: `npm run lint` and `npm run build` pass. The command below passes **590**
  tests in **36** suites. Only the two real-account suites are excluded; local
  socket integration suites are included and pass.

  ```sh
  npm test -- --runInBand --watchman=false --testPathIgnorePatterns test/home.test.ts test/custom.test.ts
  ```

- The active-target paired and single-provider installers/verifiers pass **40**
  and **50** tests. The earlier future-Sunday helper retains **15** offline tests.
  These helper tests do not establish a universal hardware timing guarantee.
- Regression coverage includes both providers, failed Holiday then newer Home,
  unknown occupancy, Home/Away/Home cancellation, cancellation arriving before
  apply, interrupted restart restoration, stale/manual confirmation, grouped
  budget checks, fresh post-activation week proof and editor asset hashes.
- Known pre-claim cancellation requires an authenticated `notApplied: true`
  acknowledgement. A late apply, missing proof, failed cancellation or previously
  claimed write cannot invent that proof or convert an unknown outcome.
- Shared source/tests/handover and the full newly published Tuya content were
  checked for credentials and personal setup data. Runtime files, private
  installation receipts, dependency directories and old private author metadata
  are excluded from the public snapshots. The public source trees match the
  tested implementation trees exactly before these documentation-only commits.

For any future installation, back up saved profiles, history, enrollment, shared
policy, root configuration and child-bridge pairing/accessory caches. Keep the
paired versions together when checking command cancellation. Preserve
the existing grouped accessory/child bridge identities and provider configuration.

Shared policy remains schema version 1 but `.8` omits `awayDelayMinutes` and
`pendingAwayAt` when saving. A downgrade to `.7` requires restoring its matching
pre-upgrade `HeatingProgrammes.json` backup because `.7` requires those fields.
No rollback should invent a countdown, replay an interrupted upload or overwrite
a newer programme without review.

Read-only startup and both providers/controls were verified for this installation,
followed by complete native-week checks, the bounded future-period test, native
event hand-back and the full active-target Holiday/Home round trip above. Future live tests still require confirmed physical clocks/weekdays,
fresh baseline evidence and a controlled plan with verified restoration. Do not
infer universal hardware correctness from the offline suite, a cloud
acknowledgement or this one test. Unknown writes require review; no automatic
replay.
