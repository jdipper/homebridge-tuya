/* global homebridge */
'use strict';

/** Keep independent property reports separate; missing fields are not missing readings. */
function buildTemperatureHistorySeries(points, measuredGapMs = 30 * 60000) {
  const reports = (Array.isArray(points) ? points : [])
    .filter(point => point && Number.isFinite(point.at))
    .map(point => ({ ...point, plotAt: Number.isFinite(point.sourceAt) ? point.sourceAt : point.at }))
    .sort((a, b) => a.plotAt - b.plotAt);
  const series = {};
  for (const key of ['currentTemperature', 'targetTemperature']) {
    const segments = [];
    let segment = [];
    let previousAt;
    const flush = () => {
      if (segment.length) {
        segments.push(segment);
        segment = [];
      }
      previousAt = undefined;
    };
    for (const report of reports) {
      if (report.online === false) {
        flush();
        continue;
      }
      if (!Number.isFinite(report[key])) {
        continue;
      }
      if (key === 'currentTemperature' && previousAt !== undefined && report.plotAt - previousAt > measuredGapMs) {
        flush();
      }
      segment.push({ at: report.plotAt, temperature: report[key] });
      previousAt = report.plotAt;
    }
    flush();
    series[key] = segments;
  }
  return { reports, ...series };
}

function scheduleRoomLabel(room, rooms = []) {
  const name = room.name || room.roomName || room.deviceName || 'Thermostat';
  return rooms.filter(item => (item.name || item.roomName || item.deviceName || 'Thermostat') === name).length > 1
    ? `${name} · …${String(room.id).slice(-6)}` : name;
}

/** A partial native read is evidence, never a template for invented periods. */
function copyCompleteNativeProgramme(schedule) {
  const days = [1, 2, 4, 8, 16, 32, 64];
  if (!schedule || schedule.complete !== true || !Array.isArray(schedule.days)
    || schedule.days.length !== days.length) {
    throw new Error('A complete programme with all 28 periods is required.');
  }
  const result = { days: days.map(day => {
    const matches = schedule.days.filter(item => item.day === day);
    if (matches.length !== 1 || matches[0].complete === false || !Array.isArray(matches[0].events) || matches[0].events.length !== 4) {
      throw new Error('A complete programme with all 28 periods is required.');
    }
    let previous = -1;
    return { day, events: [0, 1, 2, 3].map(event => {
      const events = matches[0].events.filter(item => item.event === event);
      const item = events[0];
      if (events.length !== 1 || item.complete === false || !Number.isInteger(item.hour) || item.hour < 0 || item.hour > 23
        || !Number.isInteger(item.minute) || item.minute < 0 || item.minute > 59
        || !Number.isFinite(item.temperature) || item.temperature < 5 || item.temperature > 40
        || !Number.isInteger(item.temperature * 2) || item.hour * 60 + item.minute <= previous) {
        throw new Error('The programme contains an invalid or missing period.');
      }
      previous = item.hour * 60 + item.minute;
      return { event, hour: item.hour, minute: item.minute, temperature: item.temperature };
    }) };
  }) };
  return result;
}

function cloneProgrammeForRooms(schedule, deviceIds) {
  return deviceIds.map(deviceId => ({ deviceId, schedule: JSON.parse(JSON.stringify(schedule)) }));
}

const THERMOSTAT_BUSY_STATUSES = ['reading', 'verifying', 'applying', 'queued', 'overriding', 'resuming'];

/** Verification compares a saved draft with the device; it never prepares an upload. */
function savedProgrammeVerification(room, profile, options = {}) {
  const name = { home: 'Home', away: 'Away', holiday: 'Holiday' }[profile];
  let reason = '';
  if (!name) { reason = 'Choose Home, Away or Holiday to verify a saved programme.'; }
  else if (options.online === false || room.online !== true) { reason = 'The thermostat and heating controller must be online to verify a programme.'; }
  else if (options.pending || THERMOSTAT_BUSY_STATUSES.includes(room.sync && room.sync.status)) { reason = 'Wait for the current operation to finish before verifying.'; }
  else if (room.override && (room.override.recoveryRequired || room.override.status
    && !['completed', 'cancelled', 'failed', 'idle'].includes(room.override.status))) {
    reason = 'Restore the programme after the temporary temperature before verifying it.';
  }
  else if (options.dirty) { reason = `Save the edited ${name} draft before verifying its saved programme.`; }
  else {
    try {
      copyCompleteNativeProgramme({ ...(room.profiles && room.profiles[profile]), complete: true });
    } catch {
      reason = `Save a complete ${name} programme before verifying it.`;
    }
  }
  return { allowed: !reason, reason, request: reason ? null : { deviceIds: [room.id], verifyProfile: profile } };
}

/** Household intent is independent of the programme tab being edited. */
function householdProgrammeIntent(view) {
  const presence = view.presence || {};
  const holiday = view.holiday || {};
  if (holiday.preheating) { return 'home'; }
  if (holiday.active) { return 'holiday'; }
  const home = presence.effectiveHome === undefined ? presence.home : presence.effectiveHome;
  return home === true ? 'home' : home === false ? 'away' : null;
}

function householdProgrammeContext(view, formatDate = value => new Date(value).toLocaleString()) {
  const presence = view.presence || {};
  const holiday = view.holiday || {};
  if (view.controls && view.controls.recoveryRequired || holiday.recoveryRequired) {
    return 'Household timers are paused for review. Open Presence, guests & holiday return to resume them.';
  }
  if (holiday.preheating) { return 'Holiday preheat: Home programme requested before your return.'; }
  if (holiday.active) { return 'Holiday programme requested. Holiday takes priority; presence is remembered for your return.'; }
  if (presence.holdUntil) { return `Guest hold: Home programme requested until ${formatDate(presence.holdUntil)}.`; }
  if (presence.pendingAwayAt) {
    const current = householdProgrammeIntent(view);
    return `Away scheduled for ${formatDate(presence.pendingAwayAt)}.${current === 'home' ? ' Home remains requested until then.'
      : current === 'away' ? ' Away is already requested.' : ' No household programme is currently requested.'}`;
  }
  const profile = householdProgrammeIntent(view);
  return profile === 'home' ? 'Someone is home. Home programme requested.'
    : profile === 'away' ? 'Everyone is away. Away programme requested.' : 'Presence has not been set.';
}

/** A remembered profile name or a successful read alone does not confirm an upload. */
function roomProgrammeFeedback(room, options = {}) {
  const names = { home: 'Home', away: 'Away', holiday: 'Holiday' };
  const sync = room.sync || {};
  const requested = options.profile || sync.requestedProfile;
  const name = names[requested] || 'Programme';
  const attemptedName = names[sync.lastAttemptedProfile] || name;
  const confirmedName = names[sync.confirmedProfile];
  const date = value => typeof options.formatDate === 'function' ? options.formatDate(value) : new Date(value).toLocaleString();
  const confirmedAt = Number.isFinite(sync.confirmedAt) && sync.confirmedAt > 0 ? sync.confirmedAt : null;
  const previous = confirmedName ? `Last confirmed: ${confirmedName}${confirmedAt ? ` · ${date(confirmedAt)}` : ''}.` : 'No programme confirmed yet.';
  const result = (kind, title, detail) => ({ id: room.id, kind, title, detail, requestedProfile: requested || null, confirmedAt });
  if (options.online === false) {
    return result('offline', 'Confirmation unavailable', `The heating controller is unavailable. ${previous}`);
  }
  const override = room.override || {};
  if (override.recoveryRequired || override.status === 'recovery-required') {
    return result('attention', 'Programme restoration needs attention', override.error || 'Open Room details to retry restoring the programme.');
  }
  if (room.online !== true) {
    return result('offline', `Offline · ${requested ? `${name} not confirmed` : room.enabled ? 'no programme requested' : 'automatic changes off'}`, previous);
  }
  if (sync.status === 'verifying') {
    return result('checking', `Verifying saved ${names[sync.lastAttemptedProfile] || names[requested] || 'programme'}`,
      `Checking the stored programme and Scheduled mode only; no programme upload or mode change. ${previous}`);
  }
  if (sync.error || ['failed', 'partial', 'conflict'].includes(sync.status)
    || ['failed', 'partial'].includes(sync.profileStatus)) {
    return result('attention', `${attemptedName} needs attention`, `${sync.error || 'The programme update has not been confirmed.'}${requested && names[sync.lastAttemptedProfile]
      && sync.lastAttemptedProfile !== requested ? ` ${name} remains requested.` : ''} ${previous}`);
  }
  if (override.status && !['completed', 'cancelled', 'failed', 'idle'].includes(override.status)) {
    return result('attention', `${name} not active`, `A temporary temperature is active or being restored. ${previous}`);
  }
  if (['applying', 'queued'].includes(sync.status) || sync.profileStatus === 'applying') {
    const applyingProfile = sync.applyingProfile || sync.queuedProfile || sync.lastAttemptedProfile;
    const applyingName = names[applyingProfile];
    const title = applyingName ? `${sync.status === 'queued' && !sync.applyingProfile ? 'Queued' : 'Applying'} ${applyingName}` : 'Programme update in progress';
    return result('applying', title, `${requested ? `${name} requested. ` : ''}Waiting for the complete programme and Scheduled mode to be confirmed. ${previous}`);
  }
  if (sync.status === 'reading') {
    if (names[sync.queuedProfile]) {
      return result('applying', `${names[sync.queuedProfile]} queued`, `A programme read is finishing before the queued update can start. ${previous}`);
    }
    return result('checking', `Checking ${name}`, `Reading the programme from the thermostat. ${previous}`);
  }
  if (!requested) {
    return room.enabled ? result('pending', 'Waiting for household selection', `Choose Home, Away or Holiday to request a programme. ${previous}`)
      : result('inactive', 'Automatic changes off', previous);
  }
  if (sync.requestedProfile !== requested) {
    return result('pending', `${name} needs applying`, `${sync.requestedProfile ? `${names[sync.requestedProfile]} is currently requested. ` : ''}${previous}`);
  }
  if (sync.confirmationMatchesRequested === true && sync.profileStatus === 'confirmed'
    && sync.confirmedProfile === requested && confirmedAt && room.mode === 'smart' && room.schedule && room.schedule.complete === true) {
    return result('confirmed', `${name} confirmed`, `Programme read back and Scheduled mode confirmed${confirmedAt ? ` · ${date(confirmedAt)}` : ''}.`);
  }
  if (room.mode && room.mode !== 'smart') {
    return result('attention', `${name} not active`, `The thermostat reports ${room.mode === 'hold' ? 'Hold' : room.mode === 'holiday' ? 'native Holiday' : room.mode} mode. ${previous}`);
  }
  return result('pending', `${name} needs applying`, `The saved ${name} programme is not currently confirmed on this thermostat. ${previous}`);
}

function buildProgrammeFeedback(view, options = {}) {
  const names = { home: 'Home', away: 'Away', holiday: 'Holiday' };
  const profile = householdProgrammeIntent(view);
  const name = names[profile] || 'Programme';
  const enabled = (view.thermostats || []).filter(room => room.enabled);
  const rooms = enabled.map(room => ({ ...roomProgrammeFeedback(room, { ...options, profile }),
    name: scheduleRoomLabel(room, view.thermostats) }));
  const total = rooms.length;
  const count = kind => rooms.filter(room => room.kind === kind).length;
  const confirmed = count('confirmed');
  const counts = { total, confirmed, applying: count('applying'), checking: count('checking'),
    pending: count('pending'), offline: count('offline'), attention: count('attention') };
  const result = (kind, title, detail) => ({ kind, title, detail, profile, counts, rooms });
  if (options.online === false) {
    return result('offline', 'Controller unavailable · confirmation paused', 'Reconnect to Homebridge to check the programme results. The last displayed state is not a fresh confirmation.');
  }
  if (!total) {
    return result('neutral', 'No rooms enabled for automatic changes', 'Home and Holiday switches will not apply programmes to any room. Enable “Use saved profiles for automatic household changes” in a room’s programme editor.');
  }
  const recovery = view.controls && view.controls.recoveryRequired || view.holiday && view.holiday.recoveryRequired;
  if (recovery) {
    return result('attention', `Household timers need review · ${confirmed} of ${total} rooms confirmed`, 'Open Presence, guests & holiday return to review and resume the timers.');
  }
  if (!profile) {
    return result('neutral', 'Choose Home, Away or Holiday to request a programme', 'Household presence has not been set. No automatic household programme is currently selected.');
  }
  const progress = `${confirmed} of ${total} rooms confirmed`;
  const attention = rooms.filter(room => ['attention', 'offline'].includes(room.kind));
  if (attention.length) {
    const labels = attention.map(room => `${room.name}${room.kind === 'offline' ? ' (offline)' : ''}`).join(', ');
    return result('attention', `${name} · ${progress} · ${attention.length} need${attention.length === 1 ? 's' : ''} attention`,
      `${labels}.${counts.applying ? ` Updates are still running in ${counts.applying} room${counts.applying === 1 ? '' : 's'}.` : ''} See each room’s result below.`);
  }
  if (counts.applying) {
    const olderUpdate = enabled.some(room => room.sync && (room.sync.applyingProfile || room.sync.queuedProfile)
      && (room.sync.applyingProfile || room.sync.queuedProfile) !== profile);
    return result('applying', `${olderUpdate ? `Updating programmes · ${name} requested` : `Applying ${name}`} · ${progress}`,
      'Each room is confirmed after its complete programme is read back and Scheduled mode is checked.');
  }
  if (counts.checking) {
    const otherVerification = enabled.some(room => room.sync && room.sync.status === 'verifying'
      && room.sync.lastAttemptedProfile && room.sync.lastAttemptedProfile !== profile);
    return result('applying', `${otherVerification ? `Checking programmes · ${name} requested` : `Checking ${name}`} · ${progress}`,
      'Waiting for programme checks to finish. A raw programme read alone does not verify a saved profile.');
  }
  if (confirmed === total) {
    return result('confirmed', total === 1 ? `${name} confirmed in 1 room` : `${name} confirmed on all ${total} rooms`,
      'Each saved programme matched its read-back and Scheduled mode at its last confirmation. See the room timestamps below.');
  }
  return result('pending', `${name} · ${progress} · needs applying`, 'Some enabled rooms have not confirmed the requested saved programme. Review their results below; saved drafts alone do not change the heating.');
}

if (typeof module === 'object' && module.exports) {
  module.exports = { buildTemperatureHistorySeries, scheduleRoomLabel, copyCompleteNativeProgramme, cloneProgrammeForRooms,
    savedProgrammeVerification, householdProgrammeIntent, householdProgrammeContext, roomProgrammeFeedback, buildProgrammeFeedback };
}

(() => {
  if (typeof document === 'undefined') {
    return;
  }
  const DAYS = [
    { id: 1, name: 'Monday' }, { id: 2, name: 'Tuesday' }, { id: 4, name: 'Wednesday' },
    { id: 8, name: 'Thursday' }, { id: 16, name: 'Friday' }, { id: 32, name: 'Saturday' },
    { id: 64, name: 'Sunday' },
  ];
  const EVENTS = ['Wake', 'Leave', 'Return', 'Sleep'];
  const PROFILES = { home: 'Home', away: 'Away', holiday: 'Holiday' };
  const MODES = { smart: 'Scheduled', hold: 'Hold', holiday: 'Native holiday' };
  const STATUSES = {
    verified: 'Confirmed', partial: 'Incomplete', failed: 'Failed', conflict: 'Changed elsewhere',
    reading: 'Reading', verifying: 'Verifying saved programme', applying: 'Applying', queued: 'Queued', idle: 'Not yet confirmed',
    pending: 'Pending', unknown: 'Unknown',
    overriding: 'Starting temporary temperature', resuming: 'Restoring programme',
    starting: 'Starting', active: 'Temporary temperature active', 'recovery-required': 'Restoration needs attention',
  };
  const BUSY = new Set(THERMOSTAT_BUSY_STATUSES);
  const state = {
    view: { thermostats: [], presence: { home: null }, holiday: { active: false } },
    instanceId: null,
    profile: 'home',
    drafts: new Map(),
    selected: new Set(),
    pending: false,
    preview: null,
    poll: null,
    settings: false,
    online: false,
    forms: new Map(),
    history: new Map(),
    versions: new Map(),
    readRequests: new Set(),
    nativeImports: new Map(),
    sharedEditors: new Map(),
    sharedOpen: false,
  };
  const byId = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  const button = (text, action, className = '') => {
    const node = element('button', `schedule-button ${className}`, text);
    node.type = 'button';
    node.disabled = state.pending;
    node.addEventListener('click', action);
    return node;
  };
  const draftKey = (id, profile = state.profile) => `${state.instanceId}:${id}:${profile}`;
  const thermostat = id => state.view.thermostats.find(room => room.id === id);
  const roomLabel = room => scheduleRoomLabel(room, state.view.thermostats);
  const selectedRooms = () => state.view.thermostats.filter(room => state.selected.has(room.id));
  const formatTemperature = value => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)}°C` : 'Unavailable';
  const timeText = event => event && Number.isInteger(event.hour) && Number.isInteger(event.minute)
    ? `${String(event.hour).padStart(2, '0')}:${String(event.minute).padStart(2, '0')}` : '';
  const eventText = event => event && timeText(event) && typeof event.temperature === 'number'
    ? `${timeText(event)} · ${event.temperature.toFixed(1)}°C` : 'Not received';
  const formatDate = value => {
    if (value === undefined || value === null) {
      return 'Not yet received';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not yet received' : date.toLocaleString();
  };
  const dateInputValue = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return '';
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  const asTimestamp = value => value ? new Date(value).getTime() : null;
  const later = minutes => Date.now() + minutes * 60000;
  const formatZonedDate = (value, timeZone) => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      }).format(new Date(value));
    } catch {
      return formatDate(value);
    }
  };

  function field(labelText, key, options = {}) {
    const wrapper = element('label', 'control-field');
    const input = element(options.options ? 'select' : 'input');
    if (options.options) {
      options.options.forEach(option => {
        const node = element('option', '', option.label);
        node.value = option.value;
        node.disabled = !!option.disabled;
        input.append(node);
      });
    } else {
      input.type = options.type || 'text';
      for (const attribute of ['min', 'max', 'step', 'placeholder', 'maxLength']) {
        if (options[attribute] !== undefined) {
          input[attribute] = options[attribute];
        }
      }
    }
    input.value = state.forms.has(key) ? state.forms.get(key) : options.value ?? '';
    input.dataset.focus = key;
    input.disabled = state.pending || options.disabled;
    input.addEventListener('input', () => state.forms.set(key, input.value));
    wrapper.append(element('span', '', labelText), input);
    return { wrapper, input };
  }

  function forgetForm(prefix) {
    for (const key of state.forms.keys()) {
      if (key.startsWith(prefix)) {
        state.forms.delete(key);
      }
    }
  }

  function details(key, label, className = '') {
    const node = element('details', `room-details ${className}`);
    node.dataset.detail = key;
    node.append(element('summary', '', label));
    return node;
  }

  function showMessage(text, kind = '') {
    const node = byId('message');
    node.textContent = text;
    node.className = `schedule-message ${kind}`;
    node.hidden = !text;
  }

  async function request(path, payload = {}, instanceId = state.instanceId) {
    return homebridge.request(path, { ...payload, instanceId });
  }

  function normaliseSchedule(schedule) {
    return {
      days: DAYS.map(day => {
        const source = schedule && Array.isArray(schedule.days)
          ? schedule.days.find(item => item.day === day.id) : undefined;
        return {
          day: day.id,
          events: EVENTS.map((name, eventId) => {
            const event = source && Array.isArray(source.events)
              ? source.events.find(item => item.event === eventId) : undefined;
            return {
              event: eventId,
              hour: event && Number.isInteger(event.hour) ? event.hour : null,
              minute: event && Number.isInteger(event.minute) ? event.minute : null,
              temperature: event && typeof event.temperature === 'number' ? event.temperature : null,
            };
          }),
        };
      }),
    };
  }

  function getDraft(room, profile = state.profile) {
    const key = draftKey(room.id, profile);
    if (!state.drafts.has(key)) {
      state.drafts.set(key, {
        schedule: normaliseSchedule(room.profiles && room.profiles[profile]),
        dirty: false,
      });
    }
    return state.drafts.get(key);
  }

  function validateSchedule(schedule) {
    const errors = [];
    for (const [index, day] of schedule.days.entries()) {
      let previous = -1;
      for (const event of day.events) {
        if (!Number.isInteger(event.hour) || event.hour < 0 || event.hour > 23
          || !Number.isInteger(event.minute) || event.minute < 0 || event.minute > 59
          || typeof event.temperature !== 'number' || !Number.isFinite(event.temperature)
          || event.temperature < 5 || event.temperature > 40 || !Number.isInteger(event.temperature * 2)) {
          errors.push(`${DAYS[index].name}: enter a time and a temperature from 5–40°C in 0.5°C steps for every period.`);
          break;
        }
        const minutes = event.hour * 60 + event.minute;
        if (minutes <= previous) {
          errors.push(`${DAYS[index].name}: Wake, Leave, Return and Sleep must be in time order.`);
          break;
        }
        previous = minutes;
      }
    }
    return errors;
  }

  function updateSelection() {
    const rooms = state.view.thermostats;
    const selected = selectedRooms();
    const unsaved = selected.filter(room => getDraft(room).dirty);
    const unsavedShared = state.sharedOpen && sharedDraft().dirty;
    const missing = selected.filter(room => !room.profiles || !room.profiles[state.profile]
      || validateSchedule(normaliseSchedule(room.profiles[state.profile])).length);
    byId('apply-selected').disabled = !selected.length || unsavedShared || !!unsaved.length || !!missing.length || state.pending || !state.online;
    byId('select-all').checked = rooms.length > 0 && rooms.every(room => state.selected.has(room.id));
    byId('select-all').indeterminate = state.selected.size > 0 && !byId('select-all').checked;
    byId('select-all').disabled = state.pending;
    byId('selection-count').textContent = selected.length ? `${selected.length} of ${rooms.length} rooms selected` : 'No rooms selected';
    byId('edit-all').disabled = !rooms.length || state.pending;
    byId('load-stored').disabled = !rooms.length || state.pending || !state.online;
    byId('load-stored').textContent = selected.length ? `Load stored programmes · ${selected.length} rooms` : 'Load stored programmes · all rooms';
    byId('save-selected').disabled = !selected.some(room => getDraft(room).dirty) || state.pending || !state.online;
    byId('apply-selected').textContent = selected.length ? `Review & apply · ${selected.length} rooms` : 'Review & apply selected';
    byId('bulk-help').textContent = unsavedShared
      ? 'Save the shared programme for selected rooms before reviewing. Closing the shared editor lets you review the saved room drafts.'
      : unsaved.length
      ? `Save the edited ${PROFILES[state.profile]} drafts before reviewing. Loading and editing do not change the heating.`
      : missing.length
        ? `${missing.length} selected room${missing.length === 1 ? ' needs' : 's need'} a complete saved ${PROFILES[state.profile]} programme. Load stored programmes or edit a programme for all rooms, then save.`
        : selected.length
          ? `Ready to review each room’s saved ${PROFILES[state.profile]} programme. Applying is a separate step after review.`
          : 'Select rooms, or edit a programme for all rooms. Loading reads each room’s stored programme into its own draft.';
    document.querySelectorAll('[data-profile]').forEach(tab => { tab.disabled = state.pending; });
    const instanceSelector = byId('instance-selector');
    if (instanceSelector) { instanceSelector.disabled = state.pending; }
    const sharedSave = byId('save-shared');
    if (sharedSave) {
      sharedSave.disabled = !selected.length || state.pending || !state.online;
      sharedSave.textContent = `Save programme for ${selected.length} room${selected.length === 1 ? '' : 's'}`;
    }
    updateVerificationControls();
  }

  function acceptView(view) {
    if (!view || !Array.isArray(view.thermostats)) {
      throw new Error('The heating controller returned an incomplete view.');
    }
    state.view = view;
    state.online = true;
    const completed = [];
    for (const id of state.readRequests) {
      const room = view.thermostats.find(item => item.id === id);
      if (room && !BUSY.has(room.sync && room.sync.status)) {
        completed.push(room);
        state.readRequests.delete(id);
      }
    }
    if (completed.length) {
      let failed = completed.some(room => !room.schedule || !room.schedule.complete);
      const loadedProfiles = new Set();
      const sharedProfiles = new Set();
      const results = completed.map(room => {
        const pending = state.nativeImports.get(room.id);
        if (!pending) {
          return `${roomLabel(room)}: ${room.schedule && room.schedule.complete
            ? 'all 28 programme periods received' : room.sync && room.sync.error || 'programme read finished with missing periods'}`;
        }
        state.nativeImports.delete(room.id);
        try {
          if (!room.lastUpdated || room.lastUpdated === pending.previousRead
            || typeof room.scheduleFingerprint !== 'string' || !room.scheduleFingerprint.trim()) {
            throw new Error(room.sync && room.sync.error || 'A fresh complete programme was not received; draft unchanged.');
          }
          const schedule = copyCompleteNativeProgramme(room.schedule);
          if (pending.sharedKey) {
            const shared = state.sharedEditors.get(pending.sharedKey);
            if (shared) {
              if (JSON.stringify(shared.schedule) !== pending.originalDraft) {
                throw new Error('The shared draft was edited while reading; it has been kept.');
              }
              shared.schedule = schedule;
              shared.dirty = true;
              shared.sourceId = room.id;
            }
          } else {
            const draft = getDraft(room, pending.profile);
            if (JSON.stringify(draft.schedule) !== pending.originalDraft) {
              throw new Error('The draft was edited while reading; it has been kept.');
            }
            draft.schedule = schedule;
            draft.dirty = true;
          }
          (pending.sharedKey ? sharedProfiles : loadedProfiles).add(PROFILES[pending.profile]);
          return null;
        } catch (error) {
          failed = true;
          return `${roomLabel(room)}: ${error.message} Draft unchanged`;
        }
      }).filter(Boolean);
      if (loadedProfiles.size) {
        results.unshift(`Stored programmes loaded into ${Array.from(loadedProfiles).join(', ')} drafts. Save selected drafts when ready; heating is unchanged`);
      }
      if (sharedProfiles.size) {
        results.unshift(`Stored programme loaded into the shared ${Array.from(sharedProfiles).join(', ')} editor. Edit and save it to selected rooms when ready; heating is unchanged`);
      }
      showMessage(results.join('. '), failed ? 'error' : 'success');
    }
    const activeDraft = document.activeElement && document.activeElement.dataset.focus;
    for (const room of view.thermostats) {
      for (const profile of Object.keys(PROFILES)) {
        const old = state.drafts.get(draftKey(room.id, profile));
        if (old && !old.dirty && !(activeDraft && activeDraft.startsWith(`${draftKey(room.id, profile)}:`))) {
          old.schedule = normaliseSchedule(room.profiles && room.profiles[profile]);
        }
      }
    }
    const ids = new Set(view.thermostats.map(room => room.id));
    for (const id of state.selected) {
      if (!ids.has(id)) {
        state.selected.delete(id);
      }
    }
    // Native time/number inputs can hold partially typed values that are not
    // represented by .value yet. A status poll must not replace that input.
    const editing = document.activeElement && document.activeElement.matches('#tuya-schedules input, #tuya-schedules select');
    if (!editing) {
      render();
    } else {
      // Status changes must remain visible without replacing an input mid-edit.
      renderProgrammeFeedback();
    }
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    const running = state.view.thermostats.some(room => BUSY.has(room.sync && room.sync.status));
    state.poll = setTimeout(() => refresh(false), running ? 2000 : 10000);
  }

  async function refresh(showProgress = true) {
    if (!state.instanceId || state.pending) {
      schedulePoll();
      return;
    }
    try {
      if (showProgress) {
        byId('refresh').disabled = true;
      }
      acceptView(await request(showProgress ? '/rooms/refresh' : '/thermostats'));
      if (showProgress) {
        showMessage('Thermostat status refreshed.');
      }
    } catch (error) {
      state.online = false;
      showMessage(`${error.message || 'The heating controller is unavailable.'} Your open drafts are kept on this page.`, 'error');
      renderProgrammeFeedback();
      updateSelection();
      schedulePoll();
    } finally {
      byId('refresh').disabled = false;
    }
  }

  async function action(path, payload, message, messageKind = 'success') {
    state.pending = true;
    render();
    try {
      const view = await request(path, payload);
      acceptView(view);
      showMessage(message, messageKind);
      return view;
    } catch (error) {
      showMessage(error.message || 'The request could not be completed.', 'error');
      throw error;
    } finally {
      state.pending = false;
      render();
    }
  }

  function appendStat(container, label, value, className = '') {
    const stat = element('div');
    stat.append(element('span', 'stat-label', label), element('span', `stat-value ${className}`, value));
    container.append(stat);
  }

  async function readProgramme(room) {
    state.readRequests.add(room.id);
    try {
      await action('/schedules/read', { deviceIds: [room.id] }, `Reading ${room.name}. Programme reports may take a moment to arrive.`);
    } catch {
      state.readRequests.delete(room.id);
    }
  }

  async function verifySavedProgramme(room) {
    const profile = state.profile;
    const verification = savedProgrammeVerification(room, profile, {
      online: state.online, pending: state.pending, dirty: getDraft(room, profile).dirty,
    });
    if (!verification.allowed) {
      showMessage(verification.reason, 'error');
      return;
    }
    await action('/schedules/read', verification.request,
      `Verifying saved ${PROFILES[profile]} programme for ${roomLabel(room)}. Checking only; no programme upload or mode change.`, '');
  }

  const sharedKey = () => `${state.instanceId}:${state.profile}`;
  function sharedDraft() {
    const key = sharedKey();
    if (!state.sharedEditors.has(key)) {
      state.sharedEditors.set(key, { schedule: null, sourceId: '', dirty: false });
    }
    return state.sharedEditors.get(key);
  }

  async function loadStoredProgrammes(deviceIds, intoShared = false) {
    const rooms = deviceIds.map(thermostat).filter(Boolean);
    if (!rooms.length || state.pending) { return; }
    if (rooms.some(room => BUSY.has(room.sync && room.sync.status))) {
      showMessage('Wait for the selected rooms’ current operation to finish, then load their programmes.', 'error');
      return;
    }
    const dirty = intoShared ? sharedDraft().dirty : rooms.some(room => getDraft(room).dirty);
    if (dirty && !window.confirm(`Replace the unsaved ${PROFILES[state.profile]} draft${intoShared || rooms.length === 1 ? '' : 's'} with freshly read thermostat programmes?`)) {
      return;
    }
    for (const room of rooms) {
      state.nativeImports.set(room.id, { profile: state.profile, previousRead: room.lastUpdated,
        originalDraft: JSON.stringify(intoShared ? sharedDraft().schedule : getDraft(room).schedule),
        sharedKey: intoShared ? sharedKey() : undefined });
      state.readRequests.add(room.id);
    }
    try {
      await action('/schedules/read', { deviceIds: rooms.map(room => room.id) },
        `Reading ${rooms.length} thermostat${rooms.length === 1 ? '' : 's'}. Complete programmes will load into drafts; heating is unchanged.`);
    } catch {
      rooms.forEach(room => { state.nativeImports.delete(room.id); state.readRequests.delete(room.id); });
    }
  }

  async function saveSelectedDrafts(sharedSchedule) {
    const rooms = selectedRooms();
    if (!rooms.length || state.pending) { return; }
    const profile = state.profile;
    const instanceId = state.instanceId;
    const sharedAtStart = sharedSchedule ? sharedDraft() : undefined;
    const sharedVersion = sharedSchedule ? JSON.stringify(sharedSchedule) : undefined;
    if (sharedSchedule && validateSchedule(sharedSchedule).length) {
      showMessage(validateSchedule(sharedSchedule)[0], 'error');
      return;
    }
    if (sharedSchedule && rooms.some(room => getDraft(room).dirty)
      && !window.confirm(`Replace unsaved ${PROFILES[profile]} drafts in the selected rooms with this shared programme?`)) {
      return;
    }
    if (sharedSchedule) {
      for (const copy of cloneProgrammeForRooms(sharedSchedule, rooms.map(room => room.id))) {
        const draft = getDraft(thermostat(copy.deviceId), profile);
        draft.schedule = copy.schedule;
        draft.dirty = true;
      }
    }
    const toSave = rooms.filter(room => getDraft(room, profile).dirty);
    const invalid = toSave.find(room => validateSchedule(getDraft(room, profile).schedule).length);
    if (invalid) {
      showMessage(`${roomLabel(invalid)}: ${validateSchedule(getDraft(invalid, profile).schedule)[0]}`, 'error');
      render();
      return;
    }
    // Freeze routing, targets and contents before any save can refresh the view.
    const plan = toSave.map(room => ({ deviceId: room.id, label: roomLabel(room), enabled: !!room.enabled,
      draft: getDraft(room, profile), schedule: clone(getDraft(room, profile).schedule) }));
    state.pending = true;
    render();
    const results = [];
    let failed = false;
    try {
      for (const item of plan) {
        try {
          const view = await request('/profiles/save', { deviceId: item.deviceId, profile, schedule: item.schedule,
            enabled: item.enabled }, instanceId);
          if (state.instanceId === instanceId) { acceptView(view); }
          if (JSON.stringify(item.draft.schedule) === JSON.stringify(item.schedule)) { item.draft.dirty = false; }
          results.push(`${item.label}: saved`);
        } catch (error) {
          failed = true;
          results.push(`${item.label}: ${error.message || 'save failed'} — draft kept unsaved`);
        }
      }
      if (sharedAtStart && !failed && JSON.stringify(sharedAtStart.schedule) === sharedVersion) { sharedAtStart.dirty = false; }
      showMessage(`${results.join('. ')}. Heating is unchanged. Review & apply selected when ready.`, failed ? 'error' : 'success');
    } finally {
      state.pending = false;
      render();
    }
  }

  function householdOptions() {
    const container = byId('household-options');
    container.replaceChildren();
    const presence = state.view.presence || {};
    const holiday = state.view.holiday || {};
    const delay = element('div', 'control-group');
    delay.append(element('h4', '', 'Leaving home'));
    const away = field('Wait before Away (minutes)', 'household:away', {
      type: 'number', value: presence.awayDelayMinutes ?? 30, min: 0, max: 1440, step: 1,
    });
    delay.append(away.wrapper, button('Save delay', async () => {
      const minutes = Number(away.input.value);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        showMessage('Enter a whole number of minutes from 0 to 1440.', 'error');
        return;
      }
      try {
        await action('/controls/settings', { awayDelayMinutes: minutes }, 'Away delay saved. Arriving home cancels the countdown.');
        forgetForm('household:away');
      } catch { /* The action displays the error. */ }
    }));
    delay.append(element('p', 'schedule-help', 'The delay starts when the last person leaves. Home resumes immediately when someone arrives. Shortening an active countdown can select Away immediately.'));
    const guests = element('div', 'control-group');
    guests.append(element('h4', '', 'Guests staying home'));
    const hold = field('Keep Home programme until', 'household:hold', {
      type: 'datetime-local', value: dateInputValue(presence.holdUntil || later(12 * 60)),
    });
    guests.append(hold.wrapper, button('Keep Home until then', async () => {
      const until = asTimestamp(hold.input.value);
      if (!Number.isFinite(until) || until <= Date.now()) {
        showMessage('Choose a future time for the guest hold.', 'error');
        return;
      }
      try {
        await changeHousehold('/presence/hold', { until }, `Home programme held until ${formatDate(until)}.`);
        forgetForm('household:hold');
      } catch { /* The action displays the error. */ }
    }));
    guests.append(element('p', 'schedule-help', 'Holiday takes priority over a guest hold. When the hold ends, the latest household presence selects Home or Away.'));
    if (presence.holdUntil) {
      guests.append(element('p', 'schedule-help', `Guest hold ends ${formatDate(presence.holdUntil)}.`),
        button('End guest hold', () => changeHousehold('/presence/hold', { until: null }, 'Guest hold ended.').catch(() => {})));
    }
    const returning = element('div', 'control-group');
    returning.append(element('h4', '', 'Holiday return'));
    const at = field('Return time (optional)', 'household:return', {
      type: 'datetime-local', value: holiday.returnAt ? dateInputValue(holiday.returnAt) : '',
    });
    const preheat = field('Start Home programme this many minutes before return', 'household:preheat', {
      type: 'number', min: 0, max: 1440, step: 1, value: holiday.preheatMinutes ?? 0,
    });
    returning.append(at.wrapper, preheat.wrapper, button(holiday.active ? 'Update holiday return' : 'Enable holiday with return', async () => {
      const returnAt = asTimestamp(at.input.value);
      const preheatMinutes = Number(preheat.input.value);
      if ((returnAt !== null && (!Number.isFinite(returnAt) || returnAt <= Date.now()))
        || !Number.isInteger(preheatMinutes) || preheatMinutes < 0 || preheatMinutes > 1440) {
        showMessage('Choose a future return time and a preheat lead from 0 to 1440 minutes.', 'error');
        return;
      }
      try {
        await changeHousehold('/holiday', { active: true, returnAt, preheatMinutes }, 'Holiday return saved.');
        forgetForm('household:return');
        forgetForm('household:preheat');
      } catch { /* The action displays the error. */ }
    }));
    returning.append(element('p', 'schedule-help', 'Times use this browser’s local time zone. Homebridge must be running and connected to Tuya to change programmes at the return or preheat time. Leave return blank to end Holiday manually.'));
    if (holiday.returnAt) {
      returning.append(element('p', 'schedule-help', `Return: ${formatDate(holiday.returnAt)}${holiday.preheatMinutes ? ` · preheat ${holiday.preheatMinutes} minutes earlier` : ''}.`));
    }
    if (holiday.recoveryRequired) {
      returning.append(element('p', 'schedule-notice', 'The holiday return could not be confirmed. Check the room sync results and select the required household programme.'));
    }
    container.append(delay, guests, returning);
    if (state.view.controls && state.view.controls.recoveryRequired) {
      const recovery = element('div', 'control-group recovery-notice');
      recovery.append(element('h4', '', 'Review interrupted household changes'),
        element('p', 'schedule-notice', state.view.controls.recoveryRequired),
        button('Review & resume household control', () => {
          if (window.confirm('Reconcile overdue holiday, guest-hold and presence timers now? This can upload the selected saved programme and activate scheduled mode on enrolled thermostats. Temporary temperatures that need recovery are handled separately in each room.')) {
            action('/controls/recover', { confirm: true }, 'Household control recovery requested. Check each room’s confirmed programme.').catch(() => {});
          }
        }));
      container.append(recovery);
    }
  }

  function nowAndNext(room) {
    const line = element('div', 'now-next');
    const data = room.nowNext || {};
    const current = data.current;
    if (current) {
      line.append(element('span', '', `Planned period: ${typeof current.event === 'number' ? EVENTS[current.event] : current.event || 'Period'} · ${formatTemperature(current.temperature)}`));
    }
    if (data.next) {
      const next = data.next;
      line.append(element('strong', '', `Planned next: ${typeof next.event === 'number' ? EVENTS[next.event] : next.event || 'Period'} · ${formatTemperature(next.temperature)} · ${formatZonedDate(next.at, data.timeZone || room.timeZone)}`));
      if (data.timeZone || room.scheduleClock && room.scheduleClock.timeZone) {
        line.append(element('span', 'last-confirmed', `Planned using ${data.timeZone || room.scheduleClock.timeZone}${data.clockVerified ? ' · thermostat clock confirmed by you' : ' · thermostat clock not confirmed'}`));
      }
      if (data.reason) {
        line.append(element('span', 'last-confirmed', data.reason));
      }
    } else {
      line.append(element('span', 'last-confirmed', data.reason || 'Next change unavailable until a complete programme and the thermostat time zone are verified.'));
    }
    return line;
  }

  function roomTools(room) {
    const tools = element('div', 'room-tools');
    const rename = element('section', 'room-setting-group');
    rename.append(element('h4', '', 'Room name & clock'));
    const form = element('div', 'inline-controls');
    const name = field('Custom display name (optional)', `${room.id}:name`, {
      value: room.customName || '', placeholder: room.roomName || room.deviceName || room.name, maxLength: 80,
    });
    form.append(name.wrapper, button('Save name', async () => {
      const value = name.input.value.trim();
      try {
        await action('/rooms/save', { deviceId: room.id, name: value }, value ? 'Custom room name saved.' : 'SmartLife room name restored.');
        forgetForm(`${room.id}:name`);
      } catch { /* The action displays the error. */ }
    }));
    rename.append(form, element('p', 'last-confirmed', `SmartLife room: ${room.roomName || 'Not assigned'} · device: ${room.sourceName || room.deviceName || room.name} · …${room.id.slice(-6)}. Leave the custom name blank to follow SmartLife.`));
    const clock = room.scheduleClock || {};
    const zone = field('Thermostat time zone (IANA name)', `${room.id}:clock:zone`, {
      value: room.timeZone || clock.timeZone || room.nowNext && room.nowNext.timeZone || '', placeholder: 'Europe/London',
    });
    const clockForm = element('div', 'inline-controls');
    clockForm.append(zone.wrapper, button('Confirm thermostat clock', async () => {
      const timeZone = zone.input.value.trim();
      try {
        new Intl.DateTimeFormat('en', { timeZone }).format();
      } catch {
        showMessage('Enter a valid IANA time zone such as Europe/London.', 'error');
        return;
      }
      if (!window.confirm(`Confirm that the clock and weekday shown on ${room.name} match ${timeZone}. This records your confirmation; it does not set the thermostat clock.`)) {
        return;
      }
      try {
        await action('/rooms/save', { deviceId: room.id, name: room.customName || '', timeZone, clockVerified: true }, 'Thermostat time zone and clock confirmation saved.');
        forgetForm(`${room.id}:clock`);
      } catch { /* The action displays the error. */ }
    }));
    rename.append(clockForm, element('p', 'last-confirmed', 'Next changes are calculated from the programme and this time zone. Check the actual thermostat clock when interpreting these planned times.'));
    tools.append(rename);

    const override = room.override || {};
    const activeOverride = override.status && !['idle', 'completed', 'cancelled', 'failed'].includes(override.status);
    const temporary = element('section', 'room-setting-group');
    temporary.append(element('h4', '', 'Temporary temperature'));
    temporary.append(element('p', 'schedule-notice', 'Unavailable pending FastWarm Hold validation. A live test did not apply and resume the requested temperature correctly, so new temporary temperatures are disabled.'));
    if (activeOverride) {
      temporary.append(element('p', 'override-state', `${STATUSES[override.status] || override.status} · ${formatTemperature(override.temperature)}${override.endsAt ? ` until ${formatDate(override.endsAt)}` : ''}`));
      temporary.append(element('p', 'schedule-help', override.expiry === 'device'
        ? 'The thermostat handles expiry.' : 'Homebridge restores the programme at expiry; Homebridge and the Tuya connection must be available.'));
      if (override.error || override.recoveryRequired) {
        temporary.append(element('p', 'schedule-notice', override.error || 'Programme restoration needs attention. The temporary temperature may still be active.'));
      }
      temporary.append(button(override.recoveryRequired || override.status === 'recovery-required' ? 'Retry programme restoration' : 'End temporary temperature', () => {
        if (window.confirm(`End the temporary temperature in ${room.name} and restore its scheduled programme?`)) {
          action('/overrides/cancel', { deviceId: room.id }, 'Programme restoration requested. Check the room status for confirmation.').catch(() => {});
        }
      }));
    } else if (override.status === 'failed' && override.error) {
      temporary.append(element('p', 'schedule-notice', override.error));
    }
    tools.append(temporary);
    return tools;
  }

  function historyChart(points) {
    const wrapper = element('div', 'temperature-chart');
    const series = buildTemperatureHistorySeries(points);
    const usable = series.reports;
    const values = usable.flatMap(point => point.online === false ? [] : [point.currentTemperature, point.targetTemperature]).filter(Number.isFinite);
    if (!values.length || usable.length < 2) {
      wrapper.append(element('p', 'schedule-help', 'Not enough readings to draw a chart yet. Readings are collected while Homebridge is running.'));
      return wrapper;
    }
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 760 220');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Reported measured and target temperature history in Celsius. The target uses steps between reports. Gaps indicate unavailable readings.');
    const minAt = usable[0].plotAt;
    const maxAt = Math.max(minAt + 1, usable[usable.length - 1].plotAt);
    const min = Math.floor(Math.min(...values) - 1);
    const max = Math.ceil(Math.max(...values) + 1);
    const x = at => 45 + (at - minAt) / (maxAt - minAt) * 695;
    const y = temperature => 180 - (temperature - min) / (max - min) * 160;
    const svgNode = (tag, attributes, text) => {
      const node = document.createElementNS(namespace, tag);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
      if (text !== undefined) {
        node.textContent = text;
      }
      svg.append(node);
      return node;
    };
    for (let tick = 0; tick <= 4; tick++) {
      const value = min + (max - min) * tick / 4;
      svgNode('line', { x1: 45, x2: 740, y1: y(value), y2: y(value), class: 'chart-grid' });
      svgNode('text', { x: 37, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-label' }, `${value.toFixed(1)}°`);
    }
    for (const [key, className] of [['targetTemperature', 'chart-target'], ['currentTemperature', 'chart-current']]) {
      for (const segment of series[key]) {
        const vertices = [];
        segment.forEach((point, index) => {
          if (key === 'targetTemperature' && index > 0) {
            // A step corner depicts the last reported target state, not an extra observation.
            vertices.push(`${x(point.at)},${y(segment[index - 1].temperature)}`);
          }
          vertices.push(`${x(point.at)},${y(point.temperature)}`);
        });
        svgNode('polyline', { points: vertices.join(' '), class: className });
        if (segment.length === 1) {
          svgNode('circle', { cx: x(segment[0].at), cy: y(segment[0].temperature), r: 2.5, class: `${className} chart-point` });
        }
      }
    }
    svgNode('text', { x: 45, y: 207, class: 'chart-label' }, formatDate(minAt));
    svgNode('text', { x: 740, y: 207, 'text-anchor': 'end', class: 'chart-label' }, formatDate(maxAt));
    wrapper.append(svg, element('p', 'chart-legend', '● Reported room temperature   ┄ Reported target (steps)'),
      element('p', 'last-confirmed', 'Lines connect reports; temperatures are not continuously sampled. Offline periods break both lines. Room-temperature gaps over 30 minutes break its line. Each series ends at its last report.'));
    return wrapper;
  }

  function temperatureHistory(room) {
    const history = details(`${room.id}:history`, 'Temperature history');
    const controls = element('div', 'inline-controls');
    const range = field('Time range', `${room.id}:history:range`, { value: '24', options: [
      { value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' },
    ] });
    const load = async () => {
      try {
        const response = await request('/temperatures/history', { deviceId: room.id, hours: Number(range.input.value) });
        state.history.set(room.id, response);
        render();
      } catch (error) {
        showMessage(error.message || 'Temperature history could not be loaded.', 'error');
      }
    };
    controls.append(range.wrapper, button('Load history', load));
    history.append(controls);
    const saved = state.history.get(room.id);
    if (saved) {
      history.append(historyChart(saved.points || saved.temperatureHistory));
      if (saved.reason || saved.note) {
        history.append(element('p', 'last-confirmed', saved.reason || saved.note));
      }
    } else {
      history.append(element('p', 'schedule-help', 'Load locally collected readings. This records temperatures, not energy consumption.'));
    }
    return history;
  }

  function programmeHistory(room) {
    const history = details(`${room.id}:versions`, 'Programme history & restore');
    history.append(element('p', 'schedule-help', `Restore a previous programme into the ${PROFILES[state.profile]} draft. The thermostat changes only after a separate review and apply.`));
    history.append(button('Load programme history', async () => {
      try {
        const response = await request('/profiles/history', { deviceId: room.id });
        state.versions.set(room.id, response.versions || response.programmeHistory || response.history || []);
        render();
      } catch (error) {
        showMessage(error.message || 'Programme history could not be loaded.', 'error');
      }
    }));
    const versions = state.versions.get(room.id);
    if (versions && !versions.length) {
      history.append(element('p', 'last-confirmed', 'No previous programme versions have been recorded yet.'));
    }
    for (const version of versions || []) {
      const row = element('div', 'version-row');
      row.append(element('div', '', `${PROFILES[version.profile] || 'Native programme'} · ${formatDate(version.at || version.createdAt)}${version.reason || version.source ? ` · ${version.reason || version.source}` : ''}`),
        button(`Restore to ${PROFILES[state.profile]} draft`, async () => {
          const draft = getDraft(room);
          if (draft.dirty && !window.confirm(`Replace the unsaved ${PROFILES[state.profile]} draft for ${room.name}?`)) {
            return;
          }
          try {
            const restored = await action('/profiles/restore', { deviceId: room.id, versionId: version.id || version.versionId, profile: state.profile },
              `Previous programme restored to the ${PROFILES[state.profile]} draft for ${room.name}. The thermostat programme has not been changed.`);
            const current = restored.thermostats.find(item => item.id === room.id);
            draft.schedule = normaliseSchedule(current.profiles && current.profiles[state.profile]);
            draft.dirty = false;
            render();
          } catch { /* The action displays the error. */ }
        }));
      const saved = normaliseSchedule(version.programme || version.schedule);
      const current = getDraft(room).schedule;
      const changes = [];
      for (const [dayIndex, day] of saved.days.entries()) {
        for (const event of day.events) {
          const previous = current.days[dayIndex].events.find(item => item.event === event.event);
          if (JSON.stringify(previous) !== JSON.stringify(event)) {
            changes.push(`${DAYS[dayIndex].name} ${EVENTS[event.event]}: ${eventText(previous)} → ${eventText(event)}`);
          }
        }
      }
      const comparison = details(`${room.id}:version:${version.id || version.versionId}`, `${changes.length} period${changes.length === 1 ? '' : 's'} differ from the ${PROFILES[state.profile]} draft`, 'version-comparison');
      if (changes.length) {
        const list = element('ul');
        changes.forEach(change => list.append(element('li', '', change)));
        comparison.append(list);
      } else {
        comparison.append(element('p', 'schedule-help', 'This programme matches the open draft.'));
      }
      row.append(comparison);
      history.append(row);
    }
    return history;
  }

  function nativeTable(schedule) {
    const wrapper = element('div', 'schedule-grid-wrapper');
    const table = element('table', 'schedule-grid');
    const head = element('thead');
    const header = element('tr');
    for (const name of ['Day', ...EVENTS]) {
      const th = element('th', '', name);
      th.scope = 'col';
      header.append(th);
    }
    head.append(header);
    const body = element('tbody');
    for (const day of DAYS) {
      const row = element('tr');
      const th = element('th', '', day.name);
      th.scope = 'row';
      row.append(th);
      const source = schedule && Array.isArray(schedule.days) ? schedule.days.find(item => item.day === day.id) : undefined;
      for (let eventId = 0; eventId < EVENTS.length; eventId++) {
        const event = source && source.events ? source.events.find(item => item.event === eventId) : undefined;
        row.append(element('td', '', eventText(event)));
      }
      body.append(row);
    }
    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }

  function markDraftDirty(room, status) {
    getDraft(room).dirty = true;
    status.textContent = 'Unsaved changes';
    status.classList.add('unsaved');
    updateSelection();
  }

  function editorTable(room, draft, status, options = {}) {
    const label = options.label || roomLabel(room);
    const profile = options.profile || state.profile;
    const key = options.key || draftKey(room.id, profile);
    const changed = options.onDirty || (() => markDraftDirty(room, status));
    const wrapper = element('div', 'schedule-grid-wrapper');
    const table = element('table', 'schedule-grid');
    const head = element('thead');
    const header = element('tr');
    for (const name of ['Day', ...EVENTS]) {
      const th = element('th', '', name);
      th.scope = 'col';
      header.append(th);
    }
    head.append(header);
    const body = element('tbody');
    for (const [dayIndex, day] of draft.schedule.days.entries()) {
      const row = element('tr');
      const th = element('th', '', DAYS[dayIndex].name);
      th.scope = 'row';
      row.append(th);
      for (const event of day.events) {
        const cell = element('td');
        const inputs = element('div', 'event-inputs');
        const time = element('input');
        time.type = 'time';
        time.step = '60';
        time.value = timeText(event);
        time.setAttribute('aria-label', `${label}, ${PROFILES[profile]}, ${DAYS[dayIndex].name} ${EVENTS[event.event]} time`);
        time.dataset.focus = `${key}:${day.day}:${event.event}:time`;
        time.disabled = state.pending;
        time.addEventListener('input', () => {
          const match = /^(\d{2}):(\d{2})$/.exec(time.value);
          event.hour = match ? Number(match[1]) : null;
          event.minute = match ? Number(match[2]) : null;
          changed();
        });
        const temperature = element('input');
        temperature.type = 'number';
        temperature.min = '5';
        temperature.max = '40';
        temperature.step = '0.5';
        temperature.inputMode = 'decimal';
        temperature.placeholder = '—';
        temperature.value = typeof event.temperature === 'number' ? event.temperature : '';
        temperature.setAttribute('aria-label', `${label}, ${PROFILES[profile]}, ${DAYS[dayIndex].name} ${EVENTS[event.event]} temperature in Celsius`);
        temperature.dataset.focus = `${key}:${day.day}:${event.event}:temperature`;
        temperature.disabled = state.pending;
        temperature.addEventListener('input', () => {
          event.temperature = temperature.value === '' ? null : Number(temperature.value);
          changed();
        });
        inputs.append(time, temperature, element('span', '', '°C'));
        cell.append(inputs);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }

  function selectOptions(options, label) {
    const select = element('select');
    select.setAttribute('aria-label', label);
    options.forEach(option => {
      const node = element('option', '', option.label);
      node.value = option.value;
      select.append(node);
    });
    return select;
  }

  async function saveDraft(room, enabled = room.enabled) {
    const draft = getDraft(room);
    const errors = validateSchedule(draft.schedule);
    if (errors.length) {
      showMessage(`${room.name}: ${errors[0]}`, 'error');
      return false;
    }
    const saved = clone(draft.schedule);
    await action('/profiles/save', {
      deviceId: room.id,
      profile: state.profile,
      schedule: saved,
      enabled: !!enabled,
    }, `${PROFILES[state.profile]} draft saved for ${room.name}. The thermostat programme has not been changed.`);
    // Only mark the version that was saved as clean if no later input replaced it.
    if (JSON.stringify(draft.schedule) === JSON.stringify(saved)) {
      draft.dirty = false;
    }
    render();
    return true;
  }

  function copyControls(room, draft) {
    const controls = element('div', 'copy-actions');
    const day = selectOptions(DAYS.map(item => ({ value: item.id, label: item.name })), `Source day in ${room.name}`);
    controls.append(element('label', '', 'Copy day'), day, button('To all days', () => {
      const events = draft.schedule.days.find(item => item.day === Number(day.value)).events;
      draft.schedule.days.forEach(item => { item.events = clone(events); });
      draft.dirty = true;
      render();
    }));
    const profile = selectOptions(Object.keys(PROFILES).filter(item => item !== state.profile)
      .map(item => ({ value: item, label: PROFILES[item] })), `Source profile for ${room.name}`);
    controls.append(element('label', '', 'Copy profile'), profile, button('Copy to this profile', () => {
      draft.schedule = clone(getDraft(room, profile.value).schedule);
      draft.dirty = true;
      render();
    }));
    const sources = state.view.thermostats.filter(item => item.id !== room.id);
    if (sources.length) {
      const source = selectOptions(sources.map(item => ({ value: item.id, label: roomLabel(item) })), `Source room for ${roomLabel(room)}`);
      controls.append(element('label', '', 'Copy room'), source, button('Copy profile', () => {
        draft.schedule = clone(getDraft(thermostat(source.value)).schedule);
        draft.dirty = true;
        render();
      }));
    }
    return controls;
  }

  function renderSharedEditor() {
    const container = byId('shared-editor');
    container.hidden = !state.sharedOpen;
    container.replaceChildren();
    if (!state.sharedOpen) { return; }
    const draft = sharedDraft();
    const heading = element('div', 'thermostat-actions');
    const title = element('h3', '', `One ${PROFILES[state.profile]} programme for selected rooms`);
    title.id = 'shared-editor-title';
    heading.append(title, button('Close editor', () => { state.sharedOpen = false; render(); }));
    container.append(heading, element('p', 'schedule-help', 'Start with one room’s draft or load its stored programme. Edit once, then save a separate copy for every selected room. Applying to the heating is a separate step.'));
    const source = selectOptions(state.view.thermostats.map(room => ({ value: room.id, label: roomLabel(room) })), 'Programme source room');
    if (state.view.thermostats.some(room => room.id === draft.sourceId)) { source.value = draft.sourceId; }
    source.disabled = state.pending;
    source.addEventListener('change', () => { draft.sourceId = source.value; });
    const sources = element('div', 'inline-controls shared-source');
    const sourceLabel = element('label', 'control-field');
    sourceLabel.append(element('span', '', 'Start from room'), source);
    const useSaved = button('Use this room’s draft', () => {
      const room = thermostat(source.value);
      const saved = getDraft(room);
      if (validateSchedule(saved.schedule).length) {
        showMessage(`${roomLabel(room)} has no complete ${PROFILES[state.profile]} draft. Load its stored programme instead.`, 'error');
        return;
      }
      if (draft.dirty && !window.confirm('Replace the edited shared programme with this room’s draft?')) { return; }
      draft.sourceId = room.id;
      draft.schedule = clone(saved.schedule);
      draft.dirty = true;
      render();
    });
    sources.append(sourceLabel, useSaved, button('Load programme from thermostat', () => {
      draft.sourceId = source.value;
      loadStoredProgrammes([source.value], true).catch(() => {});
    }));
    container.append(sources);
    if (!draft.schedule) {
      container.append(element('p', 'schedule-notice', 'No shared programme loaded. Choose a room above and load its programme, or use a complete draft. Existing room programmes stay separate until you save this shared programme.'));
      return;
    }
    const status = element('p', 'draft-status', draft.dirty ? 'Shared programme edited — not yet saved to rooms' : 'Shared draft ready — save it for the selected rooms');
    const changed = () => {
      draft.dirty = true;
      status.textContent = 'Shared programme edited — not yet saved to rooms';
      status.classList.add('unsaved');
      updateSelection();
    };
    container.append(status, editorTable(null, draft, status, { label: 'Shared programme', key: `shared:${sharedKey()}`, onDirty: changed }));
    const copyDay = selectOptions(DAYS.map(day => ({ value: day.id, label: day.name })), 'Source day in shared programme');
    const copying = element('div', 'copy-actions');
    copying.append(element('label', '', 'Copy day'), copyDay, button('To all days', () => {
      const events = draft.schedule.days.find(day => day.day === Number(copyDay.value)).events;
      draft.schedule.days.forEach(day => { day.events = clone(events); });
      draft.dirty = true;
      render();
    }));
    const save = button(`Save programme for ${state.selected.size} rooms`, () => saveSelectedDrafts(draft.schedule).catch(error => showMessage(error.message, 'error')), 'primary');
    save.id = 'save-shared';
    save.disabled = !state.selected.size || state.pending || !state.online;
    container.append(copying, save, element('p', 'last-confirmed', 'Save creates drafts only. Use Review & apply selected to send them to the thermostats.'));
  }

  function fillProgrammeFeedback(node, feedback) {
    node.className = `${node.dataset.roomFeedback ? 'room-programme-feedback' : 'programme-feedback'} ${feedback.kind}`;
    const title = node.querySelector('strong');
    const detail = node.querySelector('p');
    if (title.textContent !== feedback.title) { title.textContent = feedback.title; }
    if (detail.textContent !== feedback.detail) { detail.textContent = feedback.detail; }
  }

  function updateVerificationControls() {
    document.querySelectorAll('[data-verify-room]').forEach(node => {
      const room = thermostat(node.dataset.verifyRoom);
      const profile = node.dataset.verifyProfile;
      const verification = room && savedProgrammeVerification(room, profile, {
        online: state.online, pending: state.pending, dirty: getDraft(room, profile).dirty,
      });
      node.disabled = !verification || !verification.allowed;
      const help = byId(node.getAttribute('aria-describedby'));
      const text = verification && (verification.reason
        || `Compare the programme stored on this thermostat with the saved ${PROFILES[profile]} programme and check Scheduled mode. This does not upload a programme or change its mode.`);
      if (help && text && help.textContent !== text) { help.textContent = text; }
    });
  }

  function renderProgrammeFeedback() {
    const options = { online: state.online, formatDate };
    fillProgrammeFeedback(byId('programme-feedback'), buildProgrammeFeedback(state.view, options));
    const context = state.online ? householdProgrammeContext(state.view, formatDate)
      : 'Household state cannot be refreshed while the controller is unavailable.';
    if (byId('household-state').textContent !== context) { byId('household-state').textContent = context; }
    document.querySelectorAll('[data-room-feedback]').forEach(node => {
      const room = thermostat(node.dataset.roomFeedback);
      if (room) { fillProgrammeFeedback(node, roomProgrammeFeedback(room, options)); }
    });
    updateVerificationControls();
    const home = state.view.presence && state.view.presence.home;
    const holiday = !!(state.view.holiday && state.view.holiday.active);
    byId('home-control').classList.toggle('selected', home === true);
    byId('away-control').classList.toggle('selected', home === false);
    byId('holiday-control').classList.toggle('selected', holiday);
    byId('holiday-control').textContent = holiday ? 'End holiday' : 'Enable holiday';
    for (const id of ['home-control', 'away-control', 'holiday-control']) {
      byId(id).disabled = !state.online || state.pending;
    }
  }

  function renderRoom(room) {
    const card = element('section', 'thermostat-card');
    const header = element('div', 'thermostat-card-header');
    const title = element('div', 'thermostat-title');
    const label = element('label', 'room-selection');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(room.id);
    checkbox.disabled = state.pending;
    checkbox.setAttribute('aria-label', `Select ${roomLabel(room)}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? state.selected.add(room.id) : state.selected.delete(room.id);
      updateSelection();
      renderSharedEditor();
    });
    const heading = element('div');
    heading.append(element('h3', '', roomLabel(room)));
    const sync = room.sync || { status: 'idle' };
    const confirmed = sync.confirmedProfile ? PROFILES[sync.confirmedProfile] || sync.confirmedProfile : 'Not confirmed';
    heading.append(element('p', 'thermostat-subtitle', `${MODES[room.mode] || room.mode || 'Mode unknown'} · ${room.online ? 'Online' : 'Offline'}`));
    label.append(checkbox, heading);
    const edit = button(`Edit ${PROFILES[state.profile]} programme`, () => {
      const editor = Array.from(document.querySelectorAll('[data-detail]')).find(node => node.dataset.detail === `${room.id}:editor`);
      if (editor) { editor.open = !editor.open; if (editor.open) { editor.querySelector('summary').focus(); } }
    });
    title.append(label, edit);
    const stats = element('div', 'thermostat-stats');
    appendStat(stats, room.online ? 'Room temperature' : 'Last reported room temperature', formatTemperature(room.currentTemperature), 'temperature');
    appendStat(stats, 'Set temperature', formatTemperature(room.targetTemperature));
    const draft = getDraft(room);
    const hasDraft = !!(room.profiles && room.profiles[state.profile]);
    const draftState = draft.dirty ? 'Unsaved changes' : hasDraft ? 'Saved draft' : 'No draft yet';
    appendStat(stats, `${PROFILES[state.profile]} programme`, draftState);
    header.append(title, stats);
    const programmeFeedback = element('div', 'room-programme-feedback');
    programmeFeedback.dataset.roomFeedback = room.id;
    programmeFeedback.append(element('strong'), element('p'));
    header.append(programmeFeedback);
    if (room.override && room.override.status && !['completed', 'cancelled', 'failed', 'idle'].includes(room.override.status)) {
      header.append(element('p', 'override-state', `Temporary temperature: ${formatTemperature(room.override.temperature)} until ${formatDate(room.override.endsAt)} · ${STATUSES[room.override.status] || room.override.status}`));
    }
    if (room.override && (room.override.recoveryRequired || room.override.status === 'recovery-required')) {
      header.append(element('p', 'room-warning', room.override.error || 'Programme restoration needs attention. Open Room details to retry.'));
    }

    const body = element('div', 'thermostat-body');
    const editor = details(`${room.id}:editor`, `${PROFILES[state.profile]} programme · ${draftState}`, 'programme-editor');
    const draftStatus = element('span', `draft-status ${draft.dirty ? 'unsaved' : ''}`,
      draft.dirty ? 'Unsaved changes' : room.profiles && room.profiles[state.profile] ? 'Saved draft' : 'New draft');
    const actions = element('div', 'thermostat-actions');
    const draftTitle = element('div');
    draftTitle.append(element('h3', '', `${PROFILES[state.profile]} programme`), draftStatus);
    const buttons = element('div');
    const review = button('Review & apply', () => prepareApply([room.id]).catch(error => showMessage(error.message, 'error')), 'primary');
    review.disabled = state.pending || !state.online || draft.dirty || !hasDraft
      || !!validateSchedule(normaliseSchedule(room.profiles && room.profiles[state.profile])).length;
    buttons.append(
      button('Save draft', () => saveDraft(room).catch(() => {})),
      review,
    );
    actions.append(draftTitle, buttons);
    editor.append(actions, element('p', 'schedule-help', 'Four periods per day. Temperatures are in Celsius; each period continues until the next one.'));
    const importAction = button('Load programme from thermostat', () => loadStoredProgrammes([room.id]).catch(() => {}));
    importAction.disabled = BUSY.has(sync.status) || state.pending || !state.online;
    if (!hasDraft && !draft.dirty) {
      const empty = element('div', 'draft-empty');
      empty.append(element('strong', '', `Start your ${PROFILES[state.profile]} draft`), element('p', 'schedule-help', 'Load the programme already stored on this thermostat, then edit it here. Loading does not change the heating.'), importAction);
      editor.append(empty);
    } else {
      const importRow = element('div', 'copy-actions');
      importRow.append(importAction, element('span', 'schedule-help', 'Read a fresh copy into this draft.'));
      editor.append(importRow);
    }
    if (typeof room.grouping === 'number' && (room.grouping & 1)) {
      editor.append(element('p', 'schedule-notice', 'The thermostat uses grouped 5+1+1 programming. Before applying a weekly profile, select seven-day programming in SmartLife and read the programme again. Grouping and adaptive-start settings are preserved by this editor.'));
    }
    editor.append(editorTable(room, draft, draftStatus), copyControls(room, draft));

    const automatic = element('label', 'select-all');
    const enabled = element('input');
    enabled.type = 'checkbox';
    enabled.checked = !!room.enabled;
    const missingProfiles = Object.keys(PROFILES).filter(profile => !room.profiles || !room.profiles[profile]
      || validateSchedule(normaliseSchedule(room.profiles[profile])).length > 0);
    enabled.disabled = state.pending || (!room.enabled && missingProfiles.length > 0);
    enabled.addEventListener('change', async () => {
      const desired = enabled.checked;
      if (desired && !window.confirm(`Allow household Home, Away and Holiday changes to upload saved programmes to ${room.name} and activate its scheduled (Smart) mode? Enabling this option does not upload a programme now.`)) {
        enabled.checked = false;
        return;
      }
      try {
        const saved = await saveDraft(room, desired);
        if (!saved) {
          enabled.checked = !!room.enabled;
        }
      } catch {
        enabled.checked = !!room.enabled;
      }
    });
    automatic.append(enabled, document.createTextNode('Use saved profiles for automatic household changes'));
    editor.append(automatic);
    editor.append(element('p', 'last-confirmed', missingProfiles.length
      ? `Save complete ${missingProfiles.map(profile => PROFILES[profile]).join(', ')} profiles before enabling automatic changes.`
      : 'Home, Away and Holiday drafts are saved. Automatic changes upload the selected saved programme and activate scheduled (Smart) mode.'));

    body.append(editor);
    const roomDetails = details(`${room.id}:details`, 'Room details', 'room-diagnostics');
    roomDetails.append(nowAndNext(room));
    const reportedAt = room.lastReportedAt ?? room.temperatureReportedAt;
    const receivedAt = room.lastReceivedAt ?? room.temperatureReceivedAt;
    roomDetails.append(element('p', 'last-confirmed', `Reading time: ${reportedAt ? formatDate(reportedAt) : 'device time unavailable'} · received locally: ${formatDate(receivedAt)}${room.telemetryAvailable === false ? ' · live telemetry unavailable' : ''}`));
    roomDetails.append(element('p', 'last-confirmed', `Last confirmed profile: ${confirmed} · last programme read: ${formatDate(room.lastUpdated)} · ${typeof room.grouping === 'number' ? (room.grouping & 1 ? '5+1+1 days' : 'Seven days') : 'Grouping unknown'}`));
    roomDetails.append(roomTools(room));
    const verification = savedProgrammeVerification(room, state.profile, {
      online: state.online, pending: state.pending, dirty: draft.dirty,
    });
    const verificationActions = element('div', 'thermostat-actions');
    const verify = button(`Verify saved ${PROFILES[state.profile]} programme`, () => verifySavedProgramme(room).catch(() => {}));
    verify.disabled = !verification.allowed;
    verify.dataset.verifyRoom = room.id;
    verify.dataset.verifyProfile = state.profile;
    verificationActions.append(verify);
    const verificationHelp = element('p', 'schedule-help', verification.reason
      || `Compare the programme stored on this thermostat with the saved ${PROFILES[state.profile]} programme and check Scheduled mode. This does not upload a programme or change its mode.`);
    verificationHelp.id = `verify-help-${room.id}`;
    verify.setAttribute('aria-describedby', verificationHelp.id);
    roomDetails.append(verificationActions, verificationHelp);
    const count = room.schedule && Array.isArray(room.schedule.missing) ? 28 - room.schedule.missing.length : 0;
    const native = details(`${room.id}:native`, `Programme on thermostat · ${room.schedule && room.schedule.complete ? 'complete' : `${count}/28 periods received`}`, 'native-programme');
    const nativeActions = element('div', 'thermostat-actions');
    const read = button(BUSY.has(sync.status) ? 'Operation in progress…' : 'Read programme', () => readProgramme(room));
    read.disabled = BUSY.has(sync.status) || state.pending;
    nativeActions.append(read);
    native.append(element('p', 'last-confirmed', 'This is the programme reported by the device. Missing periods remain unknown.'), nativeActions, nativeTable(room.schedule));
    roomDetails.append(native, temperatureHistory(room), programmeHistory(room));
    body.append(roomDetails);
    card.append(header, body);
    return card;
  }

  function render() {
    const focused = document.activeElement && document.activeElement.dataset.focus;
    const openDetails = new Map(Array.from(document.querySelectorAll('[data-detail]')).map(node => [node.dataset.detail, node.open]));
    const container = byId('thermostats');
    container.replaceChildren();
    if (!state.view.thermostats.length) {
      const empty = element('div', 'schedule-empty');
      empty.append(element('h3', '', 'No supported thermostats found'),
        element('p', '', 'The schedule editor currently supports FastWarm Smart WiFi 2.0 / ET-63 thermostats. Your other Tuya accessories remain available through Homebridge.'));
      container.append(empty);
    }
    state.view.thermostats.forEach(room => {
      const card = renderRoom(room);
      container.append(card);
    });
    householdOptions();
    renderSharedEditor();
    document.querySelectorAll('[data-detail]').forEach(node => { node.open = !!openDetails.get(node.dataset.detail); });
    if (focused) {
      const input = Array.from(document.querySelectorAll('[data-focus]')).find(node => node.dataset.focus === focused);
      if (input) {
        input.focus({ preventScroll: true });
      }
    }
    renderProgrammeFeedback();
    updateSelection();
    if (typeof homebridge.fixScrollHeight === 'function') {
      homebridge.fixScrollHeight();
    }
  }

  async function prepareApply(deviceIds) {
    if (state.sharedOpen && sharedDraft().dirty) {
      showMessage('Save the shared programme for selected rooms before reviewing, or close the shared editor to review the saved room drafts.', 'error');
      return;
    }
    const profile = state.profile;
    const missing = deviceIds.map(thermostat).filter(room => !room || !room.profiles || !room.profiles[profile]
      || validateSchedule(normaliseSchedule(room.profiles[profile])).length);
    if (!deviceIds.length || missing.length) {
      showMessage(`Load or create and save a complete ${PROFILES[profile]} programme for every selected room before reviewing.`, 'error');
      return;
    }
    const changed = deviceIds.filter(id => getDraft(thermostat(id), profile).dirty);
    if (changed.length) {
      showMessage('Save the edited drafts before reviewing programme changes.', 'error');
      return;
    }
    const view = await action('/schedules/apply', {
      deviceIds,
      profile,
      preview: true,
    }, 'Review the programme changes before applying.');
    if (!view.preview || !view.preview.id || !Array.isArray(view.preview.devices)) {
      throw new Error('The controller did not return a programme preview.');
    }
    state.preview = { ...view.preview, kind: 'programme' };
    byId('preview-title').textContent = 'Review programme changes';
    byId('confirm-apply').textContent = 'Apply programme changes';
    byId('preview-notice').textContent = 'Applying changes writes a programme to each selected thermostat. Updates are sent one event at a time; a connection failure can leave a partially updated programme. The result is checked by reading it back.';
    byId('preview-description').textContent = `Apply the saved ${PROFILES[profile]} programme to ${view.preview.devices.length} thermostat${view.preview.devices.length === 1 ? '' : 's'}.`;
    const content = byId('preview-content');
    content.replaceChildren();
    for (const item of view.preview.devices) {
      const section = element('div', 'preview-room');
      const room = thermostat(item.id);
      section.append(element('h4', '', `${room ? roomLabel(room) : item.name} · ${item.changes} period${item.changes === 1 ? '' : 's'} changed`));
      const selectedProfile = item.profile || profile;
      const next = normaliseSchedule(room.profiles && room.profiles[selectedProfile]);
      const previous = normaliseSchedule(room.schedule);
      const list = element('ul');
      next.days.forEach((day, index) => {
        day.events.forEach(event => {
          const before = previous.days[index].events.find(old => old.event === event.event);
          if (JSON.stringify(before) !== JSON.stringify(event)) {
            list.append(element('li', '', `${DAYS[index].name} ${EVENTS[event.event]}: ${eventText(before)} → ${eventText(event)}`));
          }
        });
      });
      section.append(list);
      content.append(section);
    }
    for (const warning of view.preview.warnings || []) {
      content.append(element('p', 'schedule-notice', String(warning)));
    }
    byId('apply-preview').hidden = false;
    byId('confirm-apply').disabled = false;
    byId('cancel-apply').focus();
  }

  function closePreview() {
    state.preview = null;
    byId('apply-preview').hidden = true;
    byId('apply-selected').focus();
  }

  async function changeHousehold(path, payload, label) {
    const enabled = state.view.thermostats.filter(room => room.enabled);
    if (enabled.length && !window.confirm(`${label} This can upload saved programmes and activate scheduled (Smart) mode on ${enabled.length} enabled thermostat${enabled.length === 1 ? '' : 's'}. Continue?`)) {
      return;
    }
    await action(path, payload, `${label} Enabled thermostats show their individual sync results below.`);
  }

  function changeView(settings) {
    state.settings = settings;
    byId('settings-view').hidden = !settings;
    byId('schedules-view').hidden = settings;
    byId('settings-tab').classList.toggle('active', settings);
    byId('schedules-tab').classList.toggle('active', !settings);
    byId('settings-tab').setAttribute('aria-selected', String(settings));
    byId('schedules-tab').setAttribute('aria-selected', String(!settings));
    if (settings) {
      homebridge.showSchemaForm();
    } else {
      homebridge.hideSchemaForm();
    }
  }

  async function initialise() {
    homebridge.hideSchemaForm();
    // Settings are intentionally handled by Homebridge's existing schema form;
    // schedule saves never rewrite the plugin's credentials or config block.
    byId('settings-tab').addEventListener('click', () => changeView(true));
    byId('schedules-tab').addEventListener('click', () => changeView(false));
    byId('refresh').addEventListener('click', () => state.instanceId ? refresh() : discoverInstances());
    document.querySelectorAll('[data-profile]').forEach(tab => {
      tab.addEventListener('click', () => {
        if (state.pending) { return; }
        state.profile = tab.dataset.profile;
        document.querySelectorAll('[data-profile]').forEach(other => {
          const active = other === tab;
          other.classList.toggle('active', active);
          other.setAttribute('aria-selected', String(active));
        });
        render();
      });
    });
    byId('select-all').addEventListener('change', event => {
      state.selected.clear();
      if (event.target.checked) {
        state.view.thermostats.forEach(room => state.selected.add(room.id));
      }
      render();
    });
    byId('edit-all').addEventListener('click', () => {
      state.selected = new Set(state.view.thermostats.map(room => room.id));
      const shared = sharedDraft();
      if (!shared.schedule) {
        const source = state.view.thermostats.find(room => !validateSchedule(getDraft(room).schedule).length);
        if (source) { shared.sourceId = source.id; shared.schedule = clone(getDraft(source).schedule); shared.dirty = true; }
      }
      state.sharedOpen = true;
      render();
      byId('shared-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    byId('load-stored').addEventListener('click', () => {
      const ids = state.selected.size ? Array.from(state.selected) : state.view.thermostats.map(room => room.id);
      if (!state.selected.size) { state.selected = new Set(ids); render(); }
      loadStoredProgrammes(ids).catch(error => showMessage(error.message, 'error'));
    });
    byId('save-selected').addEventListener('click', () => saveSelectedDrafts().catch(error => showMessage(error.message, 'error')));
    byId('apply-selected').addEventListener('click', () => prepareApply(Array.from(state.selected)).catch(error => showMessage(error.message, 'error')));
    byId('cancel-apply').addEventListener('click', closePreview);
    byId('confirm-apply').addEventListener('click', async () => {
      if (!state.preview) {
        return;
      }
      const previewId = state.preview.id;
      byId('confirm-apply').disabled = true;
      try {
        await action('/schedules/apply', { previewId }, 'Programme update started. Each thermostat will show its read-back result.');
        closePreview();
      } catch {
        byId('confirm-apply').disabled = false;
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !byId('apply-preview').hidden) {
        closePreview();
      }
    });
    byId('home-control').addEventListener('click', () => changeHousehold('/presence', { home: true }, 'Someone home selected.').catch(() => {}));
    byId('away-control').addEventListener('click', () => changeHousehold('/presence', { home: false }, 'Everyone away selected.').catch(() => {}));
    byId('holiday-control').addEventListener('click', () => {
      const active = !(state.view.holiday && state.view.holiday.active);
      changeHousehold('/holiday', { active }, active ? 'Holiday enabled.' : 'Holiday ended.').catch(() => {});
    });
    await discoverInstances();
  }

  async function discoverInstances() {
    try {
      const response = await homebridge.request('/instances');
      const instances = response && Array.isArray(response.instances) ? response.instances : [];
      if (!instances.length) {
        state.online = false;
        showMessage('No heating runtime was found. Start the Tuya child bridge, then refresh. Connection settings remain available in Settings.', 'error');
        render();
        changeView(true);
        return;
      }
      if (instances.length > 1 && !byId('instance-selector')) {
        const selector = selectOptions(instances.map(item => ({ value: item.id, label: `Tuya instance ${item.id}` })), 'Tuya instance');
        selector.id = 'instance-selector';
        selector.addEventListener('change', () => {
          state.instanceId = selector.value;
          state.selected.clear();
          state.sharedOpen = false;
          state.nativeImports.clear();
          state.readRequests.clear();
          refresh();
        });
        byId('schedules-view').prepend(selector);
      }
      state.instanceId = instances[0].id;
      await refresh(false);
    } catch (error) {
      state.online = false;
      showMessage(error.message || 'The schedule editor could not connect to Homebridge.', 'error');
      render();
    }
  }

  initialise().catch(error => showMessage(error.message || 'The schedule editor could not start.', 'error'));
})();
