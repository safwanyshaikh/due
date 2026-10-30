/** Injectable clock so scheduling and expiry logic can be tested on any date (weekends included). */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
