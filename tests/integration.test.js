const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function script(calendar, options = {}) {
  const logs = options.logs || [];
  const properties = new Map();
  const context = vm.createContext({
    Calendar: calendar,
    Logger: {log(message) { logs.push(String(message)); }},
    Utilities: {Charset: {UTF_8: 'UTF_8'}, DigestAlgorithm: {MD5: 'MD5'},
      computeDigest(_algorithm, value) { return Array.from(Buffer.from(value)); }, sleep() {}},
    CalendarApp: {EventColor: {BLUE: '9', RED: '11'}},
    PropertiesService: {getScriptProperties() { return {
      getProperty(key) { return properties.get(key) || null; },
      setProperty(key, value) { properties.set(key, String(value)); },
      deleteProperty(key) { properties.delete(key); },
    }; }},
  });
  for (const filename of ['Config.gs', 'Code.gs', 'Filters.gs', 'Helpers.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, {filename});
  }
  if (!options.realBackoff) context.callWithBackoff = fn => fn();
  return context;
}

test('retry limit is available from Code.gs without Config.gs', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), context);
  assert.equal(context.defaultMaxRetries, 10);
});

test('sync lock is released after success and after an error', () => {
  const s = script({});
  let held = false;
  let releases = 0;
  s.LockService = {getScriptLock() { return {
    tryLock() { if (held) return false; held = true; return true; },
    releaseLock() { held = false; releases++; },
  }; }};
  s.sourceCalendars = [];
  s.startSync();
  assert.equal(releases, 1);
  s.condenseCalendarMap = () => { throw new Error('source failure'); };
  assert.throws(() => s.startSync(), /source failure/);
  assert.equal(releases, 2);
  assert.equal(held, false);
});

test('sync does no work when another run holds the lock', () => {
  const s = script({});
  let releases = 0;
  let grouped = false;
  s.LockService = {getScriptLock() { return {
    tryLock() { return false; },
    releaseLock() { releases++; },
  }; }};
  s.condenseCalendarMap = () => { grouped = true; return []; };

  assert.equal(s.startSync(), undefined);
  assert.equal(grouped, false);
  assert.equal(releases, 0);
});

test('target calendar lookup reads later pages before creating a calendar', () => {
  const pages = [];
  let created = 0;
  const s = script({CalendarList: {list(options) {
    pages.push(options.pageToken || 'first');
    return options.pageToken ? {items: [{id: 'existing', summary: 'Target', accessRole: 'owner'}]} :
      {items: [], nextPageToken: 'second'};
  }}, Calendars: {insert() { created++; return {id: 'new'}; }}});
  assert.equal(s.setupTargetCalendar('Target').id, 'existing');
  assert.deepEqual(pages, ['first', 'second']);
  assert.equal(created, 0);
  s.Calendar.CalendarList.list = () => null;
  assert.throws(() => s.setupTargetCalendar('Target'), /Could not list target calendars/);
});

test('incomplete target event pagination stops the sync and releases its lock', () => {
  const s = script({Events: {list(_id, options) {
    return options.pageToken ? null : {items: [], nextPageToken: 'second'};
  }}});
  let released = false;
  let cleaned = false;
  s.LockService = {getScriptLock() { return {tryLock() { return true; },
    releaseLock() { released = true; }}; }};
  s.sourceCalendars = [{source: 'feed.ics', target: 'Target'}];
  s.fetchSourceCalendars = () => [];
  s.setupTargetCalendar = () => ({id: 'target'});
  s.processEventCleanup = () => { cleaned = true; };
  assert.throws(() => s.startSync(), /Could not list all target events/);
  assert.equal(cleaned, false);
  assert.equal(released, true);
});

test('failed first target page prevents event processing and cleanup', () => {
  const s = script({Events: {list() { return null; }}});
  let released = false;
  let parsed = false;
  let cleaned = false;
  s.LockService = {getScriptLock() { return {tryLock() { return true; },
    releaseLock() { released = true; }}; }};
  s.sourceCalendars = [{source: 'feed.ics', target: 'Target'}];
  s.fetchSourceCalendars = () => [];
  s.setupTargetCalendar = () => ({id: 'target'});
  s.parseResponses = () => { parsed = true; return []; };
  s.processEventCleanup = () => { cleaned = true; };

  assert.throws(() => s.startSync(), /Could not list target events/);
  assert.equal(parsed, false);
  assert.equal(cleaned, false);
  assert.equal(released, true);
});

test('ICS events with a shared UID update only their own source copy', () => {
  const updates = [];
  const s = script({Events: {update(event, _calendar, id) { updates.push(id); return event; }}});
  const a = s.sourceAddressHash('a.ics');
  const b = s.sourceAddressHash('b.ics');
  s.targetCalendarId = 'target';
  s.calendarEventsIds = ['shared', 'shared'];
  s.calendarEvents = [
    {id: 'target-a', extendedProperties: {private: {sourceHash: a, MD5: 'old'}}},
    {id: 'target-b', extendedProperties: {private: {sourceHash: b, MD5: 'old'}}},
  ];
  s.icsEventSourceHashes.shared = [a, b];
  s.createICSEvent = event => ({summary: event.summary,
    extendedProperties: {private: {id: 'shared', sourceHash: s.sourceAddressHash(event._sourceAddress), MD5: 'new'}}});
  s.processICSEvent({_sourceAddress: 'a.ics', summary: 'A', hasProperty() { return false; }}, 'Etc/GMT');
  s.processICSEvent({_sourceAddress: 'b.ics', summary: 'B', hasProperty() { return false; }}, 'Etc/GMT');
  assert.deepEqual(updates, ['target-a', 'target-b']);
});

test('ICS output changes when source settings change', () => {
  const s = script({newEvent() { return {}; }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  const feed = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:one\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Meeting\nEND:VEVENT\nEND:VCALENDAR';
  const event = new s.ICAL.Component(s.ICAL.parse(feed)).getAllSubcomponents('vevent')[0];
  event._sourceAddress = 'feed.ics';
  event._sourceSettings = {addAlerts: 'yes', defaultAllDayReminder: 30};
  const first = s.createICSEvent(event, 'Etc/GMT').extendedProperties.private.MD5;
  event._sourceSettings = {addAlerts: 'yes', defaultAllDayReminder: -1};
  const second = s.createICSEvent(event, 'Etc/GMT').extendedProperties.private.MD5;
  assert.notEqual(first, second);
});

test('exhausted ICS insert retries mark sync failed without a false email entry', () => {
  const s = script({Events: {insert() { return null; }}});
  s.targetCalendarId = 'target';
  s.emailSummary = true;
  s.createICSEvent = () => ({extendedProperties: {private: {id: 'new', MD5: 'new'}}});
  s.processICSEvent({hasProperty() { return false; }}, 'Etc/GMT');
  assert.equal(s.reportOverallFailure, true);
  assert.equal(s.addedEvents.length, 0);
});

test('iCal HTTP 429 is retried without logging the private URL', () => {
  const privateUrl = 'https://calendar.google.com/calendar/ical/private-token/basic.ics';
  const logs = [];
  let calls = 0;
  const s = script({}, {logs, realBackoff: true});
  s.UrlFetchApp = {fetch() {
    calls++;
    return calls === 1 ? {getResponseCode() { return 429; }} :
      {getResponseCode() { return 200; }, getContentText() {
        return 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';
      }};
  }};
  const responses = s.fetchSourceCalendars([{source: privateUrl}]);
  assert.equal(calls, 2);
  assert.equal(responses.length, 1);
  assert.equal(responses.failed, undefined);
  assert.equal(logs.join('\n').includes(privateUrl), false);
});

test('an empty ICS source blocks target cleanup while another source still syncs', () => {
  const fullFeed = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:keep\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Keep\nEND:VEVENT\nEND:VCALENDAR';
  const emptyFeed = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';
  const s = script({Events: {list() { return {items: []}; }}, Settings: {get() { return {value: 'Etc/GMT'}; }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  s.LockService = {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }};
  s.sourceCalendars = [
    {source: 'https://example.com/empty.ics', target: 'Target'},
    {source: 'https://example.com/full.ics', target: 'Target'},
  ];
  s.UrlFetchApp = {fetch(url) { return {getResponseCode() { return 200; },
    getContentText() { return url.includes('empty') ? emptyFeed : fullFeed; }}; }};
  s.setupTargetCalendar = () => ({id: 'target'});
  const processed = [];
  let cleaned = false;
  s.processICSEvent = event => { processed.push(event.getFirstPropertyValue('uid')); };
  s.processEventCleanup = () => { cleaned = true; };

  assert.throws(() => s.startSync(), /sync operation produced errors/);
  assert.deepEqual(processed, ['keep']);
  assert.equal(cleaned, false);
});

test('an intentionally empty source can permit cleanup', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  const responses = [{kind: 'ics', source: 'empty.ics', settings: {skipIfEmptyFeed: false},
    content: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR'}];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, undefined);
});

test('filtering every event does not classify a populated feed as empty', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  s.filters = [{parameter: 'summary', type: 'exclude', comparison: 'equals', criterias: ['Meeting']}];
  const responses = [{kind: 'ics', source: 'feed.ics', settings: {}, content:
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:one\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Meeting\nEND:VEVENT\nEND:VCALENDAR'}];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, undefined);
});

test('a feed containing only cancelled events cannot clear the target by default', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  const responses = [{kind: 'ics', source: 'feed.ics', settings: {}, content:
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:cancelled\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR'}];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
});

test('an empty Google Calendar source marks the target unsafe for cleanup', () => {
  const s = script({Events: {list() { return {items: []}; }}});
  s.targetCalendarId = 'target';
  const responses = [{kind: 'google', source: 'source-id', settings: {},
    calendar: {id: 'source-id', summary: 'Source'}}];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
  assert.equal(s.reportOverallFailure, true);
});

test('startSync processes each configured target calendar', () => {
  const s = script({Events: {list() { return {items: []}; }},
    Settings: {get() { return {value: 'Etc/GMT'}; }}});
  s.LockService = {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }};
  s.sourceCalendars = [
    {source: 'one.ics', target: 'First'},
    {source: 'two.ics', target: 'Second'},
  ];
  s.fetchSourceCalendars = () => [];
  s.setupTargetCalendar = name => ({id: name});
  s.parseResponses = () => [];
  const processed = [];
  s.processEventCleanup = () => { processed.push(s.targetCalendarName); };

  s.startSync();
  assert.deepEqual(processed, ['First', 'Second']);
});

test('calendar groups use named fields and retain per-source settings', () => {
  const s = script({});
  const groups = s.condenseCalendarMap([
    {source: 'a.ics', target: 'Target', colour: '11', addAlerts: 'no'},
    ['b.ics', 'Target'],
    ['c.ics', 'Other', '9'],
    {source: 'd.ics', target: 'Target'},
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].target, 'Target');
  assert.deepEqual(Array.from(groups[0].sources, source => ({...source})), [
    {source: 'a.ics', colour: '11', addAlerts: 'no'},
    {source: 'b.ics', colour: undefined},
    {source: 'd.ics'},
  ]);
  assert.equal(groups[1].target, 'Other');
  assert.deepEqual({...groups[1].sources[0]}, {source: 'c.ics', colour: '9'});
});

test('default colour applies to ICS and native events, with source colour taking precedence', () => {
  const s = script({});
  s.defaultColor = 'RED';
  assert.equal(s.configuredEventColor(undefined), '11');
  assert.equal(s.configuredEventColor('9'), '9');

  const nativeEvent = {id: 'event-1', summary: 'Event', colorId: '9',
    start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  const source = {calendar: {id: 'source-id', summary: 'Source'}};
  assert.equal(s.makeNativeEvent(nativeEvent, source).colorId, '11');
  assert.equal(s.makeNativeEvent(nativeEvent, {...source, colorId: '9'}).colorId, '9');

  const properties = {};
  const icsEvent = {updatePropertyWithValue(name, value) { properties[name] = value; },
    hasProperty(name) { return name === 'uid'; }, getFirstPropertyValue() { return 'uid-1'; }};
  s.ICAL = {parse() { return {}; }, Component: function() { return {
    getAllSubcomponents(name) { return name === 'vevent' ? [icsEvent] : []; },
    getFirstPropertyValue() { return null; },
  }; }, helpers: {updateTimezones() {}}, TimezoneService: {register() {}}};
  s.filterICSEvents = events => events;
  s.parseResponses([{kind: 'ics', content: 'calendar', colorId: undefined}]);
  assert.equal(properties.color, '11');
  s.parseResponses([{kind: 'ics', content: 'calendar', colorId: '9'}]);
  assert.equal(properties.color, '9');

  s.defaultColor = true;
  assert.equal(s.configuredEventColor(undefined), undefined);
  assert.equal(s.makeNativeEvent(nativeEvent, source).colorId, '9');
});

test('native source settings override global event settings without affecting another source', () => {
  const s = script({});
  s.addAttendees = true;
  s.addCalToTitle = false;
  s.addAlerts = 'yes';
  s.overrideVisibility = '';
  s.defaultColor = 'RED';
  const event = {id: 'event-1', summary: 'Meeting', attendees: [{email: 'person@example.com'}],
    start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  const calendar = {id: 'source-id', summary: 'Source'};
  const overridden = s.makeNativeEvent(event, {calendar, settings: {
    addAttendees: false, addCalToTitle: true, addAlerts: 'no',
    overrideVisibility: 'private', defaultColor: 'BLUE',
  }});
  assert.equal(overridden.summary, '(Source) Meeting');
  assert.equal(overridden.attendees, undefined);
  assert.equal(overridden.colorId, '9');
  assert.equal(overridden.visibility, 'private');
  assert.equal(overridden.extendedProperties.private.sourceHash, s.sourceAddressHash('source-id'));
  assert.equal(overridden.reminders.useDefault, false);
  assert.equal(overridden.reminders.overrides.length, 0);
  const unchanged = s.makeNativeEvent(event, {calendar});
  assert.equal(unchanged.summary, 'Meeting');
  assert.equal(unchanged.attendees.length, 1);
  assert.equal(unchanged.colorId, '11');
});

test('native all-day and fallback reminders follow ICS setting precedence', () => {
  const s = script({});
  const source = {calendar: {id: 'source-id', summary: 'Source'}, settings: {
    addAlerts: 'yes', defaultAllDayReminder: 30, fallbackReminderMinutes: 15,
  }};
  const allDay = {id: 'day', start: {date: '2026-10-24'}, end: {date: '2026-10-25'}};
  const timed = {id: 'timed', start: {dateTime: '2026-10-24T09:00:00Z'},
    end: {dateTime: '2026-10-24T10:00:00Z'}};
  assert.equal(s.makeNativeEvent(allDay, source).reminders.overrides[0].minutes, 30);
  assert.equal(s.makeNativeEvent(timed, source).reminders.overrides[0].minutes, 15);
  const withAlarm = {...allDay, reminders: {useDefault: false,
    overrides: [{method: 'popup', minutes: 5}]}};
  assert.equal(s.makeNativeEvent(withAlarm, source).reminders.overrides[0].minutes, 5);
  source.settings.addAlerts = 'default';
  assert.equal(s.makeNativeEvent(allDay, source).reminders.overrides[0].minutes, 30);
  assert.equal(s.makeNativeEvent(timed, source).reminders.useDefault, true);
  source.settings.addAlerts = 'no';
  assert.equal(s.makeNativeEvent(allDay, source).reminders.overrides.length, 0);
});

test('native date filtering uses the current instant for events and recurrence queries', () => {
  let query;
  const s = script({Events: {instances(_calendarId, _eventId, options) {
    query = options;
    return {items: []};
  }}});
  const reference = {toJSDate() { return new Date('2026-10-23T15:00:00Z'); }};
  const filter = {parameter: 'dtstart', comparison: '>'};
  assert.equal(s.nativeDateMatches({start: {dateTime: '2026-10-23T09:00:00Z'}}, filter, reference), false);
  assert.equal(s.nativeDateMatches({start: {dateTime: '2026-10-23T16:00:00Z'}}, filter, reference), true);
  s.nativeRecurrenceMatches({id: 'series'}, filter, reference, 'source-id');
  assert.equal(query.timeMin, '2026-10-23T15:00:00.000Z');
});

test('ICS source settings reach event creation', () => {
  const s = script({newEvent() { return {}; }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nX-WR-CALNAME:Feed\nBEGIN:VEVENT\nUID:one\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Meeting\nDESCRIPTION:Details\nATTENDEE:mailto:person@example.com\nEND:VEVENT\nEND:VCALENDAR`;
  const settings = {source: 'feed.ics', descriptionAsTitles: true, addCalToTitle: true,
    addAttendees: true, defaultAllDayReminder: 30, addAlerts: 'yes', overrideVisibility: 'private'};
  const parsed = s.parseResponses([{kind: 'ics', content: feed, source: 'feed.ics', settings}]);
  assert.equal(parsed[0]._sourceSettings, settings);
  const event = s.createICSEvent(parsed[0], 'Etc/UTC');
  assert.equal(event.summary, '(Feed) Details');
  assert.equal(event.visibility, 'private');
  assert.equal(event.attendees[0].email, 'person@example.com');
  assert.equal(event.reminders.overrides[0].minutes, 30);
  assert.equal(event.extendedProperties.private.sourceHash, s.sourceAddressHash('feed.ics'));
});

test('Google Calendar lookup follows pagination and parse keeps stable source IDs', () => {
  const calendar = {CalendarList: {list(options) {
    return options.pageToken ? {items: [{id: 'source-id', summary: 'Source'}]} :
      {items: [{id: 'other', summary: 'Other'}], nextPageToken: 'next'};
  }}, Events: {list() { return {items: [
    {id: 'event-1', summary: 'Keep', start: {date: '2026-10-22'}, end: {date: '2026-10-23'}},
    {id: 'event-2', summary: 'Declined', attendees: [{self: true, responseStatus: 'declined'}]},
    {id: 'event-3', status: 'cancelled'},
  ]}; }}};
  const s = script(calendar);
  s.targetCalendarId = 'target-id';
  const responses = s.fetchSourceCalendars([{source: 'Source'}]);
  const events = s.parseResponses(responses);
  assert.equal(events.length, 1);
  assert.equal(responses[0].settings.source, 'Source');
  assert.equal(events[0].nativeEvent.id, 'event-1');
  assert.deepEqual(Array.from(s.icsEventsIds), ['gcal:source-id:event-1']);
});

test('email summary reads named calendar groups', () => {
  const s = script({});
  let message;
  s.MailApp = {sendEmail(value) { message = value; }};
  s.email = 'user@example.com';
  s.addedEvents = [[['Meeting', '2026-10-22', '2026-10-23'], 'Target']];
  s.sendSummary();
  assert.match(message.htmlBody, /Target: 1 added events/);
  assert.match(message.htmlBody, /Name: Meeting/);
});

test('failed native source is marked so target cleanup can be skipped', () => {
  const s = script({CalendarList: {list() { return {items: [{id: 'source-id', summary: 'Source'}]}; }},
    Events: {list() { throw Error('unavailable'); }}});
  s.targetCalendarId = 'target-id';
  const responses = s.fetchSourceCalendars([{source: 'Source'}]);
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
});

test('native event uses a stable source key and skips an unchanged target event', () => {
  let writes = 0;
  const s = script({Events: {insert() { writes++; }, update() { writes++; }}});
  s.targetCalendarId = 'target-id';
  const source = {calendar: {id: 'source-id', summary: 'Source'}};
  const nativeEvent = {id: 'event-1', summary: 'Event', start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  const copy = s.makeNativeEvent(nativeEvent, source);
  s.calendarEventsIds = [copy.extendedProperties.private.id];
  s.calendarEvents = [{extendedProperties: {private: {MD5: copy.extendedProperties.private.MD5}}}];
  s.processNativeEvent({nativeEvent, source});
  assert.equal(writes, 0);
  assert.equal(copy.extendedProperties.private.id, 'gcal:source-id:event-1');
});

test('source add and modify flags override global save flags', () => {
  let inserts = 0;
  let updates = 0;
  const s = script({Events: {
    insert(event) { inserts++; return event; },
    update(event) { updates++; return event; },
  }});
  s.addEventsToCalendar = false;
  s.modifyExistingEvents = false;
  const source = {calendar: {id: 'source-id', summary: 'Source'},
    settings: {addEventsToCalendar: true, modifyExistingEvents: true}};
  const event = {id: 'event-1', summary: 'Meeting',
    start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  s.processNativeEvent({nativeEvent: event, source});
  assert.equal(inserts, 1);
  const copy = s.makeNativeEvent(event, source);
  s.calendarEventsIds = [copy.extendedProperties.private.id];
  s.calendarEvents = [{id: 'target-event', extendedProperties: {private: {MD5: 'old'}}}];
  s.processNativeEvent({nativeEvent: event, source});
  assert.equal(updates, 1);
  source.settings = {addEventsToCalendar: false, modifyExistingEvents: false};
  s.processNativeEvent({nativeEvent: event, source});
  assert.equal(updates, 1);
  assert.equal(s.reportOverallFailure, false);
});

test('recurrence exception patches its original instance, never the next instance', () => {
  let patched;
  const calendar = {Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: {private: {id: 'source-uid', fromGAS: 'true'}}}]}; },
    instances() { return {items: [{id: 'wrong', originalStartTime: {date: '2026-10-23'}},
      {id: 'right', originalStartTime: {date: '2026-10-22'}}]}; },
    patch(body, _calendarId, id) { patched = {body, id}; return {id}; },
  }};
  const s = script(calendar);
  s.targetCalendarId = 'target-id';
  const exception = {recurringEventId: '2026-10-22', extendedProperties: {private: {id: 'source-uid', MD5: 'new'}}};
  s.processICSEventInstance(exception);
  assert.equal(patched.id, 'right');
  assert.equal(patched.body.recurringEventId, undefined);
});

test('ICS recurrence exception chooses its own source parent when UIDs overlap', () => {
  let selectedParent;
  const s = script({Events: {
    list() { return {items: [
      {id: 'parent-a', recurrence: ['RRULE:FREQ=DAILY'], extendedProperties: {private:
        {id: 'shared', fromGAS: 'true', sourceHash: s.sourceAddressHash('a.ics')}}},
      {id: 'parent-b', recurrence: ['RRULE:FREQ=DAILY'], extendedProperties: {private:
        {id: 'shared', fromGAS: 'true', sourceHash: s.sourceAddressHash('b.ics')}}},
    ]}; },
    instances(_calendar, parent) { selectedParent = parent; return {items: [
      {id: 'instance', originalStartTime: {date: '2026-10-22'}},
    ]}; },
    patch() { return {}; },
  }});
  s.targetCalendarId = 'target';
  s.processICSEventInstance({recurringEventId: '2026-10-22', extendedProperties: {private:
    {id: 'shared', sourceHash: s.sourceAddressHash('b.ics'), MD5: 'new'}}});
  assert.equal(selectedParent, 'parent-b');
  assert.equal(s.reportOverallFailure, false);
});

test('native cancelled recurrence exception removes only the matching instance', () => {
  let removed;
  const s = script({Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: {private: {id: 'gcal:source-id:series'}}}]}; },
    instances() { return {items: [{id: 'wrong', originalStartTime: {date: '2026-10-23'}},
      {id: 'right', originalStartTime: {date: '2026-10-22'}}]}; },
    remove(_calendarId, id) { removed = id; return {}; },
  }});
  s.targetCalendarId = 'target-id';
  s.nativeExceptions = [{source: {calendar: {id: 'source-id'}}, nativeEvent: {
    id: 'cancelled', recurringEventId: 'series', originalStartTime: {date: '2026-10-22'}, status: 'cancelled',
  }}];
  s.processNativeExceptions();
  assert.equal(removed, 'right');
});

test('attendee and all-day filters apply to the selected Google Calendar source', () => {
  const s = script({});
  s.filters = [
    {source: 'source-id', parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['PERSON@example.com']},
    {parameter: 'allDay', type: 'exclude'},
  ];
  const events = [
    {id: 'attendee', start: {dateTime: '2026-10-23T10:00:00Z'}, attendees: [{email: 'person@EXAMPLE.com'}]},
    {id: 'all-day', start: {date: '2026-10-23'}},
    {id: 'keep', start: {dateTime: '2026-10-23T10:00:00Z'}},
  ];
  assert.deepEqual(Array.from(s.filterNativeEvents(events, 'source-id', 'source-id'), e => e.id), ['keep']);
  assert.deepEqual(Array.from(s.filterNativeEvents(events.slice(0, 1), 'other-id', 'other-id'), e => e.id), ['attendee']);
});

test('date filter retains a Google recurrence with future instances and drops past events', () => {
  let instanceQueries = 0;
  const s = script({Events: {instances() {
    instanceQueries++;
    return {items: [{start: {date: '2026-10-24'}, end: {date: '2026-10-25'}}]};
  }}});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toJSDate() { return new Date('2026-10-23T00:00:00Z'); }}; }}};
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  const events = [
    {id: 'past', start: {date: '2026-10-20'}, end: {date: '2026-10-21'}},
    {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {date: '2026-10-20'}, end: {date: '2026-10-21'}},
    {id: 'future', start: {date: '2026-10-24'}, end: {date: '2026-10-25'}},
  ];
  assert.deepEqual(Array.from(s.filterNativeEvents(events, 'source-id', 'source-id'), e => e.id), ['series', 'future']);
  assert.equal(instanceQueries, 1);
});

test('future filter copies Google recurrence instances as stable individual events', () => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const date = days => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const originalStart = date(2) + 'T09:00:00Z';
  const movedStart = date(3) + 'T11:00:00Z';
  const inserted = [];
  const updated = [];
  const s = script({Events: {
    list() { return {items: [
      {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {dateTime: date(-5) + 'T09:00:00Z'},
        end: {dateTime: date(-5) + 'T10:00:00Z'}},
      {id: 'override', recurringEventId: 'series', originalStartTime: {dateTime: originalStart},
        start: {dateTime: movedStart}, end: {dateTime: date(3) + 'T12:00:00Z'}},
    ]}; },
    instances() { return {items: [
      {id: 'instance', recurringEventId: 'series', originalStartTime: {dateTime: originalStart},
        start: {dateTime: movedStart}, end: {dateTime: date(3) + 'T12:00:00Z'}},
      {id: 'cancelled', recurringEventId: 'series', originalStartTime: {dateTime: date(4) + 'T09:00:00Z'}, status: 'cancelled'},
    ]}; },
    insert(body) { inserted.push(body); return Object.assign({id: 'target-instance'}, body); },
    update(body, _calendarId, id) { updated.push({body, id}); return Object.assign({id}, body); },
  }});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toJSDate() { return new Date(date(0) + 'T00:00:00Z'); }}; }}};
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  s.targetCalendarId = 'target-id';
  const source = {kind: 'google', calendar: {id: 'source-id', summary: 'Source'}, source: 'source-id'};
  const items = s.parseResponses([source]);
  assert.equal(items.length, 1);
  assert.equal(items[0].materialized, true);
  assert.equal(items[0].sourceKey, 'gcal-instance:source-id:series:' + originalStart);
  assert.deepEqual(Array.from(s.icsEventsIds), [items[0].sourceKey]);
  s.processNativeEvent(items[0]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].recurrence, undefined);
  assert.equal(inserted[0].extendedProperties.private.id, items[0].sourceKey);
  assert.equal(s.nativeExceptions.length, 0);
  const shifted = Object.assign({}, items[0].nativeEvent, {start: {dateTime: date(5) + 'T11:00:00Z'}});
  assert.equal(s.makeNativeEvent(shifted, source, items[0].sourceKey, true).extendedProperties.private.id,
    inserted[0].extendedProperties.private.id);
  s.calendarEventsIds = [items[0].sourceKey];
  s.calendarEvents = [Object.assign({id: 'target-instance'}, inserted[0])];
  s.processNativeEvent(Object.assign({}, items[0], {nativeEvent: shifted}));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'target-instance');
});

test('materialized instances inherit attendee details and failed expansion blocks cleanup', () => {
  const s = script({Events: {
    list() { return {items: [{id: 'series', recurrence: ['RRULE:FREQ=DAILY'],
      attendees: [{email: 'skip@example.com'}]}]}; },
    instances() { return {items: [{id: 'instance', recurringEventId: 'series',
      originalStartTime: {date: '2026-10-24'}, start: {date: '2026-10-24'}, end: {date: '2026-10-25'}}]}; },
  }});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toJSDate() { return new Date('2026-10-23T00:00:00Z'); }}; }}};
  s.filters = [
    {parameter: 'dtend', type: 'include', comparison: '>', offset: 0},
    {parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['skip@example.com']},
  ];
  s.targetCalendarId = 'target-id';
  const source = {kind: 'google', calendar: {id: 'source-id', summary: 'Source'}, source: 'source-id'};
  assert.equal(s.parseResponses([source]).length, 0);

  s.Calendar.Events.instances = () => { throw Error('unavailable'); };
  const responses = [source];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
});

test('cleanup removes a previous copied series and occurrences outside the rolling window', () => {
  const removed = [];
  const s = script({Events: {remove(_calendarId, id) { removed.push(id); }}});
  s.targetCalendarId = 'target-id';
  s.icsEventsIds = ['gcal-instance:source-id:series:2026-10-24T09:00:00Z'];
  s.calendarEventsIds = [
    'gcal:source-id:series',
    'gcal-instance:source-id:series:2026-10-20T09:00:00Z',
    'gcal-instance:source-id:series:2026-10-24T09:00:00Z',
  ];
  const sourceHash = s.sourceAddressHash('source-id');
  s.calendarEvents = s.calendarEventsIds.map((id, i) => ({
    id: 'target-' + i, start: {dateTime: '2026-10-20T09:00:00Z'},
    extendedProperties: {private: {sourceHash}},
  }));
  s.processEventCleanup([{source: 'source-id'}]);
  assert.deepEqual(removed, ['target-0', 'target-1']);
});

test('cleanup honors removal settings for each hashed source and preserves unknown legacy events', () => {
  const removed = [];
  const s = script({Events: {remove(_calendarId, id) { removed.push(id); return {}; }}});
  s.targetCalendarId = 'target-id';
  const sourceA = 'https://example.com/a.ics';
  const sourceB = 'https://example.com/b.ics';
  s.calendarEventsIds = ['a-future', 'a-past', 'b-future', 'legacy'];
  s.calendarEvents = [
    {id: 'a-future', start: {date: '2099-01-01'}, extendedProperties: {private: {sourceHash: s.sourceAddressHash(sourceA)}}},
    {id: 'a-past', start: {date: '2020-01-01'}, extendedProperties: {private: {sourceHash: s.sourceAddressHash(sourceA)}}},
    {id: 'b-future', start: {date: '2099-01-01'}, extendedProperties: {private: {sourceHash: s.sourceAddressHash(sourceB)}}},
    {id: 'legacy', start: {date: '2099-01-01'}, extendedProperties: {private: {id: 'legacy'}}},
  ];
  s.processEventCleanup([
    {source: sourceA, removeEventsFromCalendar: true, removePastEventsFromCalendar: false},
    {source: sourceB, removeEventsFromCalendar: false},
  ]);
  assert.deepEqual(removed, ['a-future']);
});

test('cleanup reports an exhausted delete retry and continues without a false summary entry', () => {
  const removed = [];
  const s = script({Events: {remove(_calendar, id) { removed.push(id); }}});
  s.targetCalendarId = 'target';
  s.emailSummary = true;
  s.calendarEventsIds = ['failed', 'ok'];
  const sourceHash = s.sourceAddressHash('feed.ics');
  s.calendarEvents = s.calendarEventsIds.map(id => ({id, summary: id,
    start: {date: '2099-01-01'}, end: {date: '2099-01-02'},
    extendedProperties: {private: {sourceHash}}}));
  let calls = 0;
  s.callWithBackoff = fn => ++calls === 1 ? null : fn();

  s.processEventCleanup([{source: 'feed.ics'}]);
  assert.deepEqual(removed, ['ok']);
  assert.equal(s.reportOverallFailure, true);
  assert.equal(s.removedEvents.length, 1);
  assert.equal(s.removedEvents[0][0][0], 'ok');
});

test('cleanup tolerates an already-deleted event without reporting a new failure', () => {
  const removed = [];
  const s = script({Events: {remove(_calendar, id) {
    if (id === 'gone') throw Error('Resource has been deleted');
    removed.push(id);
  }}});
  s.targetCalendarId = 'target';
  s.emailSummary = true;
  s.calendarEventsIds = ['gone', 'ok'];
  const sourceHash = s.sourceAddressHash('feed.ics');
  s.calendarEvents = s.calendarEventsIds.map(id => ({id,
    summary: id, start: {date: '2099-01-01'}, end: {date: '2099-01-02'},
    extendedProperties: {private: {sourceHash}}}));

  s.processEventCleanup([{source: 'feed.ics'}]);
  assert.deepEqual(removed, ['ok']);
  assert.equal(s.removedEvents.length, 1);
  assert.equal(s.reportOverallFailure, false);
});

test('cleanup skips a missing target ID and reports it', () => {
  let removeCalled = false;
  const s = script({Events: {remove() { removeCalled = true; }}});
  s.targetCalendarId = 'target';
  s.calendarEventsIds = ['source-id'];
  s.calendarEvents = [{start: {date: '2099-01-01'}, end: {date: '2099-01-02'},
    extendedProperties: {private: {sourceHash: s.sourceAddressHash('feed.ics')}}}];
  s.processEventCleanup([{source: 'feed.ics'}]);
  assert.equal(removeCalled, false);
  assert.equal(s.reportOverallFailure, true);
});

test('cleanup deletion batches resume across runs', () => {
  const removed = [];
  const s = script({Events: {remove(_calendar, id) { removed.push(id); }}});
  s.targetCalendarId = 'target';
  s.maxCleanupDeletesPerRun = 2;
  const sourceHash = s.sourceAddressHash('feed.ics');
  const events = Array.from({length: 5}, (_, index) => ({id: 'target-' + index,
    start: {date: '2099-01-01'}, end: {date: '2099-01-02'},
    extendedProperties: {private: {id: 'source-' + index, sourceHash}}}));
  for (let run = 0; run < 3; run++) {
    s.calendarEvents = events.filter(event => !removed.includes(event.id));
    s.calendarEventsIds = s.calendarEvents.map(event => event.extendedProperties.private.id);
    const before = removed.length;
    s.processEventCleanup([{source: 'feed.ics'}]);
    assert.ok(removed.length - before <= 2);
  }
  assert.deepEqual(removed.slice().sort(), events.map(event => event.id).sort());
});

test('past window omits old ICS and Google events but retains recurring parents', () => {
  const s = script({Events: {list() { return {items: [
    {id: 'old', start: {date: daysFromNow(-101)}, end: {date: daysFromNow(-100)}},
    {id: 'recent', start: {date: daysFromNow(-2)}, end: {date: daysFromNow(-1)}},
    {id: 'series', start: {date: daysFromNow(-101)}, end: {date: daysFromNow(-100)},
      recurrence: ['RRULE:FREQ=DAILY']},
  ]}; }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s);
  function daysFromNow(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
  function icsDate(days) { return daysFromNow(days).replace(/-/g, ''); }
  const feed = 'BEGIN:VCALENDAR\nVERSION:2.0\n' +
    ['old', 'recent', 'series'].map((uid, index) => {
      const start = index === 1 ? -2 : -101;
      return 'BEGIN:VEVENT\nUID:' + uid + '\nDTSTART;VALUE=DATE:' + icsDate(start) +
        '\nDTEND;VALUE=DATE:' + icsDate(start + 1) + '\nSUMMARY:' + uid +
        (uid === 'series' ? '\nRRULE:FREQ=DAILY' : '') + '\nEND:VEVENT\n';
    }).join('') + 'END:VCALENDAR';
  const settings = {pastEventWindowDays: 30};
  const ics = s.parseResponses([{kind: 'ics', source: 'feed.ics', settings, content: feed}]);
  assert.deepEqual(Array.from(ics, event => event.getFirstPropertyValue('uid')).sort(), ['recent', 'series']);
  s.targetCalendarId = 'target';
  s.icsEventsIds = [];
  const native = s.parseResponses([{kind: 'google', source: 'source-id', settings,
    calendar: {id: 'source-id', summary: 'Source'}}]);
  assert.deepEqual(Array.from(native, item => item.nativeEvent.id).sort(), ['recent', 'series']);
});

test('past window protects old target events while deleting recent obsolete ones', () => {
  const removed = [];
  const s = script({Events: {remove(_calendar, id) { removed.push(id); }}});
  s.targetCalendarId = 'target';
  s.calendarEventsIds = ['old', 'recent'];
  const sourceHash = s.sourceAddressHash('feed.ics');
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  s.calendarEvents = [
    {id: 'old', start: {date: day(-101)}, end: {date: day(-100)}, extendedProperties: {private: {sourceHash}}},
    {id: 'recent', start: {date: day(-2)}, end: {date: day(-1)}, extendedProperties: {private: {sourceHash}}},
  ];
  s.processEventCleanup([{source: 'feed.ics', pastEventWindowDays: 30}]);
  assert.deepEqual(removed, ['recent']);
});

test('cleanup backfills the source hash only for an unambiguous live legacy event', () => {
  const patches = [];
  const s = script({Events: {patch(body, _calendarId, id) { patches.push({body, id}); return {id}; }}});
  s.targetCalendarId = 'target-id';
  s.calendarEventsIds = ['current', 'missing', 'ambiguous'];
  s.icsEventsIds = ['current', 'ambiguous'];
  s.calendarEvents = s.calendarEventsIds.map(id => ({id, extendedProperties: {
    private: {id, fromGAS: 'true', MD5: 'digest'},
  }}));
  s.icsEventSourceHashes = {current: [s.sourceAddressHash('feed.ics')],
    ambiguous: [s.sourceAddressHash('first.ics'), s.sourceAddressHash('second.ics')]};
  s.processEventCleanup([{source: 'feed.ics'}]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'current');
  assert.equal(patches[0].body.extendedProperties.private.id, 'current');
  assert.equal(patches[0].body.extendedProperties.private.MD5, 'digest');
  assert.equal(patches[0].body.extendedProperties.private.sourceHash, s.sourceAddressHash('feed.ics'));
});

test('one ICS feed cannot keep an obsolete event from another feed with the same UID', () => {
  const removed = [];
  const s = script({Events: {remove(_calendarId, id) { removed.push(id); return {}; }}});
  const sourceA = 'https://example.com/a.ics';
  const sourceB = 'https://example.com/b.ics';
  s.targetCalendarId = 'target-id';
  s.calendarEventsIds = ['shared', 'shared'];
  s.calendarEvents = [
    {id: 'from-a', start: {date: '2099-01-01'}, extendedProperties: {private: {sourceHash: s.sourceAddressHash(sourceA)}}},
    {id: 'from-b', start: {date: '2099-01-01'}, extendedProperties: {private: {sourceHash: s.sourceAddressHash(sourceB)}}},
  ];
  s.icsEventsIds = ['shared'];
  s.registerSourceEvent('shared', sourceB);
  s.processEventCleanup([{source: sourceA}, {source: sourceB}]);
  assert.deepEqual(removed, ['from-a']);
});

test('excluding a Google recurrence override suppresses its generated instance', () => {
  const s = script({});
  s.filters = [{parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['skip@example.com']}];
  const events = [
    {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {dateTime: '2026-10-23T09:00:00Z'}},
    {id: 'override', recurringEventId: 'series', originalStartTime: {dateTime: '2026-10-24T09:00:00Z'},
      attendees: [{email: 'skip@example.com'}]},
  ];
  const filtered = s.filterNativeEvents(events, 'source-id', 'source-id');
  assert.deepEqual(Array.from(filtered, e => [e.id, e.status || 'confirmed']), [
    ['series', 'confirmed'], ['override', 'cancelled'],
  ]);
});

test('ICS attendee exclusion suppresses the matching recurrence exception', () => {
  const s = script({});
  s.filters = [{parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['person@example.com']}];
  const exdates = [];
  const uid = 'series-uid';
  const parent = {
    hasProperty(name) { return name === 'uid'; },
    getFirstPropertyValue() { return uid; },
    getAllProperties() { return []; },
    addPropertyWithValue(name, value) { exdates.push([name, value]); },
  };
  const exception = {
    hasProperty(name) { return name === 'recurrence-id'; },
    getFirstPropertyValue(name) { return name === 'uid' ? uid : '2026-10-23'; },
    getAllProperties(name) { return name === 'attendee' ? [{getFirstValue() { return 'MAILTO:PERSON@example.com'; }}] : []; },
  };
  assert.deepEqual(Array.from(s.filterICSEvents([parent, exception], 'feed.ics')), [parent]);
  assert.deepEqual(exdates, [['exdate', '2026-10-23']]);
});

test('bundled ICS parser applies attendee and all-day filters', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [
    {parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['person@example.com']},
    {parameter: 'allDay', type: 'exclude'},
  ];
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:attendee\nDTSTART:20261024T100000Z\nDTEND:20261024T110000Z\nATTENDEE:mailto:PERSON@example.com\nEND:VEVENT\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nEND:VEVENT\nBEGIN:VEVENT\nUID:keep\nDTSTART:20261024T120000Z\nDTEND:20261024T130000Z\nEND:VEVENT\nEND:VCALENDAR`;
  const component = new s.ICAL.Component(s.ICAL.parse(feed));
  const remaining = s.filterICSEvents(component.getAllSubcomponents('vevent'), 'feed.ics');
  assert.deepEqual(Array.from(remaining, event => event.getFirstPropertyValue('uid')), ['keep']);
});

test('future-filtered ICS series copies stable individual instances with overrides and cancellations', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{source: 'feed.ics', parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const stamp = (offset, hour = 10) => {
    const date = new Date(day.getTime() + offset * 86400000);
    date.setUTCHours(hour);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  };
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:series\nDTSTART:${stamp(-1)}\nDTEND:${stamp(-1, 11)}\nRRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Original\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(1)}\nDTSTART:${stamp(1, 12)}\nDTEND:${stamp(1, 13)}\nSUMMARY:Moved\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(2)}\nDTSTART:${stamp(2)}\nDTEND:${stamp(2, 11)}\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR`;
  const todayOccurrenceIsFuture = day.getTime() + 10 * 3600000 > Date.now();
  const parsed = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.equal(parsed.length, todayOccurrenceIsFuture ? 3 : 2);
  assert.ok(parsed.every(event => !event.hasProperty('rrule') && !event.hasProperty('recurrence-id')));
  assert.deepEqual(Array.from(parsed, event => event.getFirstPropertyValue('summary')).sort(),
    todayOccurrenceIsFuture ? ['Moved', 'Original', 'Original'] : ['Moved', 'Original']);
  assert.equal(parsed.find(event => event.getFirstPropertyValue('summary') === 'Moved').getFirstPropertyValue('dtstart').hour, 12);
  assert.match(parsed.find(event => event.getFirstPropertyValue('summary') === 'Moved').toString(), /DTSTART:.*Z/);
  assert.ok(s.icsEventsIds.every(id => id.startsWith('ics-instance:')));
  assert.equal(new Set(s.icsEventsIds).size, parsed.length);
  const again = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.deepEqual(Array.from(again, event => event.getFirstPropertyValue('uid')), Array.from(parsed, event => event.getFirstPropertyValue('uid')));
});

test('ICS override moved into the window from a later original date keeps its original identity', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.recurringInstanceWindowDays = 180;
  s.filters = [{parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const stamp = offset => new Date(day.getTime() + offset * 86400000 + 10 * 3600000)
    .toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:series\nDTSTART:${stamp(1)}\nDTEND:${stamp(1).replace('T100000Z', 'T110000Z')}\nRRULE:FREQ=DAILY;COUNT=10\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(6)}\nDTSTART:${stamp(2)}\nDTEND:${stamp(2).replace('T100000Z', 'T110000Z')}\nSUMMARY:Moved in\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed,
    settings: {recurringInstanceWindowDays: 3}}]);
  const moved = events.find(event => event.getFirstPropertyValue('summary') === 'Moved in');
  assert.ok(moved);
  assert.ok(moved.getFirstPropertyValue('uid').endsWith(':' + new Date(day.getTime() + 6 * 86400000 + 10 * 3600000).toISOString().replace('.000Z', 'Z')));
});

test('materialized ICS events retain all-day dates and named timezones', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10).replace(/-/g, '');
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:${date}\nDTEND;VALUE=DATE:${date}\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nBEGIN:VEVENT\nUID:zoned\nDTSTART;TZID=Europe/Paris:${date}T100000\nDTEND;TZID=Europe/Paris:${date}T110000\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.equal(events.length, 4);
  assert.ok(events.filter(event => event.getFirstPropertyValue('uid').includes('all-day'))
    .every(event => event.getFirstProperty('dtstart').getFirstValue().isDate));
  assert.ok(events.filter(event => event.getFirstPropertyValue('uid').includes('zoned'))
    .every(event => event.getFirstProperty('dtstart').getParameter('tzid') === 'Europe/Paris'));
});

test('an ICS override never changes a different series at the same recurrence time', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(10, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 1);
  const stamp = (offset, hour) => {
    const value = new Date(day.getTime() + offset * 86400000);
    value.setUTCHours(hour);
    return value.toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  };
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:first\nDTSTART:${stamp(0, 10)}\nDTEND:${stamp(0, 11)}\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:First\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nDTSTART:${stamp(0, 10)}\nDTEND:${stamp(0, 11)}\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Second\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nRECURRENCE-ID:${stamp(1, 10)}\nDTSTART:${stamp(1, 12)}\nDTEND:${stamp(1, 13)}\nSUMMARY:Moved second\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed}]);
  const first = events.filter(event => event.getFirstPropertyValue('uid').includes(':first:'));
  const second = events.filter(event => event.getFirstPropertyValue('uid').includes(':second:'));
  assert.deepEqual(Array.from(first, event => event.getFirstPropertyValue('summary')), ['First', 'First']);
  assert.deepEqual(Array.from(second, event => event.getFirstPropertyValue('summary')), ['Second', 'Moved second']);
});

test('clearGASEvents previews by default and deletes only script-created events when explicit', () => {
  const removed = [];
  const s = script({
    CalendarList: {list() { return {items: [{id: 'target-id', summary: 'targetCalendar1', accessRole: 'owner'}]}; }},
    Events: {
      list() { return {items: [
        {id: 'parent', recurrence: ['RRULE:FREQ=DAILY'], extendedProperties: {private: {fromGAS: 'true'}}},
        {id: 'owned', extendedProperties: {private: {fromGAS: 'true'}}},
        {id: 'other', extendedProperties: {private: {fromGAS: 'false'}}},
      ]}; },
      remove(_calendar, id) { removed.push(id); },
    },
  });
  assert.equal(s.clearGASEvents('targetCalendar1').count, 2);
  assert.deepEqual(removed, []);
  assert.equal(s.clearGASEvents('targetCalendar1', false).dryRun, false);
  assert.deepEqual(removed, ['owned', 'parent']);
  assert.throws(() => s.clearGASEvents('unconfigured', false));
});
