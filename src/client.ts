import {STATUSES, positiveId, type Category, type Episode, type Show} from './models';
import * as parse from './parser';
import type {Transport} from './transport';

export class TorampClient {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private transport: Transport, private document: (html: string) => Document) {}
  private async page(path: string) {return this.document((await this.transport.request(path)).text);}
  async session() {return parse.account(await this.page('/login/?lampa_session=' + Date.now()));}
  async login(username: string, password: string): Promise<string> {
    if (!username.trim() || !password) throw Error('Введите логин и пароль Toramp.');
    const doc = await this.page('/login/');
    if (parse.account(doc)) throw Error('На устройстве уже выполнен вход. Сначала выйдите из текущего аккаунта.');
    const form = doc.querySelector('form[name="login"]');
    if (!form) throw Error('Форма входа Toramp недоступна. Повторите позже.');
    const fields: Record<string, string> = {};
    form.querySelectorAll<HTMLInputElement>('input[type="hidden"][name]').forEach(input => {fields[input.name] = input.value;});
    fields.username = username.trim(); fields.password = password; fields.btn_login = '';
    try {await this.transport.request('/login/', fields);} finally {fields.password = ''; password = ''; username = '';}
    const identity = await this.session();
    if (!identity) throw Error('Toramp не подтвердил вход. Проверьте логин и пароль.');
    return identity;
  }
  async ensure(expected: string) {
    const actual = await this.session();
    if (!actual) throw Error('Сессия Toramp истекла. Войдите снова.');
    if (actual !== expected) throw Error('Аккаунт Toramp изменился. Подключите его заново.');
  }
  async logout(expected: string) {
    return this.serial(async () => {
      await this.ensure(expected); await this.page('/logout/');
      if (await this.session()) throw Error('Toramp не подтвердил выход. Повторите позже.');
    });
  }
  async shows(expected: string): Promise<Show[]> {
    const result: Show[] = [];
    // Five category pages, bounded serial reading instead of flooding the site.
    for (const category of Object.keys(STATUSES) as Category[]) {
      const doc = await this.page('/' + expected + '/shows/' + category + '/');
      for (const show of parse.library(doc, expected, category)) {
        if (result.some(item => item.id === show.id)) throw Error('Сериал найден в нескольких категориях Toramp. Обновите список.');
        result.push(show);
      }
    }
    return result;
  }
  async show(expected: string, id: number) {return parse.metadata(await this.page('/shows/' + positiveId(id) + '/'), expected, id);}
  async episodes(expected: string, id: number): Promise<Episode[]> {
    const doc = await this.page('/shows/' + positiveId(id) + '/');
    parse.metadata(doc, expected, id);
    return parse.episodes(doc, expected);
  }
  async search(expected: string, query: string) {
    if (!query || query.trim().length > 200) throw Error('Укажите название сериала.');
    return parse.search(await this.page('/search/?q=' + encodeURIComponent(query.trim())), expected);
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const result = this.writes.then(job, job);
    this.writes = result.catch(() => undefined); return result;
  }
  async setStatus(expected: string, id: number, category: Category, guard: () => void) {
    return this.serial(async () => {
      guard(); await this.ensure(expected); guard();
      if (!Object.prototype.hasOwnProperty.call(STATUSES, category)) throw Error('Неизвестный статус Toramp.');
      const before = await this.show(expected, id); guard();
      if (before.status === STATUSES[category]) return before;
      if (!before.allowed?.includes(category)) throw Error('Toramp не разрешает этот статус. Выберите другой.');
      const csrf = await this.transport.token();
      await this.ensure(expected); guard();
      await this.transport.request('/script/user/show/user_status.php', {id, status: STATUSES[category]}, csrf);
      guard(); const after = await this.show(expected, id); guard();
      if (after.status !== STATUSES[category]) throw Error('Изменение статуса не подтверждено. Обновите список.');
      return after;
    });
  }
  async markWatched(expected: string, showId: number, wanted: number[], links: {season: number; episode: number; torampEpisodeId: number}[], guard: () => void) {
    return this.serial(async () => {
      guard(); await this.ensure(expected); guard();
      let remote = await this.episodes(expected, showId); guard();
      function validate(items: Episode[]) {
        for (const link of links) {
          const item = items.find(e => e.id === link.torampEpisodeId);
          if (!item || item.season !== link.season || item.episode !== link.episode) throw Error('Нумерация серий изменилась. Подключите сериал заново.');
        }
      }
      validate(remote);
      if (!Array.isArray(wanted) || wanted.length > 3000 || wanted.some(id => !links.some(e => e.torampEpisodeId === id))) throw Error('Неизвестная серия в очереди синхронизации.');
      const pending = wanted.filter((id, i) => wanted.indexOf(id) === i && !remote.find(e => e.id === id)?.watched);
      if (pending.length) {
        const csrf = await this.transport.token();
        for (const id of pending) {
          await this.ensure(expected); guard();
          await this.transport.request('/script/user/show/watched_episode.php', {id: positiveId(id), action: 1}, csrf);
          guard();
        }
        remote = await this.episodes(expected, showId); guard(); validate(remote);
      }
      const watched = remote.filter(e => e.watched && links.some(link => link.torampEpisodeId === e.id)).map(e => e.id);
      if (pending.some(id => !watched.includes(id))) throw Error('Сохранение серий не подтверждено. Отметки останутся в очереди.');
      return {watched, acknowledged: wanted.filter(id => watched.includes(id))};
    });
  }
}
