import { createRoot } from "react-dom/client";
import {
  EventAnalyticsApp,
  type EventAnalyticsInstanceHooks,
} from "../../prototypes/event-analytics/App.tsx";
import { eventAnalyticsDuckDbLayer } from "../../prototypes/event-analytics/layer.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const layer = () =>
  eventAnalyticsDuckDbLayer({ name: "analytics-demo", persistence: "memory" });
const onHooks = (hooks: EventAnalyticsInstanceHooks | undefined) => {
  (window as Window & { __analytics?: EventAnalyticsInstanceHooks })
    .__analytics = hooks;
};
createRoot(document.getElementById("root")!).render(
  <main>
    <header>
      <a href="/demos/">Demo gallery</a>
      <p>PROTOTYPER / DUCKDB</p>
      <h1>Event analytics</h1>
      <p>
        Explore 360 seeded events across two weeks. SQL and the dashboard share
        one DuckDB database.
      </p>
      <p>Memory session · Reset restores the seed · Reload discards edits</p>
    </header>
    <EventAnalyticsApp layer={layer} onHooks={onHooks} />
    <aside>
      <h2>Try it in the Database view</h2>
      <p>
        <code>SELECT source, count(*) FROM events GROUP BY source;</code>
      </p>
      <p>
        <code>
          INSERT INTO events (occurred_on, kind, country, source, user_id,
          revenue) VALUES ('2026-09-15', 'signup', 'US', 'demo', 9001, 9.99);
        </code>
      </p>
      <p>
        The dashboard refreshes after a write. Reset to seed returns every
        aggregate to the seed.
      </p>
    </aside>
  </main>,
);
