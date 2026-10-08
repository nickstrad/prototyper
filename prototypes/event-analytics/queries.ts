// The event analytics aggregate queries (R6), plain DuckDB SQL shared by the
// application (application.ts) and the browser specs, which type the same text
// into the upstream shell. No imports: Playwright specs load this directly.

/**
 * The aggregate queries, one line each so they can be typed into the shell
 * verbatim. Counts are BIGINT; revenue is DECIMAL(18,2); conversion is a
 * DECIMAL(9,1) percentage (NULL when a country has no page views).
 */
export const AGGREGATE_SQL = {
  totals:
    "SELECT count(*) AS events, count(*) FILTER (WHERE kind = 'page_view') AS views, count(*) FILTER (WHERE kind = 'signup') AS signups, CAST(coalesce(sum(revenue), 0) AS DECIMAL(18, 2)) AS revenue FROM events",
  eventsPerDay:
    "SELECT occurred_on AS day, count(*) FILTER (WHERE kind = 'page_view') AS views, count(*) FILTER (WHERE kind = 'signup') AS signups FROM events GROUP BY occurred_on ORDER BY occurred_on",
  topSources:
    "SELECT source, count(*) AS events, count(*) FILTER (WHERE kind = 'signup') AS signups, CAST(coalesce(sum(revenue), 0) AS DECIMAL(18, 2)) AS revenue FROM events GROUP BY source ORDER BY events DESC, source",
  conversionByCountry:
    "SELECT country, count(*) FILTER (WHERE kind = 'page_view') AS views, count(*) FILTER (WHERE kind = 'signup') AS signups, CAST(round(100.0 * count(*) FILTER (WHERE kind = 'signup') / nullif(count(*) FILTER (WHERE kind = 'page_view'), 0), 1) AS DECIMAL(9, 1)) AS conversion_pct FROM events GROUP BY country ORDER BY country",
} as const;
