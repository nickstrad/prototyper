# Event analytics

Open `/demos/analytics/` through the root dev server or static build. The app
reuses R6's analytics application and D2's DuckDB service. It renders totals,
events per day, top sources, and conversion by country over 360 deterministic
product events. Counts retain BIGINT precision; revenue uses decimal strings.

1. Read the dashboard, then click **Open database view**. This loads the real
   upstream DuckDB web shell against the dashboard's database.
2. Type `SELECT count(*) AS events FROM events;`. The shell reports 360.
3. Insert an event:

   ```sql
   INSERT INTO events (occurred_on, kind, country, source, user_id, revenue)
   VALUES ('2026-09-15', 'signup', 'US', 'demo', 9001, 9.99);
   ```

4. The dashboard now shows 361 events and another signup, with a new day in the
   table. Updates follow database change events.
5. Click **Reset to seed**. The dashboard and shell return to the seed.

The memory session is discarded on reload. Opening/hiding the Database view
keeps one shell binding; React teardown releases the shell before the DuckDB
worker. Only one upstream DuckDB shell can own a page at a time.

The root build bundles this entry and self-hosted assets. The static integration
tests block all external network requests and exercise the shell read, insert,
and reset path. Run `deno task test:static --workers 1` from the repository
root.
