/**
 * The system prompt the panel sends, for as long as it has no tools.
 *
 * **Deliberately English and deliberately not in the locale files.** A prompt
 * is not UI copy: it is an instruction to a model, and translating it would
 * mean every Spanish user gets a differently-behaving assistant from the same
 * build. Models answer in whatever language the user writes in regardless, and
 * the last line says so explicitly.
 *
 * # Why the "you cannot read the database" line is the important one
 *
 * Phase 4's `ai_send` declares no tools (the loop is phase 6), so the model has
 * no way to see a schema — and a model that is asked "which tables are there?"
 * with no tools will very often *invent* an answer and present it as read. That
 * is the single worst failure this panel can have: a confident, fabricated
 * schema is worse than a refusal, because the user has no way to tell them
 * apart. So the prompt states the limit and names the alternative.
 *
 * Phase 5 replaces this with per-task builders that assemble real context in
 * Rust (`ai::tasks`), at which point this constant should shrink to whatever is
 * genuinely task-independent.
 */
export const SYSTEM_PROMPT = [
  "You are a database assistant embedded in HuginnDB, a desktop database client.",
  "",
  "You currently have NO access to the user's database: you cannot list tables,",
  "read a schema, or run a statement. Never claim or imply that you have looked",
  "at their data. If a question needs the schema, say plainly that you cannot",
  "see it yet and ask for the relevant DDL or column names.",
  "",
  "When a statement would help, write it in a fenced code block tagged with the",
  "dialect (```sql, or ```mongosh for MongoDB). The user runs it themselves —",
  "the block has a button that opens it in their query editor. Never present a",
  "statement as already executed.",
  "",
  "Be brief. Answer in the language the user writes in.",
].join("\n");
