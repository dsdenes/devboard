/**
 * The one activity-delta rule both detached workers' dashboards use. A whole
 * replay replaces the log, a grown log appends, and a trimmed or rewritten log
 * is replayed; a streamed chunk continues the last line only while it is a
 * prefix extension of it.
 */

export interface AcpLikeActivity {
  text: string;
  append: boolean;
}

export type ActivityDelta =
  | { replay: true; entries: AcpLikeActivity[] }
  | { replay: false; entries: AcpLikeActivity[] };

export function activityDelta(previous: string[], activity: string[]): ActivityDelta {
  const replay = (): ActivityDelta => ({
    replay: true,
    entries: activity.map((text) => ({ text, append: false })),
  });
  if (activity.length === 0) return { replay: false, entries: [] };
  if (previous.length === 0) return replay();
  if (activity.length < previous.length) return replay();

  let prefix = 0;
  while (prefix < previous.length && prefix < activity.length && previous[prefix] === activity[prefix]) {
    prefix += 1;
  }
  if (prefix === previous.length) {
    return {
      replay: false,
      entries: activity.slice(prefix).map((text) => ({ text, append: false })),
    };
  }
  if (prefix === previous.length - 1) {
    const before = previous[prefix] ?? "";
    const after = activity[prefix] ?? "";
    if (after.startsWith(before)) {
      const entries: AcpLikeActivity[] = [];
      const extension = after.slice(before.length);
      if (extension.length > 0) entries.push({ text: extension, append: true });
      for (const text of activity.slice(previous.length)) entries.push({ text, append: false });
      return { replay: false, entries };
    }
  }
  return replay();
}
