/** Shared by the gallery and production HTML entry selection. */
export const demos = [
  {
    id: "cli",
    title: "Inventory",
    engine: "SQLite",
    views: "Terminal · Database",
  },
  { id: "api", title: "Bookmarks", engine: "SQLite", views: "API · Database" },
  {
    id: "web",
    title: "Notes",
    engine: "SQLite",
    views: "Application · Database",
  },
  {
    id: "combined",
    title: "Task manager",
    engine: "SQLite",
    views: "Application · Terminal · API · Database",
  },
  {
    id: "analytics",
    title: "Event analytics",
    engine: "DuckDB",
    views: "Application · Database",
  },
] as const;
