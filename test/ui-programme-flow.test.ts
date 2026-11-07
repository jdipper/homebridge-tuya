import path from 'path';

const { scheduleRoomLabel, copyCompleteNativeProgramme, cloneProgrammeForRooms } = require(
  path.join(__dirname, '../homebridge-ui/public/schedule.js'),
);

const nativeWeek = () => ({
  complete: true,
  days: [1, 2, 4, 8, 16, 32, 64].map(day => ({
    day, complete: true,
    events: [
      { event: 0, hour: 5, minute: 30, temperature: 20 },
      { event: 1, hour: 8, minute: 30, temperature: 12 },
      { event: 2, hour: 17, minute: 0, temperature: 20.5 },
      { event: 3, hour: 22, minute: 0, temperature: 12 },
    ],
  })),
});

describe('programme preparation in the thermostat editor', () => {
  test('imports all 28 native periods as an independent draft, keeping the source untouched', () => {
    const source = nativeWeek();
    const draft = copyCompleteNativeProgramme(source);
    expect(draft.days).toHaveLength(7);
    expect(draft.days.flatMap((day: { events: unknown[] }) => day.events)).toHaveLength(28);
    expect(draft.days[0].events[2].temperature).toBe(20.5);
    draft.days[0].events[0].temperature = 18;
    expect(source.days[0].events[0].temperature).toBe(20);
    expect(source.days[0].complete).toBe(true);
    expect(draft).not.toHaveProperty('complete');
  });

  test('orders native reports by day and period rather than their arrival order', () => {
    const source = nativeWeek();
    source.days.reverse();
    source.days.forEach(day => day.events.reverse());
    const draft = copyCompleteNativeProgramme(source);
    expect(draft.days.map((day: { day: number }) => day.day)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(draft.days[0].events.map((event: { event: number }) => event.event)).toEqual([0, 1, 2, 3]);
  });

  test.each(['not-confirmed', 'incomplete-day', 'incomplete-period', 'missing-period', 'duplicate-day', 'duplicate-period', 'bad-time', 'out-of-order', 'bad-step'])(
    'refuses %s native data instead of inventing a programme', failure => {
      const source = nativeWeek();
      if (failure === 'not-confirmed') source.complete = false;
      if (failure === 'incomplete-day') source.days[3].complete = false;
      if (failure === 'incomplete-period') Object.assign(source.days[3].events[1], { complete: false });
      if (failure === 'missing-period') source.days[3].events.pop();
      if (failure === 'duplicate-day') source.days[3].day = 1;
      if (failure === 'duplicate-period') source.days[3].events[1].event = 0;
      if (failure === 'bad-time') source.days[3].events[1].minute = 60;
      if (failure === 'out-of-order') source.days[3].events[1].hour = 4;
      if (failure === 'bad-step') source.days[3].events[1].temperature = 18.2;
      expect(() => copyCompleteNativeProgramme(source)).toThrow();
    },
  );

  test('one programme produces independent drafts only for the selected rooms', () => {
    const source = copyCompleteNativeProgramme(nativeWeek());
    const prepared = cloneProgrammeForRooms(source, ['kitchen', 'hall']);
    expect(prepared.map((item: { deviceId: string }) => item.deviceId)).toEqual(['kitchen', 'hall']);
    prepared[0].schedule.days[0].events[0].temperature = 18;
    expect(prepared[1].schedule.days[0].events[0].temperature).toBe(20);
    expect(source.days[0].events[0].temperature).toBe(20);
    expect(prepared).not.toContainEqual(expect.objectContaining({ deviceId: 'bedroom' }));
  });
});

describe('room labels', () => {
  test('uses the resolved alias or SmartLife room instead of the generic device name', () => {
    expect(scheduleRoomLabel({ id: 'room-1', name: 'Kitchen', roomName: 'Kitchen', deviceName: 'Thermostat' })).toBe('Kitchen');
    expect(scheduleRoomLabel({ id: 'room-1', name: 'Annexe', roomName: 'Kitchen', deviceName: 'Thermostat' })).toBe('Annexe');
    expect(scheduleRoomLabel({ id: 'room-1', roomName: 'Kitchen', deviceName: 'Thermostat' })).toBe('Kitchen');
  });

  test('keeps identically named rooms distinct in selection and source lists', () => {
    const rooms = [{ id: 'pilot-abcdef', name: 'Kitchen' }, { id: 'pilot-ghijkl', name: 'Kitchen' }];
    expect(scheduleRoomLabel(rooms[0], rooms)).toBe('Kitchen · …abcdef');
    expect(scheduleRoomLabel(rooms[1], rooms)).toBe('Kitchen · …ghijkl');
  });
});
