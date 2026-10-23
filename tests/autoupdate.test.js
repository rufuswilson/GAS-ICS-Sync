const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const helpers = fs.readFileSync(path.join(__dirname, '..', 'Helpers.gs'), 'utf8');
const repoApi = 'https://api.github.com/repos/rufuswilson/GAS-ICS-Sync';
const projectApi = 'https://script.googleapis.com/v1/projects/project-id/content';
const latest = {tag_name: 'v2.0', html_url: 'https://github.com/rufuswilson/GAS-ICS-Sync/releases/tag/v2.0'};
const sources = {
  'Code.gs': 'function startSync() {}',
  'Helpers.gs': 'function AutoUpdate() {}',
  'ical.js.gs': 'var ICAL = {};',
  'tzid.gs': 'var tzid = {};',
  'appsscript.json': JSON.stringify({runtimeVersion: 'V8', oauthScopes: []}),
  'Config.gs': 'var sourceCalendars = [];',
  'Filters.gs': 'var filters = [];',
};

function setup(options = {}) {
  const remoteSources = {...sources};
  const calls = [];
  const writes = [];
  const emails = [];
  const properties = new Map();
  if (options.token) properties.set('GITHUB_TOKEN', options.token);
  const currentFiles = [
    {name: 'Code', type: 'SERVER_JS', source: 'old code'},
    {name: 'Config', type: 'SERVER_JS', source: 'private config'},
    {name: 'Filters', type: 'SERVER_JS', source: 'private filters'},
    {name: 'appsscript', type: 'JSON', source: JSON.stringify({oauthScopes: ['old.scope']})},
  ];
  const response = (status, body) => ({
    getResponseCode() { return status; },
    getContentText() { return JSON.stringify(body); },
  });
  const context = vm.createContext({
    Logger: {log() {}},
    LockService: {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }},
    PropertiesService: {getScriptProperties() { return {
      getProperty(key) { return properties.get(key) || null; },
      setProperty(key, value) { properties.set(key, value); },
    }; }},
    ScriptApp: {getScriptId() { return 'project-id'; }, getOAuthToken() { return 'token'; }},
    MailApp: {sendEmail(...args) { emails.push(args); }},
    Utilities: {
      base64Decode(value) { return [...Buffer.from(value, 'base64')]; },
      newBlob(value) { return {getDataAsString() { return Buffer.from(value).toString('utf8'); }}; },
    },
    UrlFetchApp: {fetch(url, params = {}) {
      calls.push({url, params});
      if (url === projectApi) {
        if (params.method === 'put') {
          writes.push(JSON.parse(params.payload));
          return response(200, {});
        }
        return response(200, {files: currentFiles});
      }
      if (url === repoApi + '/releases/latest') return response(200, latest);
      if (url === repoApi + '/branches/master')
        return response(200, {commit: {sha: 'a'.repeat(40)}});
      if (url.startsWith(repoApi + '/contents?ref='))
        return response(200, Object.keys(remoteSources).map(name => ({name, type: 'file'})));
      const contents = url.match(/^https:\/\/api\.github\.com\/repos\/rufuswilson\/GAS-ICS-Sync\/contents\/([^?]+)\?ref=([^&]+)$/);
      if (contents && remoteSources[decodeURIComponent(contents[1])] !== undefined)
        return response(200, {type: 'file', encoding: 'base64',
          content: Buffer.from(remoteSources[decodeURIComponent(contents[1])], 'utf8').toString('base64')});
      const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/rufuswilson\/GAS-ICS-Sync\/([^/]+)\/([^/]+)$/);
      if (raw && remoteSources[decodeURIComponent(raw[2])] !== undefined)
        return {getResponseCode() { return 200; }, getContentText() {
          return remoteSources[decodeURIComponent(raw[2])]; }};
      return response(404, {});
    }},
  });
  vm.runInContext(code, context);
  vm.runInContext(helpers, context);
  Object.assign(context, {
    autoUpdateRepository: 'rufuswilson/GAS-ICS-Sync',
    autoUpdateMode: options.mode || 'auto',
    autoUpdateChannel: options.channel || 'release',
    autoUpdateBranch: 'master',
    email: 'person@example.com',
  });
  return {context, calls, writes, emails, properties, sources: remoteSources};
}

test('installs a pinned release while preserving private configuration', () => {
  const s = setup();
  s.context.AutoUpdate();
  assert.equal(s.writes.length, 1);
  const files = s.writes[0].files;
  assert.equal(files.find(file => file.name === 'Config').source, 'private config');
  assert.equal(files.find(file => file.name === 'Filters').source, 'private filters');
  assert.equal(files.find(file => file.name === 'Helpers').source, sources['Helpers.gs']);
  const scopes = JSON.parse(files.find(file => file.name === 'appsscript').source).oauthScopes;
  assert.ok(scopes.includes('old.scope'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/script.projects'));
  assert.equal(s.calls.filter(call => call.url.startsWith(repoApi)).length, 2);
  assert.ok(s.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/'))
    .every(call => call.url.includes('/v2.0/')));
  s.context.AutoUpdate();
  assert.equal(s.writes.length, 1);
});

test('email mode sends one notice and does not write project content', () => {
  const s = setup({mode: 'email'});
  s.context.AutoUpdate();
  s.context.AutoUpdate();
  assert.equal(s.emails.length, 1);
  assert.equal(s.writes.length, 0);
  assert.ok(s.emails[0][2].includes(latest.html_url));
});

test('configured GitHub token authenticates source downloads too', () => {
  const s = setup({token: 'test-token'});
  s.context.AutoUpdate(true);
  const githubCalls = s.calls.filter(call => call.url.startsWith(repoApi));
  assert.equal(githubCalls.length, 7);
  assert.ok(githubCalls.every(call => call.params.headers.Authorization === 'Bearer test-token'));
  assert.equal(s.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/')).length, 0);
});

test('bleeding-edge pins a commit and rejects a release missing the updater', () => {
  const s = setup({channel: 'bleeding-edge'});
  s.context.AutoUpdate(true);
  assert.equal(s.writes.length, 0);
  assert.ok(s.calls.filter(call => call.url.startsWith('https://raw.githubusercontent.com/'))
    .every(call => call.url.includes('/' + 'a'.repeat(40) + '/')));
  s.sources['Helpers.gs'] = 'function helper() {}';
  assert.throws(() => s.context.AutoUpdate(), /does not contain AutoUpdate/);
  assert.equal(s.writes.length, 0);
});

test('old update trigger migrates once without touching sync triggers', () => {
  const s = setup();
  const legacy = {getHandlerFunction() { return 'checkForUpdate'; }};
  const sync = {getHandlerFunction() { return 'startSync'; }};
  const triggers = [legacy, sync];
  const deleted = [];
  s.context.ScriptApp.getProjectTriggers = () => triggers.slice();
  s.context.ScriptApp.deleteTrigger = trigger => {
    deleted.push(trigger);
    triggers.splice(triggers.indexOf(trigger), 1);
  };
  s.context.ScriptApp.newTrigger = handler => ({timeBased() { return this; },
    everyDays(days) { assert.equal(days, 1); return this; },
    create() { triggers.push({getHandlerFunction() { return handler; }}); }});
  s.context.checkForUpdate();
  assert.deepEqual(deleted, [legacy]);
  assert.deepEqual(triggers.map(trigger => trigger.getHandlerFunction()), ['startSync', 'AutoUpdate']);
  assert.equal(s.calls.length, 0);
  s.context.checkForUpdate();
  assert.equal(triggers.length, 2);
});

test('disabled Apps Script API error explains the Cloud project setup', () => {
  const s = setup();
  s.context.UrlFetchApp.fetch = () => ({
    getResponseCode() { return 403; },
    getContentText() { return JSON.stringify({error: {message:
      'Apps Script API has not been used in project 915358193318 before or it is disabled.'}}); },
  });
  assert.throws(() => s.context.autoUpdateScriptRequest_(projectApi, 'get'),
    /Enable the Apps Script API in this script's Google Cloud project/);
});

test('GitHub 403 includes the API error reason', () => {
  const s = setup();
  s.context.UrlFetchApp.fetch = () => ({
    getResponseCode() { return 403; },
    getContentText() { return JSON.stringify({message: 'API rate limit exceeded'}); },
  });
  assert.throws(() => s.context.autoUpdateGithubJson_(repoApi + '/releases/latest'),
    /API rate limit exceeded/);
});
