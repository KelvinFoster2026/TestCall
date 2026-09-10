/**
 * How far out the sample booking sits, and what time of day it lands on.
 *
 * Three days and 4 PM because that is what an ordinary consult looks like. The
 * previous sample was a fixed instant that read as "Friday, September 4th, at
 * 11 PM Eastern", and a tester hearing that is judging the slot rather than the
 * script - the wording sounds broken because nobody books a consult at 11 PM.
 */
const SAMPLE_DAYS_AHEAD = 3;
const SAMPLE_HOUR = 16;

/** A zone Intl cannot resolve degrades to UTC rather than throwing. */
function resolveZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const PARTS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
} as const;

interface WallClock {
  year: number;
  month: number;
  day: number;
}

/**
 * The zone's offset from UTC at one instant, in milliseconds.
 *
 * Derived by reading the zone's own clock at that instant and treating it as
 * though it were UTC: the gap between the two IS the offset. Doing it this way
 * means DST is never hardcoded anywhere - Intl already knows when it changes.
 */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, ...PARTS }).formatToParts(at);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    // hour12:false yields 24 for midnight in some ICU builds; fold it to 0.
    pick('hour') % 24,
    pick('minute'),
    pick('second'),
  );
  return asUtc - at.getTime();
}

/** What day it is where the family is, which is not always what day it is here. */
function localDate(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * The instant at which the zone's clock reads the given wall time.
 *
 * Solved rather than computed: the offset depends on the answer, because the
 * answer is what decides which side of a DST change it falls on. Two passes
 * converge - the first lands within an hour, the second lands exactly.
 */
function utcForWallTime(wall: WallClock, hour: number, timeZone: string): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, hour);
  let instant = target;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = target - offsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/**
 * The booking a test call pretends to be about.
 *
 * Generated from `now` rather than fixed, so a rehearsal always reads out a
 * plausible upcoming slot instead of a date that has since gone by. Deliberately
 * not a real family's booking: the point of a rehearsal is to hear the voice and
 * the yes/no capture, and borrowing real details is how a rehearsal ends up
 * looking like a real answer.
 */
export function buildSampleConsultSlot(now: Date, timeZone: string): Date {
  const zone = resolveZone(timeZone);
  const today = localDate(now, zone);

  // Round-tripped through UTC so that adding days rolls the month and year over
  // for us, rather than producing a 34th of September.
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + SAMPLE_DAYS_AHEAD));
  const wall: WallClock = {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };

  return utcForWallTime(wall, SAMPLE_HOUR, zone);
}
