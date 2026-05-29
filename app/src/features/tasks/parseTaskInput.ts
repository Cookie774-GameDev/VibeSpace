import {
  addDays,
  addHours,
  addMinutes,
  isBefore,
  nextFriday,
  nextMonday,
  nextSaturday,
  nextSunday,
  nextThursday,
  nextTuesday,
  nextWednesday,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
} from 'date-fns';
import type { TaskInput, TaskPriority } from '@/types/task';

/**
 * Quick natural-language task parser.
 *
 * Examples:
 *   "buy milk tomorrow 9am urgent #errand"
 *      -> { title: 'buy milk', due_at: <tomorrow 9am>, priority: 'urgent', context_tags: ['errand'] }
 *   "review PR #1234 due fri 4pm urgent #review"
 *      -> { title: 'review PR #1234', ... }   (numeric # stays in title)
 *   "in 2 hours stretch break"
 *      -> { title: 'stretch break', due_at: now+2h }
 *   "ping team tonight"
 *      -> { title: 'ping team', due_at: today 8pm }
 *
 * Strategy:
 *   1. Strip alphabetic tags (#word).  Numeric tokens like "#1234" stay (PR refs).
 *   2. Strip priority words.
 *   3. Find a relative offset ("in N units"); if found, return.
 *   4. Find a date phrase (today/tomorrow/tonight/dow/next dow).
 *   5. Find a time phrase (9am, noon, 14:00, etc.).
 *   6. Combine; default time = 9am for plain dates, 8pm for "tonight".
 *   7. Whatever remains becomes the title.
 *
 * The parser is heuristic, not perfect.  It's tuned to the speech patterns
 * users actually use when adding tasks ("buy milk tomorrow 9am").
 */
export function parseTaskInput(raw: string, now: number = Date.now()): TaskInput {
  const original = raw.trim();
  if (!original) {
    return { title: 'Untitled task', priority: 'normal', context_tags: [] };
  }

  // Pad with spaces so word-boundary regexes hit at the ends.
  let text = ` ${original} `;
  let dueAt: number | undefined;
  let priority: TaskPriority = 'normal';
  const tags: string[] = [];

  // ---- 1. tags (#alphanumeric, alphabetic-led so PR numbers stay in title)
  text = text.replace(/(\s)#([a-zA-Z][a-zA-Z0-9_-]{0,31})/g, (_m, sp, tag) => {
    tags.push(String(tag).toLowerCase());
    return sp;
  });

  // ---- 2. priority words
  const priorityPatterns: Array<[RegExp, TaskPriority]> = [
    [/\b(urgent|asap|critical)\b/i, 'urgent'],
    [/\b(high\s*priority|important)\b/i, 'high'],
    [/\b(low\s*priority|whenever|someday|eventually)\b/i, 'low'],
  ];
  for (const [re, p] of priorityPatterns) {
    if (re.test(text)) {
      priority = p;
      text = text.replace(re, ' ');
      break;
    }
  }

  // ---- 3-6. date / time
  const dt = extractDateTime(text, now);
  if (dt) {
    dueAt = dt.ts;
    text = dt.cleaned;
  }

  // ---- 7. clean title
  // Strip leading filler words ("at", "by", "due", "on") that cling to dates.
  const cleaned = text
    .replace(/\b(due|by|on|at)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const title = cleaned || original;

  const result: TaskInput = {
    title,
    priority,
    context_tags: tags,
  };
  if (dueAt !== undefined) result.due_at = dueAt;
  return result;
}

// ============================================================
// Internals
// ============================================================

const dowFns: Record<string, (d: Date) => Date> = {
  monday: nextMonday,
  mon: nextMonday,
  tuesday: nextTuesday,
  tue: nextTuesday,
  tues: nextTuesday,
  wednesday: nextWednesday,
  wed: nextWednesday,
  thursday: nextThursday,
  thu: nextThursday,
  thur: nextThursday,
  thurs: nextThursday,
  friday: nextFriday,
  fri: nextFriday,
  saturday: nextSaturday,
  sat: nextSaturday,
  sunday: nextSunday,
  sun: nextSunday,
};

const DOW_RE_SOURCE =
  '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)';

interface DTResult {
  ts: number;
  cleaned: string;
}

function combineDateTime(date: Date, hh: number, mm: number): Date {
  return setMilliseconds(setSeconds(setMinutes(setHours(date, hh), mm), 0), 0);
}

function extractDateTime(text: string, now: number): DTResult | null {
  // 3a. relative offset: "in 2 hours", "in 30 mins", "in 3 days"
  const relMatch = /\bin\s+(\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i.exec(text);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const base = new Date(now);
    let next: Date;
    if (unit.startsWith('min')) next = addMinutes(base, n);
    else if (unit.startsWith('hr') || unit.startsWith('hour')) next = addHours(base, n);
    else if (unit.startsWith('week')) next = addDays(base, n * 7);
    else next = addDays(base, n);
    return {
      ts: next.getTime(),
      cleaned: text.replace(relMatch[0], ' '),
    };
  }

  // 4. date phrase
  let cleaned = text;
  let baseDate: Date | null = null;
  let dateLabel: 'tonight' | 'tomorrow' | 'today' | 'next-dow' | 'dow' | null = null;

  const tonight = /\btonight\b/i.exec(cleaned);
  const tomorrow = !tonight && /\btomorrow\b/i.exec(cleaned);
  const today = !tonight && !tomorrow && /\btoday\b/i.exec(cleaned);
  const nextDow = !tonight && !tomorrow && !today && new RegExp(`\\bnext\\s+${DOW_RE_SOURCE}\\b`, 'i').exec(cleaned);
  const dow =
    !tonight &&
    !tomorrow &&
    !today &&
    !nextDow &&
    new RegExp(`\\b${DOW_RE_SOURCE}\\b`, 'i').exec(cleaned);

  if (tonight) {
    baseDate = combineDateTime(new Date(now), 20, 0);
    cleaned = cleaned.replace(tonight[0], ' ');
    dateLabel = 'tonight';
  } else if (tomorrow) {
    baseDate = addDays(new Date(now), 1);
    cleaned = cleaned.replace(tomorrow[0], ' ');
    dateLabel = 'tomorrow';
  } else if (today) {
    baseDate = new Date(now);
    cleaned = cleaned.replace(today[0], ' ');
    dateLabel = 'today';
  } else if (nextDow) {
    const fn = dowFns[nextDow[1].toLowerCase()];
    if (fn) {
      // "next monday" interpreted as "the upcoming monday after this week".
      // date-fns next* gives the next occurrence.  If that's within 6 days
      // and today < that occurrence's day-of-week offset, push another week.
      let candidate = fn(new Date(now));
      // Always add 7 days for "next <dow>" to disambiguate from plain "<dow>".
      candidate = addDays(candidate, 7);
      // Snap candidate's time to start of day.
      baseDate = combineDateTime(candidate, 9, 0);
      cleaned = cleaned.replace(nextDow[0], ' ');
      dateLabel = 'next-dow';
    }
  } else if (dow) {
    const fn = dowFns[dow[1].toLowerCase()];
    if (fn) {
      const candidate = fn(new Date(now));
      baseDate = combineDateTime(candidate, 9, 0);
      cleaned = cleaned.replace(dow[0], ' ');
      dateLabel = 'dow';
    }
  }

  // 5. time phrase
  let hh: number | null = null;
  let mm = 0;

  const noon = /\bnoon\b/i.exec(cleaned);
  const midnight = !noon && /\bmidnight\b/i.exec(cleaned);
  if (noon) {
    hh = 12;
    cleaned = cleaned.replace(noon[0], ' ');
  } else if (midnight) {
    hh = 0;
    cleaned = cleaned.replace(midnight[0], ' ');
  } else {
    const ampm = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i.exec(cleaned);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = ampm[2] ? parseInt(ampm[2], 10) : 0;
      const isPm = /^p/i.test(ampm[3]);
      if (h >= 0 && h <= 12 && m >= 0 && m <= 59) {
        if (isPm && h < 12) h += 12;
        else if (!isPm && h === 12) h = 0;
        hh = h;
        mm = m;
        cleaned = cleaned.replace(ampm[0], ' ');
      }
    } else {
      // 24-hour HH:MM (must be after 'at' or standalone)
      const t24 = /\b(?:at\s+)?(\d{1,2}):(\d{2})\b/.exec(cleaned);
      if (t24) {
        const h = parseInt(t24[1], 10);
        const m = parseInt(t24[2], 10);
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          hh = h;
          mm = m;
          cleaned = cleaned.replace(t24[0], ' ');
        }
      }
    }
  }

  // ---- 6. combine
  const timeApplied = hh !== null;
  if (!baseDate && !timeApplied) return null;

  if (!baseDate && timeApplied) {
    // Bare time -> today, or tomorrow if already past.
    let candidate = combineDateTime(new Date(now), hh!, mm);
    if (candidate.getTime() <= now) candidate = addDays(candidate, 1);
    return { ts: candidate.getTime(), cleaned };
  }

  if (baseDate && !timeApplied) {
    if (dateLabel === 'tonight') {
      // baseDate already 20:00 today
      return { ts: baseDate.getTime(), cleaned };
    }
    if (dateLabel === 'today') {
      // Default today reminder: 1 hour from now (rounded), or 9am if morning
      const d = new Date(now);
      const hour = d.getHours();
      const target = hour < 8 ? combineDateTime(new Date(now), 9, 0) : combineDateTime(new Date(now), Math.min(23, hour + 1), 0);
      return { ts: target.getTime(), cleaned };
    }
    // tomorrow / dow / next-dow default to 9am
    const final = combineDateTime(baseDate, 9, 0);
    return { ts: final.getTime(), cleaned };
  }

  if (baseDate && timeApplied) {
    let final = combineDateTime(baseDate, hh!, mm);
    // If date was "today" and time is already past, push to tomorrow.
    if (dateLabel === 'today' && isBefore(final, new Date(now))) {
      final = addDays(final, 1);
    }
    return { ts: final.getTime(), cleaned };
  }

  return null;
}
