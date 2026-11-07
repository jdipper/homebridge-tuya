import path from 'path';

const { householdProgrammeIntent, householdProgrammeContext, roomProgrammeFeedback, buildProgrammeFeedback } = require(
  path.join(__dirname, '../homebridge-ui/public/schedule.js'),
);

const confirmedRoom = (id = 'hall', profile = 'home') => ({
  id, name: id === 'hall' ? 'Hall' : 'Kitchen', enabled: true, online: true, mode: 'smart', schedule: { complete: true },
  sync: { status: 'verified', profileStatus: 'confirmed', requestedProfile: profile, confirmedProfile: profile,
    confirmationMatchesRequested: true, confirmedAt: 1794079800000 },
});
const household = (thermostats = [confirmedRoom()]) => ({
  thermostats, presence: { home: true, effectiveHome: true }, holiday: { active: false },
});
const options = { online: true, formatDate: () => '7 Nov, 19:30' };

describe('programme confirmation feedback', () => {
  test('only confirms the current household intent across enabled rooms, independent of editing a profile', () => {
    const disabled = { ...confirmedRoom('unused', 'holiday'), enabled: false };
    const view = { ...household([confirmedRoom(), confirmedRoom('kitchen'), disabled]), editingProfile: 'holiday' };
    const feedback = buildProgrammeFeedback(view, options);
    expect(feedback.title).toBe('Home confirmed on all 2 rooms');
    expect(feedback.counts).toMatchObject({ confirmed: 2, total: 2 });
    expect(feedback.rooms).toHaveLength(2);
    expect(roomProgrammeFeedback(view.thermostats[0], options).detail).toContain('7 Nov, 19:30');
  });

  test.each(['generic-read', 'saved-programme-edited', 'other-profile', 'missing-time', 'missing-read', 'manual-mode'])(
    '%s cannot turn remembered profile names into a current confirmation', failure => {
      const room = confirmedRoom();
      if (failure === 'generic-read') Object.assign(room.sync, { profileStatus: 'pending', confirmationMatchesRequested: false });
      if (failure === 'saved-programme-edited') Object.assign(room.sync, { confirmationMatchesRequested: false });
      if (failure === 'other-profile') Object.assign(room.sync, { requestedProfile: 'away', confirmedProfile: 'home' });
      if (failure === 'missing-time') Object.assign(room.sync, { confirmedAt: null });
      if (failure === 'missing-read') room.schedule.complete = false;
      if (failure === 'manual-mode') room.mode = 'hold';
      const feedback = buildProgrammeFeedback(household([room]), options);
      expect(feedback.kind).not.toBe('confirmed');
      expect(feedback.counts.confirmed).toBe(0);
    },
  );

  test('shows upload progress without waiting for all rooms or conflating it with acceptance', () => {
    const applying = confirmedRoom('kitchen', 'holiday');
    Object.assign(applying.sync, { status: 'applying', profileStatus: 'applying', applyingProfile: 'holiday',
      confirmationMatchesRequested: false, confirmedProfile: 'home' });
    const view = { ...household([confirmedRoom('hall', 'holiday'), applying]), holiday: { active: true } };
    const feedback = buildProgrammeFeedback(view, options);
    expect(feedback.title).toBe('Applying Holiday · 1 of 2 rooms confirmed');
    expect(feedback.rooms[1].title).toBe('Applying Holiday');
    expect(feedback.rooms[1].detail).toContain('Last confirmed: Home');
  });

  test('names an older upload honestly while the newest household selection waits', () => {
    const room = confirmedRoom('hall', 'holiday');
    Object.assign(room.sync, { status: 'applying', profileStatus: 'applying', applyingProfile: 'away',
      queuedProfile: 'holiday', confirmationMatchesRequested: false });
    const view = { ...household([room]), holiday: { active: true } };
    expect(buildProgrammeFeedback(view, options).title).toContain('Updating programmes · Holiday requested');
    expect(roomProgrammeFeedback(room, options)).toMatchObject({ title: 'Applying Away' });
    expect(roomProgrammeFeedback(room, options).detail).toContain('Holiday requested');
  });

  test('a queued upload behind a programme read stays visible', () => {
    const room = confirmedRoom();
    Object.assign(room.sync, { status: 'reading', profileStatus: 'pending', queuedProfile: 'home', confirmationMatchesRequested: false });
    expect(roomProgrammeFeedback(room, options)).toMatchObject({ kind: 'applying', title: 'Home queued' });
  });

  test('identifies failed and offline rooms while retaining historical confirmation times', () => {
    const failed = confirmedRoom();
    Object.assign(failed.sync, { status: 'partial', profileStatus: 'partial', error: 'Programme read-back did not match.' });
    const offline = { ...confirmedRoom('kitchen'), online: false };
    const feedback = buildProgrammeFeedback(household([failed, offline]), options);
    expect(feedback.counts).toMatchObject({ confirmed: 0, attention: 1, offline: 1, total: 2 });
    expect(feedback.title).toContain('2 need attention');
    expect(feedback.detail).toContain('Hall, Kitchen (offline)');
    expect(feedback.rooms[0].detail).toContain('read-back did not match');
    expect(feedback.rooms[1].detail).toContain('Last confirmed: Home · 7 Nov, 19:30');
  });

  test('controller loss withdraws success without discarding last confirmed room information', () => {
    const view = household();
    expect(buildProgrammeFeedback(view, { ...options, online: false }).kind).toBe('offline');
    const room = roomProgrammeFeedback(view.thermostats[0], { ...options, online: false });
    expect(room.kind).toBe('offline');
    expect(room.detail).toContain('Last confirmed: Home · 7 Nov, 19:30');
  });

  test('temporary override and recovery never appear as current programme success', () => {
    const room = { ...confirmedRoom(), override: { status: 'active' } };
    expect(buildProgrammeFeedback(household([room]), options).counts.confirmed).toBe(0);
    Object.assign(room.override, { status: 'recovery-required', error: 'Restore the original programme.' });
    expect(roomProgrammeFeedback(room, options)).toMatchObject({ kind: 'attention', title: 'Programme restoration needs attention' });
    const policyRecovery = { ...household(), controls: { recoveryRequired: 'Review an overdue deadline.' } };
    expect(buildProgrammeFeedback(policyRecovery, options).title).toContain('Household timers need review');
  });

  test('manual confirmations in non-enrolled rooms do not imply household switching works', () => {
    const room = { ...confirmedRoom(), enabled: false };
    Object.assign(room.sync, { requestedProfile: null, confirmationMatchesRequested: false });
    const feedback = buildProgrammeFeedback(household([room]), options);
    expect(feedback.kind).toBe('neutral');
    expect(feedback.title).toBe('No rooms enabled for automatic changes');
    expect(feedback.detail).toContain('will not apply programmes to any room');
    expect(roomProgrammeFeedback(room, options)).toMatchObject({ kind: 'inactive', title: 'Automatic changes off' });
    expect(roomProgrammeFeedback(room, options).detail).toContain('Last confirmed: Home');
  });

  test('an enrolled room with unknown presence waits for selection rather than claiming automation is off', () => {
    const room = confirmedRoom();
    Object.assign(room.sync, { requestedProfile: null, confirmationMatchesRequested: false });
    expect(roomProgrammeFeedback(room, options)).toMatchObject({ kind: 'pending', title: 'Waiting for household selection' });
    room.online = false;
    expect(roomProgrammeFeedback(room, options).title).toBe('Offline · no programme requested');
  });
});

describe('household timing and priority', () => {
  const formatDate = () => '19:15';
  test('Away delay counts the effective Home programme and gives an explicit future request time', () => {
    const view = { ...household(), presence: { home: false, effectiveHome: true, pendingAwayAt: 1794078900000 } };
    expect(householdProgrammeIntent(view)).toBe('home');
    expect(buildProgrammeFeedback(view, options).title).toBe('Home confirmed in 1 room');
    expect(householdProgrammeContext(view, formatDate)).toBe('Away scheduled for 19:15. Home remains requested until then.');
  });

  test('explicit unknown effective presence is not replaced with actual Away before its delay', () => {
    const view = { ...household(), presence: { home: false, effectiveHome: null, pendingAwayAt: 1794078900000 } };
    expect(householdProgrammeIntent(view)).toBeNull();
    expect(householdProgrammeContext(view, formatDate)).toContain('No household programme is currently requested');
    expect(buildProgrammeFeedback(view, options).kind).toBe('neutral');
  });

  test('a guest hold takes priority over an earlier Away deadline', () => {
    const view = { ...household(), presence: { home: false, effectiveHome: true,
      pendingAwayAt: 1794078900000, holdUntil: 1794082500000 } };
    expect(householdProgrammeContext(view, formatDate)).toBe('Guest hold: Home programme requested until 19:15.');
  });

  test('Holiday takes priority over presence and guest holds; preheat instead requests Home', () => {
    const view = { ...household(), presence: { home: false, effectiveHome: true, holdUntil: 1794082500000 },
      holiday: { active: true, preheating: false } };
    expect(householdProgrammeIntent(view)).toBe('holiday');
    expect(householdProgrammeContext(view, formatDate)).toContain('Holiday takes priority');
    view.holiday.preheating = true;
    expect(householdProgrammeIntent(view)).toBe('home');
    expect(householdProgrammeContext(view, formatDate)).toContain('Holiday preheat: Home');
    expect(buildProgrammeFeedback(view, options).title).toBe('Home confirmed in 1 room');
  });
});
