export const BASE = 'https://www.toramp.com';
export const STATUSES = {watching: 'watching', completed: 'completed', 'want-to-see': 'want_to_see', 'on-hold': 'on_hold', dropped: 'dropped'} as const;
export type Category = keyof typeof STATUSES;
export interface Show {id: number; title: string; year: string; poster: string; category?: Category; progress?: string; original_name?: string; status?: string; allowed?: Category[]}
export interface Episode {id: number; season: number; episode: number; watched: boolean; air_date: string}
export interface Link {season: number; episode: number; torampEpisodeId: number}
export interface Mapping {tmdbId: number; torampId: number; originalName: string; aliases?: string[]; episodes: Link[]; skipped: number[][]; confirmed: boolean}
export function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw Error('Некорректный номер сериала или серии.');
  return value;
}
export function futureDate(value: string, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month > 12 || day > 31 || (!month && day)) return false;
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== (month || 1) - 1 || date.getUTCDate() !== (day || 1)) return false;
  return date.toISOString().slice(0, 10) > today;
}
export function progress(episodes: Episode[], today = new Date().toISOString().slice(0, 10)) {
  const released = episodes.filter(e => e.season > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.air_date) && e.air_date.slice(5, 7) !== '00' && e.air_date.slice(8, 10) !== '00' && e.air_date <= today);
  const unseen = released.filter(e => !e.watched).sort((a, b) => a.season - b.season || a.episode - b.episode);
  return {next: unseen[0] ? {season: unseen[0].season, episode: unseen[0].episode, air_date: unseen[0].air_date} : null, available: unseen.length, released: released.length, watched: released.filter(e => e.watched).length};
}
