import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {TorampClient} from '../src/client';
import {Gateway} from '../src/gateway';
import * as parser from '../src/parser';
import {futureDate, progress} from '../src/models';
import type {Transport} from '../src/transport';

const dom = new JSDOM('', {url: 'https://fixture.invalid'});
const document = (html: string) => new dom.window.DOMParser().parseFromString(html, 'text/html');
function session(account = 'fixture') {return '<a href="/logout/">Exit</a><a href="/' + account + '/shows/watching/">Watching</a>';}
function show({account = 'fixture', status = 'watching', watched = false, episodeId = 11, number = 1} = {}) {
  return '<body data-id="2">' + session(account) + '<script type="application/ld+json">{"@type":"TVSeries","name":"Synthetic","startDate":"2020-01-01"}</script>' +
    '<button class="selected" data-my-status="' + status + '"></button><button data-btn="user-status-decktop" data-my-status="watching"></button><button data-btn="user-status-decktop" data-my-status="want_to_see"></button>' +
    '<div id="episode_1.' + number + '" data-episode-id="' + episodeId + '"><time datetime="2020-01-01"></time><button data-btn="mark-episode" class="' + (watched ? 'checked-true' : '') + '"></button></div></body>';
}
function library(account = 'fixture', withItem = true) {return session(account) + '<main><table>' + (withItem ? '<tr><td class="titles"><a href="/shows/2/">Synthetic</a><time datetime="2020-01-01"></time></td></tr>' : '') + '</table></main>';}
function setup() {
  let account: string | null = 'fixture', status = 'watching', watched = false, persist = true, profile = '7';
  const calls: {path: string; fields?: Record<string, string | number>}[] = [];
  const transport: Transport = {
    async token() {return 'synthetic-csrf';},
    async request(path, fields) {
      calls.push({path, fields: fields && {...fields}});
      if (path.startsWith('/login/')) {
        if (fields) account = fields.password === 'correct' ? String(fields.username) : null;
        return {status: 200, text: account ? session(account) : '<form name="login"><input type="hidden" name="form_token" value="fixture"></form>'};
      }
      if (path === '/logout/') {account = null; return {status: 200, text: 'guest'};}
      if (path === '/script/user/show/user_status.php') {if (persist) status = String(fields?.status); return {status: 200, text: ''};}
      if (path === '/script/user/show/watched_episode.php') {if (persist) watched = true; return {status: 200, text: ''};}
      if (!account) return {status: 200, text: '<p>guest</p>'};
      if (path === '/shows/2/') return {status: 200, text: show({account, status, watched})};
      if (/\/shows\/[^/]+\/$/.test(path)) return {status: 200, text: library(account, path.includes('/watching/'))};
      if (path.startsWith('/search/')) return {status: 200, text: session(account) + '<ul class="list_catalog"><li><a class="title" href="/shows/2/">Synthetic</a><div class="first_line"><em>2020</em></div></li></ul>'};
      throw Error('Unexpected fixture request: ' + path);
    }
  };
  const storage = new JSDOM('', {url: 'https://storage.invalid'}).window.localStorage;
  const client = new TorampClient(transport, document), gateway = new Gateway(client, storage, () => profile);
  return {client, gateway, storage, calls, transport, get watched() {return watched;}, set account(value: string | null) {account = value;}, set persist(value: boolean) {persist = value;}, set profile(value: string) {profile = value;}};
}
const mapping = {tmdbId: 1, torampId: 2, originalName: 'Synthetic', episodes: [{season: 1, episode: 1, torampEpisodeId: 11}], skipped: [], confirmed: true};

test('active profile in global navigation identifies the account without a watching link', () => {
  const nav = '<a href="/logout/">Exit</a><nav id="gnav_full"><div class="bottom"><div class="first_link"><span class="active">fixture</span></div></div></nav>';
  assert.equal(parser.account(document(nav)), 'fixture');
  assert.equal(parser.library(document(nav + '<main><table></table></main>'), 'fixture', 'watching').length, 0);
  assert.throws(() => parser.authenticated(document(nav), 'other'), /Аккаунт/);
  assert.equal(parser.account(document(nav + '<a href="/other/shows/watching/">Viewed profile</a>')), 'fixture');
});

test('global profile link takes precedence over links to another viewed account', () => {
  const nav = '<a href="/logout/">Exit</a><nav id="gnav_full"><div class="bottom"><div class="first_link"><a href="/fixture/shows/watching/">fixture</a></div></div></nav>';
  assert.equal(parser.account(document('<a href="/other/shows/watching/">Viewed profile</a>' + nav)), 'fixture');
  assert.throws(() => parser.account(document(nav.replace('/fixture/shows/watching/', 'https://other.invalid/fixture/shows/watching/'))), /другой сайт/);
  assert.throws(() => parser.account(document('<a href="/logout/">Exit</a>')), /определить аккаунт/);
});

test('login checks a fresh account page and does not persist credentials', async () => {
  const h = setup(); h.account = null;
  await h.gateway.login('fixture', 'correct');
  assert.equal(h.gateway.account, 'fixture');
  const post = h.calls.find(call => call.fields?.password);
  assert.equal(post?.path, '/login/'); assert.equal(post?.fields?.form_token, 'fixture');
  assert.equal(h.storage.length, 0);
  assert.match(h.calls.at(-1)!.path, /^\/login\/\?/);
});
test('HTTP 200 with guest page cannot activate a session', async () => {
  const h = setup(); h.account = null;
  await assert.rejects(h.gateway.login('fixture', 'wrong'), /не подтвердил вход/);
  assert.equal(h.gateway.ready, false);
});
test('library parses a valid empty table but rejects missing markup or pagination', () => {
  assert.equal(parser.library(document(library('fixture', false)), 'fixture', 'watching').length, 0);
  assert.throws(() => parser.library(document(session()), 'fixture', 'watching'), /прочитать список/);
  assert.throws(() => parser.library(document(library() + '<a rel="next"></a>'), 'fixture', 'watching'), /Формат списка/);
});
test('library accepts Toramp empty-list marker only inside its library container', () => {
  const empty = '<main><div class="page_container_wrapper_0"><div class="container"><div class="list_is_empty"><p>The list is empty.</p></div></div></div></main>';
  assert.deepEqual(parser.library(document(session() + empty), 'fixture', 'on-hold'), []);
  assert.throws(() => parser.library(document(session() + '<main><div class="list_is_empty"></div></main>'), 'fixture', 'on-hold'), /прочитать список/);
  assert.throws(() => parser.library(document(session() + empty + '<a rel="next"></a>'), 'fixture', 'on-hold'), /Формат списка/);
});
test('off-site links and account mismatch are rejected', () => {
  assert.throws(() => parser.internalPath('https://other.invalid/shows/2/'), /другой сайт/);
  assert.throws(() => parser.library(document(library('other')), 'fixture', 'watching'), /Аккаунт/);
});
test('episode parser rejects duplicates and unknown numbering, skips only future announcements', () => {
  assert.throws(() => parser.episodes(document(show() + '<div data-episode-id="12" id="episode_1.1"><button data-btn="mark-episode"></button></div>'), 'fixture'), /однозначно/);
  assert.throws(() => parser.episodes(document(show() + '<div data-episode-id="12" id="episode_1.2"><time datetime="2020-01-01"></time></div>'), 'fixture'), /Формат серий/);
  assert.equal(parser.episodes(document(show() + '<div data-episode-id="12" id="episode_1.2"><time datetime="2999-00-00"></time></div>'), 'fixture').length, 1);
  assert.equal(futureDate('2025-02-31'), false);
});
test('unseen progress excludes specials, future and incomplete dates', () => {
  const episodes = parser.episodes(document(show()), 'fixture');
  assert.equal(progress([...episodes, {...episodes[0], id: 12, season: 0}, {...episodes[0], id: 13, air_date: '2999-01-01'}, {...episodes[0], id: 14, air_date: '2020-00-00'}]).available, 1);
});
test('status changes only after allowed status and identity checks, then re-read confirms it', async () => {
  const h = setup(); await h.gateway.restore();
  const result = await h.gateway.invoke('status', {id: 2, category: 'want-to-see'}, h.gateway.scope());
  assert.equal(result.status, 'want_to_see');
  assert.deepEqual(h.calls.find(call => call.path.endsWith('user_status.php'))?.fields, {id: 2, status: 'want_to_see'});
  assert.equal(h.calls.at(-1)?.path, '/shows/2/');
});
test('unconfirmed status success is an error; forbidden status never posts', async () => {
  const h = setup(); await h.gateway.restore(); h.persist = false;
  await assert.rejects(h.gateway.invoke('status', {id: 2, category: 'want-to-see'}, h.gateway.scope()), /не подтверждено/);
  h.calls.length = 0;
  await assert.rejects(h.gateway.invoke('status', {id: 2, category: 'completed'}, h.gateway.scope()), /не разрешает/);
  assert.ok(h.calls.every(call => !call.fields));
});
test('unconfirmed episode write leaves persisted outbox intact', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  h.gateway.save(s, 'mappings', {'1': mapping}); h.gateway.save(s, 'queue', {'1': [11]}); h.persist = false;
  await assert.rejects(h.gateway.invoke('sync', {tmdbId: 1, watched: [11]}, s), /Отметки останутся/);
  assert.deepEqual(h.gateway.read(s, 'queue', {}), {'1': [11]});
});
test('confirmed episode addition reports only re-read watched IDs', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope(); h.gateway.save(s, 'mappings', {'1': mapping});
  const result = await h.gateway.invoke('sync', {tmdbId: 1, watched: [11, 11]}, s);
  assert.equal(h.watched, true); assert.deepEqual(result.watched, [11]);
  assert.equal(h.calls.filter(call => call.path.endsWith('watched_episode.php')).length, 1);
  h.calls.length = 0;
  await h.gateway.invoke('sync', {tmdbId: 1, watched: [11]}, s);
  assert.ok(h.calls.every(call => !call.fields));
});
test('changed numbering stops episode writes', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  h.gateway.save(s, 'mappings', {'1': {...mapping, episodes: [{season: 1, episode: 2, torampEpisodeId: 11}]}});
  await assert.rejects(h.gateway.invoke('sync', {tmdbId: 1, watched: [11]}, s), /Нумерация/);
  assert.ok(h.calls.every(call => !call.fields));
});
test('old account queue cannot write into a different cookie session', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope(); h.gateway.save(s, 'mappings', {'1': mapping}); h.account = 'other';
  await assert.rejects(h.gateway.invoke('sync', {tmdbId: 1, watched: [11]}, s), /Аккаунт/);
  assert.ok(h.calls.every(call => !call.fields));
});
test('profile changes during token acquisition prevent POST', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  h.transport.token = async () => {h.profile = '8'; return 'synthetic';};
  await assert.rejects(h.gateway.invoke('status', {id: 2, category: 'want-to-see'}, s), /профиль изменился/);
  assert.ok(h.calls.every(call => !call.fields));
});
test('mapping previews are independent, one-use, account/profile-bound', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  const data = {tmdbId: 1, torampId: 2, originalName: 'Synthetic', episodes: [{season: 1, episode: 1, air_date: '2020-01-01'}, {season: 1, episode: 2, air_date: '2020-01-02'}]};
  const first = await h.gateway.invoke('preview', data, s), second = await h.gateway.invoke('preview', {...data, tmdbId: 3}, s);
  assert.notEqual(first.confirmation, second.confirmation); assert.deepEqual(first.mapping.skipped, [[1, 2]]);
  assert.equal((await h.gateway.invoke('mappings', null, s)).length, 0);
  await h.gateway.invoke('confirm', {confirmation: second.confirmation}, s);
  await h.gateway.invoke('confirm', {confirmation: first.confirmation}, s);
  await assert.rejects(h.gateway.invoke('confirm', {confirmation: first.confirmation}, s), /устарело/);
  assert.equal((await h.gateway.invoke('mappings', null, s)).length, 2);
});
test('restart preserves mappings and outbox but requires freshly verified session', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  h.gateway.save(s, 'mappings', {'1': mapping}); h.gateway.save(s, 'queue', {'1': [11]});
  const restored = new Gateway(h.client, h.storage, () => '7'); assert.equal(restored.ready, false);
  await restored.restore(); assert.equal(restored.scope(), s);
  assert.equal((await restored.invoke('mappings', null, s)).length, 1); assert.deepEqual(restored.read(s, 'queue', {}), {'1': [11]});
  h.account = 'other'; await restored.restore();
  assert.deepEqual(restored.read(restored.scope(), 'queue', {}), {});
});
test('logout immediately invalidates operations, preserves prior account queue', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope(); h.gateway.save(s, 'queue', {'1': [11]});
  await h.gateway.logout(); assert.equal(h.gateway.ready, false);
  assert.deepEqual(h.gateway.read(s, 'queue', {}), {'1': [11]});
  await assert.rejects(h.gateway.invoke('shows', null, s), /профиль изменился/);
});

test('checking the same session during a write does not invalidate it', async () => {
  const h = setup(); await h.gateway.restore(); const s = h.gateway.scope();
  h.transport.token = async () => {await h.gateway.restore(); return 'synthetic';};
  assert.equal((await h.gateway.invoke('status', {id: 2, category: 'want-to-see'}, s)).status, 'want_to_see');
});

test('concurrent restoration shares one session read; logout prevents late restoration', async () => {
  let complete: (value: string | null) => void = () => {};
  let reads = 0;
  const fake = {session() {reads++; return new Promise<string | null>(resolve => {complete = resolve;});}} as TorampClient;
  const gateway = new Gateway(fake, new JSDOM('', {url: 'https://fixture.invalid'}).window.localStorage, () => '7');
  const a = gateway.restore(), b = gateway.restore();
  assert.equal(a, b); assert.equal(reads, 1);
  await gateway.logout(); complete('fixture');
  await assert.rejects(a, /Аккаунт изменился/); assert.equal(gateway.ready, false);
});
