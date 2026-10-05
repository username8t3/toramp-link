import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source = readFileSync(new URL('../dist/toramp-link.js', import.meta.url), 'utf8');
const identity = '<a href="/logout/">Exit</a><a href="/fixture/shows/watching/">Watching</a>';
function page(watched: boolean) {return '<body data-id="2">' + identity + '<script type="application/ld+json">{"@type":"TVSeries","name":"Synthetic","startDate":"2020-01-01"}</script><button class="selected" data-my-status="watching"></button>' +
  [1, 2].map(n => '<div data-episode-id="' + (10 + n) + '" id="episode_1.' + n + '"><time datetime="2020-01-0' + n + '"></time><button data-btn="mark-episode" class="' + (n === 1 || watched ? 'checked-true' : '') + '"></button></div>').join('') + '</body>';}

async function harness(mode: 'ok' | 'offline' | 'unconfirmed' | 'profile-switch' = 'ok') {
  const dom = new JSDOM('<html><head></head><body></body></html>', {url: 'https://lampa-fixture.invalid', runScripts: 'outside-only'});
  const env = dom.window as any, calls: {url: string; fields: URLSearchParams | null}[] = [], updates: any[] = [], settings: any[] = [], notices: string[] = [], selections: any[] = [];
  let remoteWatched = false, profile = '7';
  const s = JSON.stringify(['fixture', '7']);
  const key = (name: string) => 'lampa_toramp_v1_' + encodeURIComponent(s) + '_' + name;
  env.localStorage.setItem(key('mappings'), JSON.stringify({'1': {tmdbId: 1, torampId: 2, originalName: 'Synthetic', episodes: [{season: 1, episode: 1, torampEpisodeId: 11}, {season: 1, episode: 2, torampEpisodeId: 12}], skipped: [], confirmed: true}}));
  env.XMLHttpRequest = class {
    url = ''; status = 200; responseText = ''; responseURL = ''; onload: any; onerror: any;
    open(_method: string, url: string) {this.url = url; this.responseURL = url;}
    setRequestHeader() {}
    send(body: string | null) {
      calls.push({url: this.url, fields: body ? new URLSearchParams(body) : null});
      queueMicrotask(() => {
        if (this.url.includes('/login/')) this.responseText = identity;
        else if (this.url.endsWith('/shows/2/')) this.responseText = page(remoteWatched);
        else if (this.url.endsWith('/watched_episode.php')) {
          if (mode === 'offline') {this.onerror(); return;}
          if (mode === 'ok') remoteWatched = true;
          if (mode === 'profile-switch') {profile = '8'; remoteWatched = true;}
          this.responseText = '';
        } else throw Error('Unexpected network request: ' + this.url);
        this.onload();
      });
    }
  };
  const append = env.document.body.appendChild.bind(env.document.body);
  env.document.body.appendChild = (node: any) => {
    const result = append(node);
    if (node.tagName === 'IFRAME') {
      Object.defineProperty(node, 'contentWindow', {value: {document: {URL: 'https://www.toramp.com/login/', cookie: 'ajax_token=synthetic'}}});
      queueMicrotask(() => node.onload());
    }
    return result;
  };
  env.Lampa = {
    Account: {Permit: {sync: true, account: {get profile() {return {id: profile};}}}},
    Component: {add() {}}, SettingsApi: {addComponent(v: any) {settings.push(v);}, addParam(v: any) {settings.push(v);}},
    Menu: {addButton() {return {attr() {}};}},
    Noty: {show(text: string) {notices.push(text);}},
    Timeline: {watchedEpisode(_card: any, _season: number, episode: number) {return {hash: episode, percent: episode === 2 ? 95 : 20, duration: 100, time: 20, profile};}, update(value: any) {updates.push(value);}},
    Listener: {follow() {}}, Player: {listener: {follow() {}}},
    Controller: {toggle() {}}, Select: {show(value: any) {selections.push(value);}}
  };
  env.appready = true;
  env.eval(source);
  for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve));
  return {dom, env, calls, updates, settings, notices, selections, key};
}
test('compiled plugin syncs directly, imports watched and clears only confirmed pending IDs', async () => {
  const h = await harness();
  try {
    assert.ok(h.calls.length > 3);
    assert.ok(h.calls.every(call => call.url.startsWith('https://www.toramp.com/')));
    assert.equal(h.calls.find(call => call.url.endsWith('/watched_episode.php'))?.fields?.get('id'), '12');
    assert.equal(h.updates.length, 1); assert.equal(h.updates[0].percent, 95); assert.equal(h.updates[0].hash, 1);
    assert.deepEqual(JSON.parse(h.env.localStorage.getItem(h.key('queue'))), {'1': []});
    assert.equal(h.env.document.querySelectorAll('iframe').length, 0);
  } finally {h.dom.window.close();}
});
for (const mode of ['offline', 'unconfirmed', 'profile-switch'] as const) {
  test('compiled plugin preserves outbox and avoids importing when ' + mode, async () => {
    const h = await harness(mode);
    try {
      assert.deepEqual(JSON.parse(h.env.localStorage.getItem(h.key('queue'))), {'1': [12]});
      assert.equal(h.updates.length, 0);
      assert.ok(h.env.localStorage.getItem(h.key('lastError')));
    } finally {h.dom.window.close();}
  });
}
test('compiled settings share the Toramp mark and expose account/sync state', async () => {
  const h = await harness();
  try {
    assert.equal(h.settings[0].name, 'Toramp Link');
    assert.ok(h.settings[0].icon.includes('currentColor'));
    const connection = h.settings.find(v => v.param?.name === 'toramp_link_connection');
    let click: () => void = () => assert.fail('no settings callback');
    connection.onRender({on(_event: string, callback: () => void) {click = callback;}}); click();
    assert.ok(h.selections[0].items.some((item: any) => item.title === 'Аккаунт: fixture'));
    assert.ok(h.selections[0].items.some((item: any) => item.logout));
    assert.ok(h.settings.every(v => !JSON.stringify(v).includes('по коду')));
  } finally {h.dom.window.close();}
});
test('public artifact contains no LAN bridge, telemetry route or external module imports', () => {
  assert.doesNotMatch(source, /192\.168\.|Realme|\/diagnostics|Authorization|Bearer/);
  assert.doesNotMatch(source, /^\s*(import|export)\s/m);
});

test('a running old plugin blocks this plugin with an actionable message', () => {
  const dom = new JSDOM('', {url: 'https://fixture.invalid', runScripts: 'outside-only'}), env = dom.window as any, notices: string[] = [];
  env.FrameTorampSync = {version: '0.4.0'}; env.Lampa = {Noty: {show(text: string) {notices.push(text);}}};
  env.eval(source);
  assert.equal(env.TorampLink, undefined); assert.equal(notices.length, 1); assert.match(notices[0], /отключите прежний плагин/);
  dom.window.close();
});
