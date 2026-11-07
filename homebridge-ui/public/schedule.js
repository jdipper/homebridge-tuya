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

if (typeof module === 'object' && module.exports) {
  module.exports = { buildTemperatureHistorySeries };
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
    reading: 'Reading', applying: 'Applying', queued: 'Queued', idle: 'Not yet confirmed',
    pending: 'Pending', unknown: 'Unknown',
    overriding: 'Starting temporary temperature', resuming: 'Restoring programme',
    starting: 'Starting', active: 'Temporary temperature active', 'recovery-required': 'Restoration needs attention',
  };
  const BUSY = new Set(['reading', 'applying', 'queued', 'overriding', 'resuming']);
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

  async function request(path, payload = {}) {
    return homebridge.request(path, { ...payload, instanceId: state.instanceId });
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
    byId('apply-selected').disabled = !state.selected.size || state.pending || !state.online;
    byId('select-all').checked = rooms.length > 0 && rooms.every(room => state.selected.has(room.id));
    byId('select-all').indeterminate = state.selected.size > 0 && !byId('select-all').checked;
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
      const failed = completed.some(room => !room.schedule || !room.schedule.complete);
      showMessage(completed.map(room => `${room.name}: ${room.schedule && room.schedule.complete
        ? 'all 28 programme periods received' : room.sync && room.sync.error || 'programme read finished with missing periods'}`).join('. '), failed ? 'error' : 'success');
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
      acceptView(await request('/thermostats'));
      if (showProgress) {
        showMessage('Thermostat status refreshed.');
      }
    } catch (error) {
      state.online = false;
      showMessage(`${error.message || 'The heating controller is unavailable.'} Your open drafts are kept on this page.`, 'error');
      updateSelection();
      schedulePoll();
    } finally {
      byId('refresh').disabled = false;
    }
  }

  async function action(path, payload, message) {
    state.pending = true;
    render();
    try {
      const view = await request(path, payload);
      acceptView(view);
      showMessage(message, 'success');
      return view;
    } catch (error) {
      showMessage(error.message || 'The request could not be completed.', 'error');
      throw error;
    } finally {
      state.pending = false;
      render();
    }
  }

  function statusBadge(status, label) {
    return element('span', `status-badge ${status}`, label || STATUSES[status] || status);
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
    const rename = details(`${room.id}:name`, 'Room name');
    const form = element('div', 'inline-controls');
    const name = field('Display name', `${room.id}:name`, { value: room.name, maxLength: 80 });
    form.append(name.wrapper, button('Save name', async () => {
      const value = name.input.value.trim();
      if (!value) {
        showMessage('Enter a room name.', 'error');
        return;
      }
      try {
        await action('/rooms/save', { deviceId: room.id, name: value }, 'Room display name saved.');
        forgetForm(`${room.id}:name`);
      } catch { /* The action displays the error. */ }
    }));
    rename.append(form, element('p', 'last-confirmed', `SmartLife device: ${room.sourceName || room.deviceName || room.name} · …${room.id.slice(-6)}`));
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
      if (!window.confirm(`Confirm that the clock and weekday shown on ${room.name} match ${timeZone}. This enables next-period expiry using that clock; it does not set the thermostat clock.`)) {
        return;
      }
      try {
        await action('/rooms/save', { deviceId: room.id, name: room.name, timeZone, clockVerified: true }, 'Thermostat time zone and clock confirmation saved.');
        forgetForm(`${room.id}:clock`);
      } catch { /* The action displays the error. */ }
    }));
    rename.append(clockForm, element('p', 'last-confirmed', 'Next changes are calculated from the programme and this time zone. Confirm the actual thermostat clock before using next-period expiry.'));
    tools.append(rename);

    const override = room.override || {};
    const activeOverride = override.status && !['idle', 'completed', 'cancelled', 'failed'].includes(override.status);
    const temporary = details(`${room.id}:override`, 'Temporary temperature');
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
    const controls = element('div', 'inline-controls');
    const temperature = field('Temperature (°C)', `${room.id}:override:temperature`, {
      type: 'number', min: 5, max: 40, step: 0.5, value: room.targetTemperature ?? 20,
    });
    const expiry = field('Resume programme', `${room.id}:override:expiry`, {
      value: '120', options: [
        { value: '60', label: 'In 1 hour' }, { value: '120', label: 'In 2 hours' },
        { value: '240', label: 'In 4 hours' }, { value: 'next-period', label: 'At next programme period', disabled: !(room.nowNext && room.nowNext.safeForExpiry) },
        { value: 'custom', label: 'At a chosen time' },
      ],
    });
    const until = field('Chosen end time', `${room.id}:override:until`, { type: 'datetime-local', value: dateInputValue(later(120)) });
    until.wrapper.hidden = expiry.input.value !== 'custom';
    expiry.input.addEventListener('change', () => { until.wrapper.hidden = expiry.input.value !== 'custom'; });
    const review = button('Review temporary temperature', () => {
      const target = Number(temperature.input.value);
      const endsAt = expiry.input.value === 'next-period' ? 'next-period'
        : expiry.input.value === 'custom' ? asTimestamp(until.input.value) : later(Number(expiry.input.value));
      if (!Number.isFinite(target) || target < 5 || target > 40 || !Number.isInteger(target * 2)) {
        showMessage('Enter a temperature from 5–40°C in 0.5°C steps.', 'error');
        return;
      }
      if (endsAt !== 'next-period' && (!Number.isFinite(endsAt) || endsAt <= Date.now() || endsAt > later(24 * 60))) {
        showMessage('Choose an end time within the next 24 hours.', 'error');
        return;
      }
      prepareOverride(room, target, endsAt).catch(error => showMessage(error.message, 'error'));
    });
    review.disabled = !state.online || !room.online || state.pending || !!activeOverride || BUSY.has(room.sync && room.sync.status);
    controls.append(temperature.wrapper, expiry.wrapper, until.wrapper, review);
    temporary.append(controls, element('p', 'schedule-help', 'Review first. Starting a temporary temperature changes the thermostat target and mode; it does not rewrite the weekly programme.'));
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
  }

  function editorTable(room, draft, status) {
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
        time.setAttribute('aria-label', `${room.name}, ${PROFILES[state.profile]}, ${DAYS[dayIndex].name} ${EVENTS[event.event]} time`);
        time.dataset.focus = `${draftKey(room.id)}:${day.day}:${event.event}:time`;
        time.addEventListener('input', () => {
          const match = /^(\d{2}):(\d{2})$/.exec(time.value);
          event.hour = match ? Number(match[1]) : null;
          event.minute = match ? Number(match[2]) : null;
          markDraftDirty(room, status);
        });
        const temperature = element('input');
        temperature.type = 'number';
        temperature.min = '5';
        temperature.max = '40';
        temperature.step = '0.5';
        temperature.inputMode = 'decimal';
        temperature.placeholder = '—';
        temperature.value = typeof event.temperature === 'number' ? event.temperature : '';
        temperature.setAttribute('aria-label', `${room.name}, ${PROFILES[state.profile]}, ${DAYS[dayIndex].name} ${EVENTS[event.event]} temperature in Celsius`);
        temperature.dataset.focus = `${draftKey(room.id)}:${day.day}:${event.event}:temperature`;
        temperature.addEventListener('input', () => {
          event.temperature = temperature.value === '' ? null : Number(temperature.value);
          markDraftDirty(room, status);
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
      const source = selectOptions(sources.map(item => ({ value: item.id, label: item.name })), `Source room for ${room.name}`);
      controls.append(element('label', '', 'Copy room'), source, button('Copy profile', () => {
        draft.schedule = clone(getDraft(thermostat(source.value)).schedule);
        draft.dirty = true;
        render();
      }));
    }
    return controls;
  }

  function renderRoom(room) {
    const card = element('section', 'thermostat-card');
    const header = element('div', 'thermostat-card-header');
    const title = element('div', 'thermostat-title');
    const label = element('label', 'room-selection');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(room.id);
    checkbox.setAttribute('aria-label', `Select ${room.name}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? state.selected.add(room.id) : state.selected.delete(room.id);
      updateSelection();
    });
    const heading = element('div');
    heading.append(element('h3', '', room.name));
    const sync = room.sync || { status: 'idle' };
    const confirmed = sync.confirmedProfile ? PROFILES[sync.confirmedProfile] || sync.confirmedProfile : 'Not confirmed';
    const duplicateName = state.view.thermostats.filter(item => item.name === room.name).length > 1;
    heading.append(element('p', 'thermostat-subtitle',
      `${duplicateName ? `Device …${room.id.slice(-6)} · ` : ''}Last confirmed profile: ${confirmed}`));
    label.append(checkbox, heading);
    title.append(label, statusBadge(room.online ? 'online' : 'offline', room.online ? 'Online' : 'Offline'));
    const stats = element('div', 'thermostat-stats');
    appendStat(stats, room.online ? 'Room temperature' : 'Last reported room temperature', formatTemperature(room.currentTemperature), 'temperature');
    appendStat(stats, 'Set temperature', formatTemperature(room.targetTemperature));
    const grouping = typeof room.grouping === 'number' ? (room.grouping & 1 ? '5+1+1 days' : 'Seven days') : 'Grouping unknown';
    appendStat(stats, 'Thermostat programme', `${MODES[room.mode] || room.mode || 'Mode unknown'} · ${grouping}`);
    const syncStat = element('div');
    syncStat.append(element('span', 'stat-label', 'Programme sync'), statusBadge(sync.status || 'idle'));
    stats.append(syncStat);
    header.append(title, stats);
    if (room.override && !['completed', 'failed', 'idle'].includes(room.override.status)) {
      header.append(element('p', 'override-state', `Temporary temperature: ${formatTemperature(room.override.temperature)} until ${formatDate(room.override.endsAt)} · ${STATUSES[room.override.status] || room.override.status}`));
    }
    header.append(nowAndNext(room));
    const reportedAt = room.lastReportedAt ?? room.temperatureReportedAt;
    const receivedAt = room.lastReceivedAt ?? room.temperatureReceivedAt;
    header.append(element('p', 'last-confirmed', `Reading time: ${reportedAt ? formatDate(reportedAt) : 'device time unavailable'} · received locally: ${formatDate(receivedAt)}${room.telemetryAvailable === false ? ' · live telemetry unavailable' : ''}`));
    header.append(element('p', 'last-confirmed', `Last programme read: ${formatDate(room.lastUpdated)}`));
    if (sync.error) {
      header.append(element('p', 'last-confirmed', sync.error));
    }

    const body = element('div', 'thermostat-body');
    body.append(roomTools(room));
    const editor = details(`${room.id}:editor`, `Edit ${PROFILES[state.profile]} programme`, 'programme-editor');
    const draft = getDraft(room);
    const draftStatus = element('span', `draft-status ${draft.dirty ? 'unsaved' : ''}`,
      draft.dirty ? 'Unsaved changes' : room.profiles && room.profiles[state.profile] ? 'Saved draft' : 'New draft');
    const actions = element('div', 'thermostat-actions');
    const draftTitle = element('div');
    draftTitle.append(element('h3', '', `${PROFILES[state.profile]} programme`), draftStatus);
    const buttons = element('div');
    const readCurrent = button('Read programme', () => readProgramme(room));
    readCurrent.disabled = BUSY.has(sync.status) || state.pending;
    buttons.append(
      button('Save draft', () => saveDraft(room).catch(() => {})),
      readCurrent,
      button('Review & apply', () => prepareApply([room.id]).catch(error => showMessage(error.message, 'error')), 'primary'),
    );
    actions.append(draftTitle, buttons);
    editor.append(actions, element('p', 'schedule-help', 'Four periods per day. Temperatures are in Celsius; each period continues until the next one.'));
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
    const count = room.schedule && Array.isArray(room.schedule.missing) ? 28 - room.schedule.missing.length : 0;
    const native = details(`${room.id}:native`, `Programme on thermostat · ${room.schedule && room.schedule.complete ? 'complete' : `${count}/28 periods received`}`, 'native-programme');
    const nativeActions = element('div', 'thermostat-actions');
    const read = button(BUSY.has(sync.status) ? 'Operation in progress…' : 'Read programme', () => readProgramme(room));
    read.disabled = BUSY.has(sync.status) || state.pending;
    const useNative = button('Copy into this draft', () => {
      draft.schedule = normaliseSchedule(room.schedule);
      draft.dirty = true;
      render();
    });
    useNative.disabled = !(room.schedule && room.schedule.complete);
    nativeActions.append(read, useNative);
    native.append(element('p', 'last-confirmed', 'This is the programme reported by the device. Missing periods remain unknown.'), nativeActions, nativeTable(room.schedule));
    body.append(native, temperatureHistory(room), programmeHistory(room));
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
    document.querySelectorAll('[data-detail]').forEach(node => { node.open = !!openDetails.get(node.dataset.detail); });
    if (focused) {
      const input = Array.from(document.querySelectorAll('[data-focus]')).find(node => node.dataset.focus === focused);
      if (input) {
        input.focus({ preventScroll: true });
      }
    }
    const presence = state.view.presence || {};
    const home = presence.home;
    const effectiveHome = presence.effectiveHome ?? home;
    const holiday = !!(state.view.holiday && state.view.holiday.active);
    byId('household-state').textContent = state.view.controls && state.view.controls.recoveryRequired
      ? 'Household timers need review. Open Presence, guests & holiday return to resume them.'
      : state.view.holiday && state.view.holiday.preheating ? 'Holiday preheat: Home programme selected before your return.'
      : holiday ? 'Holiday programme selected. Presence is remembered for your return.'
      : presence.holdUntil ? `Guest hold: Home programme until ${formatDate(presence.holdUntil)}.`
        : presence.pendingAwayAt ? `Everyone is away. Home programme continues until ${formatDate(presence.pendingAwayAt)}.`
          : effectiveHome === true ? 'Someone is home. Home programme selected.'
            : effectiveHome === false ? 'Everyone is away. Away programme selected.' : 'Presence has not been set.';
    byId('home-control').classList.toggle('selected', home === true);
    byId('away-control').classList.toggle('selected', home === false);
    byId('holiday-control').classList.toggle('selected', holiday);
    byId('holiday-control').textContent = holiday ? 'End holiday' : 'Enable holiday';
    for (const id of ['home-control', 'away-control', 'holiday-control']) {
      byId(id).disabled = !state.online || state.pending;
    }
    updateSelection();
    if (typeof homebridge.fixScrollHeight === 'function') {
      homebridge.fixScrollHeight();
    }
  }

  async function prepareApply(deviceIds) {
    const profile = state.profile;
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
      section.append(element('h4', '', `${item.name} · ${item.changes} period${item.changes === 1 ? '' : 's'} changed`));
      const room = thermostat(item.id);
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

  async function prepareOverride(room, temperature, endsAt) {
    const view = await action('/overrides/preview', { deviceId: room.id, temperature, endsAt }, 'Review the temporary temperature before starting.');
    const preview = view.overridePreview || view.preview;
    if (!preview || !preview.id || !Number.isFinite(preview.endsAt)) {
      throw new Error('The controller did not return a complete temporary-temperature preview.');
    }
    state.preview = { ...preview, kind: 'override' };
    byId('preview-title').textContent = 'Review temporary temperature';
    byId('preview-description').textContent = `${room.name}: ${formatTemperature(preview.temperature)} until ${formatDate(preview.endsAt)}.`;
    byId('confirm-apply').textContent = 'Start temporary temperature';
    byId('preview-notice').textContent = 'Homebridge will restore the scheduled programme at expiry. If Homebridge stops or the internet connection fails, Hold can continue beyond the chosen end time. Check the thermostat if restoration cannot be confirmed.';
    const content = byId('preview-content');
    content.replaceChildren();
    content.append(element('p', 'schedule-help', `Current target: ${formatTemperature(room.targetTemperature)}. Starting this override changes the temperature and selects Hold mode. The weekly programme is retained.`));
    for (const warning of preview.warnings || []) {
      content.append(element('p', 'schedule-notice', String(warning)));
    }
    if (preview.warning) {
      content.append(element('p', 'schedule-notice', preview.warning));
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
    byId('apply-selected').addEventListener('click', () => prepareApply(Array.from(state.selected)).catch(error => showMessage(error.message, 'error')));
    byId('cancel-apply').addEventListener('click', closePreview);
    byId('confirm-apply').addEventListener('click', async () => {
      if (!state.preview) {
        return;
      }
      const previewId = state.preview.id;
      const override = state.preview.kind === 'override';
      byId('confirm-apply').disabled = true;
      try {
        await action(override ? '/overrides/start' : '/schedules/apply', override
          ? { previewId, acceptHostDependentExpiry: true } : { previewId }, override
          ? 'Temporary temperature requested. Homebridge and the Tuya connection are needed to restore the programme at expiry.'
          : 'Programme update started. Each thermostat will show its read-back result.');
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
