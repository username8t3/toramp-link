import {TorampClient} from './client';
import {progress, positiveId, type Mapping, type Category, type Show} from './models';

export class Gateway {
  account = '';
  ready = false;
  private generation = 0;
  private previews: Record<string, {scope: string; expires: number; mapping: Mapping}> = {};
  private sequence = 0;
  private restoreJob?: Promise<boolean>;
  private dashboardGeneration = 0;
  private dashboards: Record<string, {until: number; refreshing: boolean; errors: number; items: Record<number, ReturnType<typeof progress>>}> = {};
  constructor(private client: TorampClient, private storage: Storage, private profile: () => string) {}
  scope() {return JSON.stringify([this.account, this.profile()]);}
  key(scope: string, name: string) {return 'lampa_toramp_v1_' + encodeURIComponent(scope) + '_' + name;}
  read<T>(scope: string, name: string, fallback: T): T {
    try {const value = this.storage.getItem(this.key(scope, name)); return value === null ? fallback : JSON.parse(value) ?? fallback;} catch {return fallback;}
  }
  save(scope: string, name: string, value: unknown) {
    try {this.storage.setItem(this.key(scope, name), JSON.stringify(value));} catch {throw Error('Не удалось сохранить очередь на устройстве. Освободите место и повторите.');}
  }
  private activate(identity: string | null) {
    this.generation++; this.dashboardGeneration++; this.previews = {}; this.dashboards = {};
    this.account = identity || ''; this.ready = !!identity;
  }
  restore(): Promise<boolean> {
    if (this.restoreJob) return this.restoreJob;
    const generation = this.generation;
    const job = this.client.session().then(identity => {
      if (generation !== this.generation) throw Error('Аккаунт изменился во время проверки. Повторите.');
      // A connection check for the same account must not cancel a pending sync.
      if ((identity || '') !== this.account || (!!identity) !== this.ready) this.activate(identity);
      return this.ready;
    });
    this.restoreJob = job;
    job.then(() => {if (this.restoreJob === job) this.restoreJob = undefined;}, () => {if (this.restoreJob === job) this.restoreJob = undefined;});
    return job;
  }
  async login(username: string, password: string) {
    this.activate(null);
    const identity = await this.client.login(username, password); this.activate(identity);
  }
  async logout() {
    const identity = this.account; this.activate(null);
    if (identity) await this.client.logout(identity);
  }
  private guard(scope: string, generation: number) {
    if (!this.ready || this.scope() !== scope || this.generation !== generation) throw Error('Аккаунт или профиль изменился. Откройте Toramp заново.');
  }
  private mappings(scope: string): Record<string, Mapping> {return this.read(scope, 'mappings', {});}
  private invalidate(scope: string) {
    this.save(scope, 'showsCache', null); this.dashboardGeneration++; delete this.dashboards[scope];
  }
  // Local commands keep the existing Lampa UI separate from parsing and persistence.
  // Only TorampClient performs network operations; none of these names are URLs.
  async invoke(command: string, data: any, scope: string): Promise<any> {
    const generation = this.generation, expected = this.account;
    const guard = () => this.guard(scope, generation); guard();
    let result: unknown;
    switch (command) {
      case 'shows': result = await this.client.shows(expected); break;
      case 'show': result = await this.client.show(expected, positiveId(data.id)); break;
      case 'search': result = await this.client.search(expected, data.query); break;
      case 'status': result = await this.client.setStatus(expected, positiveId(data.id), data.category as Category, guard); guard(); this.invalidate(scope); break;
      case 'mappings': result = Object.values(this.mappings(scope)); break;
      case 'alias': {
        const mappings = this.mappings(scope), mapping = mappings[positiveId(data.tmdbId)];
        if (!mapping || typeof data.name !== 'string' || !data.name || data.name.length >= 500) throw Error('Не удалось обновить название связанного сериала.');
        mapping.aliases = mapping.aliases || [];
        if (data.name !== mapping.originalName && !mapping.aliases.includes(data.name)) {
          if (mapping.aliases.length >= 8) throw Error('Слишком много вариантов названия сериала.');
          mapping.aliases.push(data.name); this.save(scope, 'mappings', mappings);
        }
        result = mapping; break;
      }
      case 'preview': {
        positiveId(data.tmdbId); positiveId(data.torampId);
        if (typeof data.originalName !== 'string' || !data.originalName || data.originalName.length >= 500 || !Array.isArray(data.episodes) || data.episodes.length > 3000) throw Error('Не удалось проверить данные сериала Lampa.');
        const remote = await this.client.episodes(expected, data.torampId); guard();
        const mapping: Mapping = {tmdbId: data.tmdbId, torampId: data.torampId, originalName: data.originalName, episodes: [], skipped: [], confirmed: false};
        const seen: Record<string, boolean> = {};
        for (const episode of data.episodes) {
          if (!Number.isSafeInteger(episode.season) || episode.season < 0) throw Error('Некорректный сезон Lampa.');
          positiveId(episode.episode);
          const key = episode.season + ':' + episode.episode;
          if (seen[key]) throw Error('Неоднозначная нумерация серий Lampa.'); seen[key] = true;
          const match = remote.find(e => e.season === episode.season && e.episode === episode.episode);
          if (!episode.season || !match || !episode.air_date || match.air_date !== episode.air_date) mapping.skipped.push([episode.season, episode.episode]);
          else mapping.episodes.push({season: episode.season, episode: episode.episode, torampEpisodeId: match.id});
        }
        if (!mapping.episodes.length) throw Error('Нет серий с совпадающей нумерацией и датой выхода. Синхронизация остановлена.');
        Object.keys(this.previews).forEach(key => {if (this.previews[key].expires < Date.now()) delete this.previews[key];});
        if (Object.keys(this.previews).length >= 20) throw Error('Слишком много одновременных сопоставлений. Повторите позже.');
        const confirmation = String(++this.sequence);
        this.previews[confirmation] = {scope, mapping, expires: Date.now() + 600000};
        result = {confirmation, mapping}; break;
      }
      case 'confirm': {
        const preview = this.previews[data.confirmation];
        if (!preview || preview.scope !== scope || preview.expires < Date.now()) throw Error('Предварительное сопоставление устарело. Повторите.');
        const mappings = this.mappings(scope); preview.mapping.confirmed = true;
        mappings[preview.mapping.tmdbId] = preview.mapping; this.save(scope, 'mappings', mappings);
        delete this.previews[data.confirmation]; result = preview.mapping; break;
      }
      case 'sync': {
        const mapping = this.mappings(scope)[positiveId(data.tmdbId)];
        if (!mapping?.confirmed) throw Error('Сначала подтвердите соответствие сериалов.');
        result = await this.client.markWatched(expected, mapping.torampId, data.watched, mapping.episodes, guard);
        guard(); this.invalidate(scope); break;
      }
      case 'dashboard': result = await this.dashboard(scope, expected, guard); break;
      default: throw Error('Неизвестное действие Toramp.');
    }
    guard(); return result;
  }
  private async dashboard(scope: string, expected: string, guard: () => void) {
    const cached = this.read<{time: number; items: Show[]} | null>(scope, 'showsCache', null);
    const shows = cached && Date.now() - cached.time < 60000 ? cached.items : await this.client.shows(expected); guard();
    const watching = shows.filter(show => show.category === 'watching');
    let state = this.dashboards[scope];
    if (!state) state = this.dashboards[scope] = {until: 0, refreshing: false, errors: 0, items: {}};
    if (!state.refreshing && Date.now() >= state.until) {
      state.refreshing = true; state.errors = 0;
      const generation = this.dashboardGeneration;
      let next = 0;
      const worker = async () => {
        while (next < watching.length) {
          const show = watching[next++];
          try {
            const items = await this.client.episodes(expected, show.id); guard();
            if (generation === this.dashboardGeneration) state.items[show.id] = progress(items);
          } catch {if (generation === this.dashboardGeneration) state.errors++;}
        }
      };
      Promise.all([worker(), worker(), worker()]).then(() => {
        if (generation !== this.dashboardGeneration) return;
        state.refreshing = false; state.until = Date.now() + (state.errors ? 60000 : 300000);
      });
    }
    const items = watching.filter(show => state.items[show.id]).map(show => ({...show, episode_progress: state.items[show.id]}));
    return {items, refreshing: state.refreshing, errors: state.errors, pending: watching.length - items.length};
  }
}
