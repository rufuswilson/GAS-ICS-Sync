const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app(calendar = {}) {
  const logs = [];
  const context = vm.createContext({
    Calendar: calendar,
    Logger: {log(message) { logs.push(String(message)); }},
    Utilities: {
      Charset: {UTF_8: 'UTF_8'}, DigestAlgorithm: {MD5: 'MD5'},
      computeDigest(_kind, value) { return Array.from(Buffer.from(value)); },
      base64Decode(value) { return Array.from(Buffer.from(value, 'base64')); },
      newBlob(bytes) { return {getDataAsString() { return Buffer.from(bytes).toString('utf8'); }}; },
      sleep() {},
    },
    CalendarApp: {EventColor: {}},
  });
  for (const file of ['Config.gs', 'Code.gs', 'Filters.gs', 'Helpers.gs', 'tzid.gs', 'ical.js.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  }
  context.callWithBackoff = fn => fn();
  return {s: context, logs};
}

function event(s, lines, settings = {}) {
  const feed = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:one',
    ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const item = new s.ICAL.Component(s.ICAL.parse(feed)).getAllSubcomponents('vevent')[0];
  item._sourceAddress = 'https://example.test/feed.ics';
  item._sourceSettings = settings;
  return item;
}

test('target calendar ID beats duplicate names, and missing or read-only IDs fail', () => {
  let created = 0;
  const {s} = app({CalendarList: {list() { return {items: [
    {id: 'first', summary: 'Same', accessRole: 'owner'},
    {id: 'second', summary: 'Renamed', accessRole: 'writer'},
    {id: 'readonly', summary: 'Same', accessRole: 'reader'},
  ]}; }}, Calendars: {insert() { created++; }}});
  assert.equal(s.setupTargetCalendar('Same', 'second').id, 'second');
  assert.throws(() => s.setupTargetCalendar('Same', 'readonly'), /not writable/);
  assert.throws(() => s.setupTargetCalendar('Same', 'missing'), /ID not found/);
  assert.equal(created, 0);
  const groups = s.condenseCalendarMap([
    {source: 'first.ics', target: 'Same', targetId: 'second'},
    {source: 'second.ics', target: 'Same', targetId: 'second'},
  ]);
  assert.equal(groups[0].targetId, 'second');
  assert.equal(groups[0].sources.length, 2);
  assert.throws(() => s.condenseCalendarMap([
    {source: 'first.ics', target: 'Same', targetId: 'first'},
    {source: 'second.ics', target: 'Same', targetId: 'second'},
  ]), /Conflicting target IDs/);
});

test('ambiguous, missing, and read-only target names never create a calendar silently', () => {
  let created = 0;
  const pages = {
    first: {items: [{id: 'one', summary: 'Shared', accessRole: 'owner'},
      {id: 'read-only', summary: 'Read only', accessRole: 'reader'}], nextPageToken: 'second'},
    second: {items: [{id: 'two', summary: 'Shared', accessRole: 'writer'}]},
  };
  const {s} = app({CalendarList: {list(options) { return pages[options.pageToken || 'first']; }},
    newCalendar() { return {}; }, Settings: {get() { return {value: 'Etc/GMT'}; }},
    Calendars: {insert(calendar) { created++; return {...calendar, id: 'created'}; }}});
  assert.throws(() => s.setupTargetCalendar('Shared'), /Multiple target calendars.*targetId/);
  assert.throws(() => s.setupTargetCalendar('Read only'), /not writable/);
  assert.throws(() => s.setupTargetCalendar('Missing'), /Target calendar not found/);
  assert.equal(created, 0);
  assert.equal(s.setupTargetCalendar('Shared', 'two').id, 'two');
  assert.equal(s.setupTargetCalendar('New target', undefined, true).id, 'created');
  assert.equal(created, 1);
  assert.equal(s.condenseCalendarMap([{source: 'feed.ics', target: 'New target',
    createTargetCalendarIfMissing: true}])[0].createTargetCalendarIfMissing, true);
  assert.throws(() => s.condenseCalendarMap([
    {source: 'a.ics', target: 'New target', createTargetCalendarIfMissing: true},
    {source: 'b.ics', target: 'New target', createTargetCalendarIfMissing: false},
  ]), /Conflicting target creation settings/);
});

test('target reads use bounded pages and log progress for runtime diagnosis', () => {
  const {s, logs} = app({Events: {list(_calendarId, options) {
    assert.equal(options.maxResults, 250);
    return options.pageToken ? {items: []} : {items: [], nextPageToken: 'second'};
  }}, Settings: {get() { return {value: 'Etc/GMT'}; }}});
  s.LockService = {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }};
  s.sourceCalendars = [{source: 'private-feed.ics', target: 'Target', removeEventsFromCalendar: false}];
  s.fetchSourceCalendars = () => [];
  s.setupTargetCalendar = () => ({id: 'target'});
  s.parseResponses = () => [];
  s.startSync();
  assert.ok(logs.some(line => line.includes('Listing existing target events')));
  assert.equal(logs.filter(line => line.includes('active target events so far')).length, 2);
  assert.equal(logs.join('\n').includes('private-feed.ics'), false);
});

test('repeated target page tokens fail instead of looping indefinitely', () => {
  const {s} = app({Events: {list() { return {items: [], nextPageToken: 'again'}; }}});
  s.LockService = {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }};
  s.sourceCalendars = [{source: 'feed.ics', target: 'Target'}];
  s.fetchSourceCalendars = () => [];
  s.setupTargetCalendar = () => ({id: 'target'});
  assert.throws(() => s.startSync(), /Repeated target-event page token/);
});

test('ICS download explicitly uses UTF-8 and certificate validation', () => {
  const {s} = app();
  let options;
  let charset;
  s.UrlFetchApp = {fetch(_url, opts) { options = opts; return {
    getResponseCode() { return 200; },
    getContentText(encoding) { charset = encoding; return 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:accent\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Réunion\nDESCRIPTION:Café\nEND:VEVENT\nEND:VCALENDAR'; },
  }; }};
  const responses = s.fetchSourceCalendars([{source: 'https://example.test/private.ics'}]);
  assert.equal(responses.length, 1);
  const parsed = s.parseResponses(responses);
  assert.equal(parsed[0].getFirstPropertyValue('summary'), 'Réunion');
  assert.equal(parsed[0].getFirstPropertyValue('description'), 'Café');
  assert.equal(charset, 'UTF-8');
  assert.equal(options.validateHttpsCertificates, undefined);
  assert.equal(options.muteHttpExceptions, true);
});

test('certificate failure is redacted and blocks the source', () => {
  const {s, logs} = app();
  const url = 'https://example.test/private-token/feed.ics';
  s.UrlFetchApp = {fetch() { throw new Error('Certificate error for ' + url); }};
  const result = s.fetchSourceCalendars([{source: url}]);
  assert.equal(result.failed, true);
  assert.equal(logs.join('\n').includes('private-token'), false);
});

test('VFREEBUSY creates stable busy events only when VEVENT is absent', () => {
  const {s} = app();
  const busy = 'BEGIN:VFREEBUSY\nFREEBUSY;FBTYPE=FREE:20261024T090000Z/20261024T100000Z\n' +
    'FREEBUSY;FBTYPE=BUSY:20261024T100000Z/20261024T110000Z\nEND:VFREEBUSY';
  const feed = inner => 'BEGIN:VCALENDAR\nVERSION:2.0\n' + inner + '\nEND:VCALENDAR';
  const source = {kind: 'ics', source: 'https://example.test/busy.ics', settings: {}, content: feed(busy)};
  const first = s.parseResponses([source]);
  assert.equal(first.length, 1);
  assert.equal(first[0].getFirstPropertyValue('summary'), 'Busy');
  assert.equal(first[0].getFirstPropertyValue('uid'), s.parseResponses([source])[0].getFirstPropertyValue('uid'));
  const mixed = s.parseResponses([{...source, content: feed(busy + '\nBEGIN:VEVENT\nUID:real\nDTSTART:20261024T120000Z\nDTEND:20261024T130000Z\nEND:VEVENT')}]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].getFirstPropertyValue('uid'), 'real');
});

test('cancelled ordinary ICS and native targets are inserted, while exceptions still patch', () => {
  const inserts = [];
  const updates = [];
  const {s} = app({Events: {
    insert(copy) { inserts.push(copy); return copy; },
    update(_copy, _target, id) { updates.push(id); return _copy; },
  }});
  s.targetCalendarId = 'target';
  s.calendarEvents = [{id: 'deleted', status: 'cancelled', extendedProperties: {private: {id: 'one', MD5: 'old'}}}];
  s.calendarEventsIds = ['one'];
  s.createICSEvent = () => ({extendedProperties: {private: {id: 'one', MD5: 'new'}}});
  s.processICSEvent({hasProperty() { return false; }}, 'Etc/GMT');
  const source = {calendar: {id: 'source', summary: 'Source'}, source: 'source', settings: {}};
  const native = {id: 'native', summary: 'Native', start: {date: '2026-10-24'}, end: {date: '2026-10-25'}};
  s.calendarEventsIds = [s.nativeEventKey('source', 'native')];
  s.processNativeEvent({nativeEvent: native, source});
  assert.equal(inserts.length, 2);
  assert.deepEqual(updates, []);
});

test('Webex aliases and source timezone survive copying', () => {
  const {s} = app({newEvent() { return {}; }});
  assert.equal(s.tzidreplace['Pacific Time'], 'America/Los_Angeles');
  assert.equal(s.tzidreplace['Eastern Time'], 'America/New_York');
  assert.equal(s.validateICSTimeZone('Pacific Time', 'Etc/GMT'), 'America/Los_Angeles');
  const source = {calendar: {id: 'source', summary: 'Source'}, source: 'source', settings: {}};
  for (const stamp of ['2026-03-28T10:00:00+01:00', '2026-03-29T10:00:00+02:00']) {
    const native = {id: stamp, summary: 'Event', start: {dateTime: stamp, timeZone: 'Europe/Paris'},
      end: {dateTime: stamp, timeZone: 'Europe/Paris'}};
    const copy = s.makeNativeEvent(native, source);
    assert.equal(copy.start.timeZone, 'Europe/Paris');
    assert.equal(copy.end.timeZone, 'Europe/Paris');
  }
  const ics = event(s, ['DTSTART;TZID=Europe/Paris:20260328T100000',
    'DTEND;TZID=Europe/Paris:20260328T110000'], {});
  assert.equal(s.createICSEvent(ics, 'Etc/GMT').start.timeZone, 'Europe/Paris');
});

test('Outlook moved occurrence patches the original recurrence instance', () => {
  let patched;
  const {s} = app({newEvent() { return {}; }, Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      extendedProperties: {private: {id: 'outlook-series', fromGAS: 'true'}}}]}; },
    instances() { return {items: [
      {id: 'moved-target', originalStartTime: {dateTime: '2026-10-24T10:00:00Z'}},
      {id: 'later-target', originalStartTime: {dateTime: '2026-10-25T10:00:00Z'}},
    ]}; },
    patch(body, _calendarId, id) { patched = {body, id}; return {id}; },
  }});
  const feed = fs.readFileSync(path.join(__dirname, 'fixtures', 'outlook-moved.ics'), 'utf8');
  const parsed = s.parseResponses([{kind: 'ics', source: 'outlook.ics', settings: {}, content: feed}]);
  const exception = parsed.find(item => item.hasProperty('recurrence-id'));
  const copy = s.createICSEvent(exception, 'Etc/GMT');
  assert.equal(copy.start.dateTime, '2026-10-24T14:00:00Z');
  assert.equal(copy.recurringEventId, '2026-10-24T10:00:00Z');
  s.processICSEventInstance(copy);
  assert.equal(patched.id, 'moved-target');
  assert.equal(patched.body.recurringEventId, undefined);
});

test('cancelled recurrence instance is restored through its exception path', () => {
  let patch;
  const {s} = app({Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: {private: {id: 'series', fromGAS: 'true'}}}]}; },
    instances() { return {items: [{id: 'exception', status: 'cancelled',
      originalStartTime: {dateTime: '2026-10-24T10:00:00Z'}}]}; },
    patch(body, _calendarId, id) { patch = {body, id}; return {id}; },
  }});
  s.targetCalendarId = 'target';
  s.processICSEventInstance({recurringEventId: '2026-10-24T10:00:00Z',
    extendedProperties: {private: {id: 'series', MD5: 'new'}}});
  assert.equal(patch.id, 'exception');
  assert.equal(patch.body.status, 'confirmed');
});

test('HTML ALTREP updates checksum, malformed data falls back, and blank text is omitted', () => {
  const {s} = app({newEvent() { return {}; }});
  const base = ['DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025', 'SUMMARY:Meeting'];
  const plain = s.createICSEvent(event(s, [...base, 'DESCRIPTION:Plain']), 'Etc/GMT');
  const html = s.createICSEvent(event(s, [...base, 'DESCRIPTION;ALTREP="data:text/html,%3Ca%20href%3D%22https%3A%2F%2Fexample.test%22%3ELink%3C%2Fa%3E":Plain']), 'Etc/GMT');
  assert.match(html.description, /<a href="https:\/\/example.test">Link<\/a>/);
  assert.notEqual(html.extendedProperties.private.MD5, plain.extendedProperties.private.MD5);
  const malformed = s.createICSEvent(event(s, [...base, 'DESCRIPTION;ALTREP="data:text/html,%XY":Plain']), 'Etc/GMT');
  assert.equal(malformed.description, 'Plain');
  const encoded = Buffer.from('<b>Bold</b>').toString('base64');
  assert.equal(s.createICSEvent(event(s, [...base, `DESCRIPTION;ALTREP="data:text/html;base64,${encoded}":Plain`]), 'Etc/GMT').description,
    '<b>Bold</b>');
  const blank = s.createICSEvent(event(s, [...base, 'DESCRIPTION:   ']), 'Etc/GMT');
  assert.equal(blank.description, undefined);
});

test('title prefix is source scoped and can be limited to all-day events', () => {
  const {s} = app({newEvent() { return {}; }});
  const settings = {titlePrefix: 'Away: ', titlePrefixAllDayOnly: true};
  const allDay = event(s, ['DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025', 'SUMMARY:Trip'], settings);
  const timed = event(s, ['DTSTART:20261024T100000Z', 'DTEND:20261024T110000Z', 'SUMMARY:Call'], settings);
  assert.equal(s.createICSEvent(allDay, 'Etc/GMT').summary, 'Away: Trip');
  assert.equal(s.createICSEvent(timed, 'Etc/GMT').summary, 'Call');
  const source = {calendar: {id: 'source', summary: 'Source'}, source: 'source', settings};
  assert.equal(s.makeNativeEvent({id: 'a', summary: 'Trip', start: {date: '2026-10-24'}, end: {date: '2026-10-25'}}, source).summary, 'Away: Trip');
  assert.equal(s.makeNativeEvent({id: 'b', summary: 'Call', start: {dateTime: '2026-10-24T10:00:00Z'}, end: {dateTime: '2026-10-24T11:00:00Z'}}, source).summary, 'Call');
});

test('Microsoft tentative free mapping honors explicit transparency', () => {
  const {s} = app({newEvent() { return {}; }});
  const base = ['DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025', 'SUMMARY:Meeting'];
  const settings = {mapMicrosoftTentativeToFree: true};
  assert.equal(s.createICSEvent(event(s, [...base, 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE'], settings), 'Etc/GMT').transparency, 'transparent');
  assert.equal(s.createICSEvent(event(s, [...base, 'STATUS:TENTATIVE'], settings), 'Etc/GMT').transparency, undefined);
  assert.equal(s.createICSEvent(event(s, [...base, 'TRANSP:OPAQUE', 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE'], settings), 'Etc/GMT').transparency, 'opaque');
});

test('all-day reminder precedence, absolute alarm, fallback, and Safe Links', () => {
  const {s} = app({newEvent() { return {}; }});
  const day = ['DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025'];
  const timed = ['DTSTART:20250114T140000Z', 'DTEND:20250114T150000Z'];
  for (const mode of ['yes', 'default']) {
    const copy = s.createICSEvent(event(s, day, {addAlerts: mode, defaultAllDayReminder: 30}), 'Etc/GMT');
    assert.equal(copy.reminders.overrides[0].minutes, 30);
  }
  assert.equal(s.createICSEvent(event(s, day, {addAlerts: 'no', defaultAllDayReminder: 30}), 'Etc/GMT').reminders.overrides.length, 0);
  const alarm = s.createICSEvent(event(s, [...timed, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:20250114T133635Z', 'END:VALARM'], {addAlerts: 'yes'}), 'Etc/GMT');
  assert.equal(alarm.reminders.overrides[0].minutes, 23);
  assert.equal(s.createICSEvent(event(s, timed, {addAlerts: 'yes', fallbackReminderMinutes: 15}), 'Etc/GMT').reminders.overrides[0].minutes, 15);
  assert.equal(s.createICSEvent(event(s, timed, {addAlerts: 'default', fallbackReminderMinutes: 15}), 'Etc/GMT').reminders.useDefault, true);
  const link = 'https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.test%2Fmeeting&data=secret';
  assert.equal(s.decodeSafeLinks('Join ' + link), 'Join https://example.test/meeting');
  assert.equal(s.decodeSafeLinks('Other https://example.test/?url=https%3A%2F%2Fevil.test'), 'Other https://example.test/?url=https%3A%2F%2Fevil.test');
  assert.equal(s.createICSEvent(event(s, [...timed, 'DESCRIPTION:Join ' + link],
    {decodeOutlookSafeLinks: true}), 'Etc/GMT').description, 'Join https://example.test/meeting');
});

test('summary subject omits zero-count clauses', () => {
  const {s} = app();
  let sent;
  s.MailApp = {sendEmail(message) { sent = message; }};
  s.email = 'me@example.test';
  s.addedEvents = [[["Meeting", '2026-10-24', '2026-10-25'], 'Target']];
  s.sendSummary();
  assert.match(sent.subject, /1 new$/);
  assert.doesNotMatch(sent.subject, /0 modified|0 deleted/);
});
