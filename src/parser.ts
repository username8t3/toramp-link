import {BASE, STATUSES, positiveId, futureDate, type Category, type Episode, type Show} from './models';

export function internalPath(href: string): string {
  const url = new URL(href, BASE);
  if (url.origin !== BASE) throw Error('Toramp вернул ссылку на другой сайт.');
  return url.pathname + url.search;
}
export function account(doc: Document): string | null {
  if (!doc.querySelector('a[href$="/logout/"]')) return null;
  // Toramp replaces the signed-in profile link with an active span on its list pages.
  // Read the global navigation, never a link to a different profile in page content.
  const profile = doc.querySelector('#gnav_full .bottom .first_link');
  if (profile) {
    const active = profile.querySelector('span.active');
    const username = active?.textContent?.trim();
    if (username && !/[\s/\\?#]/.test(username)) return encodeURIComponent(username);
  }
  const link = profile ? profile.querySelector('a[href]') : doc.querySelector('a[href$="/shows/watching/"]');
  const match = link && internalPath(link.getAttribute('href') || '').match(/^\/([^/]+)\/shows\/watching\/$/);
  if (!match) throw Error('Не удалось определить аккаунт Toramp.');
  return match[1];
}
export function authenticated(doc: Document, expected: string): void {
  const actual = account(doc);
  if (!actual) throw Error('Сессия Toramp истекла. Войдите снова.');
  if (actual !== expected) throw Error('Аккаунт Toramp изменился. Подключите его заново.');
}
function poster(node: Element): string {
  const href = node.querySelector('img[src]')?.getAttribute('src');
  if (!href) return '';
  const url = new URL(href, BASE);
  return url.origin === BASE ? url.href.replace('/width82/', '/width360/') : '';
}
function idFromLink(node: Element | null): number | null {
  if (!node) return null;
  const match = internalPath(node.getAttribute('href') || '').match(/^\/shows\/(\d+)\/$/);
  return match ? positiveId(Number(match[1])) : null;
}
export function library(doc: Document, expected: string, category: Category): Show[] {
  authenticated(doc, expected);
  if (doc.querySelector('a[rel="next"]')) throw Error('Формат списка Toramp изменился. Требуется обновление плагина.');
  // Empty categories use a dedicated block rather than a table. Missing markup
  // must still fail instead of silently erasing a collection after a site change.
  if (!doc.querySelector('main table')) {
    if (doc.querySelector('main .page_container_wrapper_0 > .container > .list_is_empty')) return [];
    throw Error('Не удалось прочитать список Toramp.');
  }
  const found: Show[] = [];
  doc.querySelectorAll('main table tr').forEach(row => {
    const link = row.querySelector('.titles a[href]'), id = idFromLink(link);
    if (!id || !link) return;
    found.push({id, title: link.textContent?.trim() || '', category, poster: poster(row), year: row.querySelector('time[datetime]')?.getAttribute('datetime')?.slice(0, 4) || '', progress: row.querySelector('[data-squanchy^="Watched episodes:"]')?.textContent?.trim() || ''});
  });
  return found;
}
export function metadata(doc: Document, expected: string, id: number): Show {
  authenticated(doc, expected);
  if (doc.querySelector('body[data-id]')?.getAttribute('data-id') !== String(positiveId(id))) throw Error('Не удалось проверить сериал Toramp.');
  let data: Record<string, unknown> | undefined;
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {const item = JSON.parse(script.textContent || ''); if (item && item['@type'] === 'TVSeries') data = item;} catch { /* unrelated metadata */ }
  });
  const status = doc.querySelector('[data-my-status].selected')?.getAttribute('data-my-status');
  if (!data || typeof data.name !== 'string' || !status || !['no_status', ...Object.values(STATUSES)].includes(status)) throw Error('Формат карточки Toramp изменился. Требуется обновление плагина.');
  const allowed = (Object.keys(STATUSES) as Category[]).filter(category => doc.querySelector('[data-btn="user-status-decktop"][data-my-status="' + STATUSES[category] + '"]:not(.disabled)'));
  return {id, title: data.name, original_name: typeof data.alternateName === 'string' ? data.alternateName : data.name, year: String(data.startDate || data.datePublished || '').slice(0, 4), poster: typeof data.image === 'string' && new URL(data.image, BASE).origin === BASE ? new URL(data.image, BASE).href : '', status, allowed};
}
export function episodes(doc: Document, expected: string): Episode[] {
  authenticated(doc, expected);
  const result: Episode[] = [], ids: Record<string, boolean> = {}, keys: Record<string, boolean> = {};
  doc.querySelectorAll('[data-episode-id]').forEach(row => {
    const match = row.id.match(/^episode_(\d+)\.(\d+)$/), button = row.querySelector('[data-btn="mark-episode"]');
    const air_date = row.querySelector('time[datetime]')?.getAttribute('datetime')?.slice(0, 10) || '';
    if (match && !button && futureDate(air_date)) return;
    if (!match || !button) throw Error('Формат серий Toramp изменился. Синхронизация остановлена.');
    const id = positiveId(Number(row.getAttribute('data-episode-id'))), season = Number(match[1]), episode = positiveId(Number(match[2]));
    const key = season + ':' + episode;
    if (ids[id] || keys[key]) throw Error('Не удалось однозначно прочитать серии Toramp.');
    ids[id] = keys[key] = true;
    result.push({id, season, episode, air_date, watched: button.classList.contains('checked-true')});
  });
  if (!result.length) throw Error('Не удалось прочитать серии Toramp.');
  return result;
}
export function search(doc: Document, expected: string): Show[] {
  authenticated(doc, expected);
  const found: Show[] = [];
  doc.querySelectorAll('.list_catalog > li').forEach(row => {
    const link = row.querySelector('a.title[href]'), id = idFromLink(link);
    if (id && link && !found.some(s => s.id === id)) found.push({id, title: link.textContent?.trim() || '', year: row.querySelector('.first_line em')?.textContent?.match(/\d{4}/)?.[0] || '', poster: poster(row)});
  });
  return found;
}
