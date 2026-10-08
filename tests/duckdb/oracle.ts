// Independent oracle for the event analytics aggregates (R6): the same
// numbers as prototypes/event-analytics/application.ts's AGGREGATE_SQL,
// computed in plain TypeScript from the seed rows (money in integer cents,
// so the decimal text is exact). Used by the native tests and the browser
// specs to check what the panel and the shell show.
import type { SeedEvent } from "../../prototypes/event-analytics/seed.ts";

type Row = Pick<
  SeedEvent,
  "day" | "kind" | "country" | "source" | "revenue"
>;

export const cents = (revenue: string | null): number => {
  if (revenue === null) return 0;
  const negative = revenue.startsWith("-");
  const [whole, frac = ""] = revenue.replace(/^-/, "").split(".");
  const c = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
  return negative ? -c : c;
};
/** Exact decimal text of integer cents, e.g. -550 -> "-5.50". */
export const money = (c: number): string => {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(abs / 100)}.${
    String(abs % 100).padStart(2, "0")
  }`;
};

/** DuckDB's `CAST(round(100.0 * s / v, 1) AS DECIMAL(9, 1))`. */
export const conversionPct = (signups: number, views: number): string | null =>
  views === 0 ? null : (Math.round((100 * signups / views) * 10) / 10)
    .toFixed(1);

export type ExpectedOverview = {
  totals: { events: number; views: number; signups: number; revenue: string };
  perDay: { day: string; views: number; signups: number }[];
  sources: {
    source: string;
    events: number;
    signups: number;
    revenue: string;
  }[];
  countries: {
    country: string;
    views: number;
    signups: number;
    conversionPct: string | null;
  }[];
};

const group = <K extends string>(rows: readonly Row[], key: (r: Row) => K) => {
  const out = new Map<K, Row[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
};
const views = (rows: readonly Row[]) =>
  rows.filter((r) => r.kind === "page_view").length;
const signups = (rows: readonly Row[]) =>
  rows.filter((r) => r.kind === "signup").length;
const revenue = (rows: readonly Row[]) =>
  money(rows.reduce((n, r) => n + cents(r.revenue), 0));

/** What the panel shows for `rows` (top 5 sources, as the panel). */
export const expectedOverview = (rows: readonly Row[]): ExpectedOverview => ({
  totals: {
    events: rows.length,
    views: views(rows),
    signups: signups(rows),
    revenue: revenue(rows),
  },
  perDay: [...group(rows, (r) => r.day)].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([day, rs]) => ({ day, views: views(rs), signups: signups(rs) })),
  sources: [...group(rows, (r) => r.source)]
    .map(([source, rs]) => ({
      source,
      events: rs.length,
      signups: signups(rs),
      revenue: revenue(rs),
    }))
    .sort((a, b) => b.events - a.events || (a.source < b.source ? -1 : 1))
    .slice(0, 5),
  countries: [...group(rows, (r) => r.country)].sort(([a], [b]) =>
    a < b ? -1 : 1
  ).map(([country, rs]) => ({
    country,
    views: views(rs),
    signups: signups(rs),
    conversionPct: conversionPct(signups(rs), views(rs)),
  })),
});
