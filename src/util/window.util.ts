export interface CallingHoursInput {
  now: Date;
  /** The booking's displayTimezone. The guard runs on the family's clock. */
  timeZone: string;
  /** Inclusive. Default 8. */
  startHour?: number;
  /** Exclusive. Default 21, so 20:59 is fine and 21:00 is not. */
  endHour?: number;
}

export interface CallingHoursResult {
  allowed: boolean;
  localHour: number;
  /** "2:00 AM", for the message the admin reads before overriding. */
  localLabel: string;
}

export const DEFAULT_CALL_HOURS_START = 8;
export const DEFAULT_CALL_HOURS_END = 21;

/**
 * Whether it is a decent hour to ring this family.
 *
 * An unknown timezone degrades to UTC rather than throwing. That can misjudge the
 * hour, which is why the caller surfaces the local time in the override prompt
 * instead of silently deciding for the admin.
 */
export function isWithinCallingHours(input: CallingHoursInput): CallingHoursResult {
  const startHour = input.startHour ?? DEFAULT_CALL_HOURS_START;
  const endHour = input.endHour ?? DEFAULT_CALL_HOURS_END;

  let zone = input.timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(input.now);
  } catch {
    zone = 'UTC';
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(input.now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  // hour12:false yields "24" for midnight in some ICU builds; fold it to 0.
  const localHour = Number(pick('hour')) % 24;
  const localMinute = pick('minute');

  const meridiem = localHour < 12 ? 'AM' : 'PM';
  const displayHour = localHour % 12 === 0 ? 12 : localHour % 12;

  return {
    allowed: localHour >= startHour && localHour < endHour,
    localHour,
    localLabel: `${displayHour}:${localMinute} ${meridiem}`,
  };
}
