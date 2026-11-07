/* global homebridge */
'use strict';

(() => {
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
  };
  const BUSY = new Set(['reading', 'applying', 'queued']);
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
    const editing = document.activeElement && document.activeElement.matches('.event-inputs input');
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
    appendStat(stats, 'Room temperature', formatTemperature(room.currentTemperature), 'temperature');
    appendStat(stats, 'Set temperature', formatTemperature(room.targetTemperature));
    const grouping = typeof room.grouping === 'number' ? (room.grouping & 1 ? '5+1+1 days' : 'Seven days') : 'Grouping unknown';
    appendStat(stats, 'Thermostat programme', `${MODES[room.mode] || room.mode || 'Mode unknown'} · ${grouping}`);
    const syncStat = element('div');
    syncStat.append(element('span', 'stat-label', 'Programme sync'), statusBadge(sync.status || 'idle'));
    stats.append(syncStat);
    header.append(title, stats);
    header.append(element('p', 'last-confirmed', `Last programme read: ${formatDate(room.lastUpdated)}`));
    if (sync.error) {
      header.append(element('p', 'last-confirmed', sync.error));
    }

    const body = element('div', 'thermostat-body');
    const draft = getDraft(room);
    const draftStatus = element('span', `draft-status ${draft.dirty ? 'unsaved' : ''}`,
      draft.dirty ? 'Unsaved changes' : room.profiles && room.profiles[state.profile] ? 'Saved draft' : 'New draft');
    const actions = element('div', 'thermostat-actions');
    const draftTitle = element('div');
    draftTitle.append(element('h3', '', `${PROFILES[state.profile]} programme`), draftStatus);
    const buttons = element('div');
    const readCurrent = button('Read programme', () => {
      action('/schedules/read', { deviceIds: [room.id] }, `Reading ${room.name}. Programme reports may take a moment to arrive.`).catch(() => {});
    });
    readCurrent.disabled = BUSY.has(sync.status) || state.pending;
    buttons.append(
      button('Save draft', () => saveDraft(room).catch(() => {})),
      readCurrent,
      button('Review & apply', () => prepareApply([room.id]).catch(error => showMessage(error.message, 'error')), 'primary'),
    );
    actions.append(draftTitle, buttons);
    body.append(actions, element('p', 'schedule-help', 'Four periods per day. Temperatures are in Celsius; each period continues until the next one.'));
    if (typeof room.grouping === 'number' && (room.grouping & 1)) {
      body.append(element('p', 'schedule-notice', 'The thermostat uses grouped 5+1+1 programming. Before applying a weekly profile, select seven-day programming in SmartLife and read the programme again. Grouping and adaptive-start settings are preserved by this editor.'));
    }
    body.append(editorTable(room, draft, draftStatus), copyControls(room, draft));

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
    body.append(automatic);
    body.append(element('p', 'last-confirmed', missingProfiles.length
      ? `Save complete ${missingProfiles.map(profile => PROFILES[profile]).join(', ')} profiles before enabling automatic changes.`
      : 'Home, Away and Holiday drafts are saved. Automatic changes upload the selected saved programme and activate scheduled (Smart) mode.'));

    const native = element('details', 'native-programme');
    const count = room.schedule && Array.isArray(room.schedule.missing) ? 28 - room.schedule.missing.length : 0;
    native.append(element('summary', '', `Programme on thermostat · ${room.schedule && room.schedule.complete ? 'complete' : `${count}/28 periods received`}`));
    const nativeActions = element('div', 'thermostat-actions');
    const read = button(BUSY.has(sync.status) ? 'Operation in progress…' : 'Read programme', () => {
      action('/schedules/read', { deviceIds: [room.id] }, `Reading ${room.name}. Programme reports may take a moment to arrive.`).catch(() => {});
    });
    read.disabled = BUSY.has(sync.status) || state.pending;
    const useNative = button('Copy into this draft', () => {
      draft.schedule = normaliseSchedule(room.schedule);
      draft.dirty = true;
      render();
    });
    useNative.disabled = !(room.schedule && room.schedule.complete);
    nativeActions.append(read, useNative);
    native.append(element('p', 'last-confirmed', 'This is the programme reported by the device. Missing periods remain unknown.'), nativeActions, nativeTable(room.schedule));
    body.append(native);
    card.append(header, body);
    return card;
  }

  function render() {
    const focused = document.activeElement && document.activeElement.dataset.focus;
    const openDetails = Array.from(document.querySelectorAll('.native-programme')).map(node => node.open);
    const container = byId('thermostats');
    container.replaceChildren();
    if (!state.view.thermostats.length) {
      const empty = element('div', 'schedule-empty');
      empty.append(element('h3', '', 'No supported thermostats found'),
        element('p', '', 'The schedule editor currently supports FastWarm Smart WiFi 2.0 / ET-63 thermostats. Your other Tuya accessories remain available through Homebridge.'));
      container.append(empty);
    }
    state.view.thermostats.forEach((room, index) => {
      const card = renderRoom(room);
      card.querySelector('details').open = !!openDetails[index];
      container.append(card);
    });
    if (focused) {
      const input = Array.from(document.querySelectorAll('[data-focus]')).find(node => node.dataset.focus === focused);
      if (input) {
        input.focus({ preventScroll: true });
      }
    }
    const home = state.view.presence && state.view.presence.home;
    const holiday = !!(state.view.holiday && state.view.holiday.active);
    byId('household-state').textContent = holiday ? 'Holiday programme selected. Presence is remembered for your return.'
      : home === true ? 'Someone is home. Home programme selected.'
        : home === false ? 'Everyone is away. Away programme selected.' : 'Presence has not been set.';
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
    state.preview = view.preview;
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
