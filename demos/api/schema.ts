export const schema = `CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  url TEXT NOT NULL
)`;
export const seed = `INSERT INTO bookmarks(title, url) VALUES
  ('SQLite documentation', 'https://sqlite.org/docs.html'),
  ('Deno documentation', 'https://docs.deno.com/')`;
