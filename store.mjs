import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { grades, validateState } from "./public/model.js";

const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const dateKey = /^\d{4}-\d{2}-\d{2}$/;

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const validStamp = (value) => typeof value === "string" && stamp.test(value) &&
  Number.isFinite(Date.parse(value)) && Date.parse(value) < Date.now() + 86400000;

// Each child has an independent profile keyed by grade ("4" or "7").
export function createStore(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS days (
      grade TEXT NOT NULL, date TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY (grade, date));
    CREATE TABLE IF NOT EXISTS templates (
      grade TEXT PRIMARY KEY, updated_at TEXT NOT NULL, templates TEXT NOT NULL);`);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

  const checkGrade = (grade) => { if (!grades.includes(grade)) throw new StoreError(400, "Unknown profile."); };
  const checkDate = (date) => {
    if (!dateKey.test(date ?? "") || new Date(date).toISOString().slice(0, 10) !== date) throw new StoreError(400, "Invalid date.");
  };
  const blank = { tasks: [], article: null };

  const statements = {
    summary: db.prepare("SELECT date, updated_at FROM days WHERE grade = ?"),
    templateStamp: db.prepare("SELECT updated_at FROM templates WHERE grade = ?"),
    templateGet: db.prepare("SELECT templates, updated_at FROM templates WHERE grade = ?"),
    dayGet: db.prepare("SELECT record FROM days WHERE grade = ? AND date = ?"),
    dayPut: db.prepare(`INSERT INTO days (grade, date, updated_at, record) VALUES (?, ?, ?, ?)
      ON CONFLICT (grade, date) DO UPDATE SET updated_at = excluded.updated_at, record = excluded.record
      WHERE excluded.updated_at > days.updated_at`),
    templatePut: db.prepare(`INSERT INTO templates (grade, updated_at, templates) VALUES (?, ?, ?)
      ON CONFLICT (grade) DO UPDATE SET updated_at = excluded.updated_at, templates = excluded.templates
      WHERE excluded.updated_at > templates.updated_at`),
  };

  return {
    summary(grade) {
      checkGrade(grade);
      return {
        templatesUpdatedAt: statements.templateStamp.get(grade)?.updated_at ?? null,
        days: Object.fromEntries(statements.summary.all(grade).map((row) => [row.date, row.updated_at])),
      };
    },
    read(grade, dates, withTemplates) {
      checkGrade(grade);
      const days = {};
      for (const date of dates.slice(0, 40)) {
        checkDate(date);
        const row = statements.dayGet.get(grade, date);
        if (row) days[date] = JSON.parse(row.record);
      }
      let templates = null;
      if (withTemplates) {
        const row = statements.templateGet.get(grade);
        if (row) templates = { templates: JSON.parse(row.templates), updatedAt: row.updated_at };
      }
      return { days, templates };
    },
    putDay(grade, date, record) {
      checkGrade(grade);
      checkDate(date);
      if (!record || typeof record !== "object" || !validStamp(record.updatedAt)) throw new StoreError(400, "Invalid record.");
      const candidate = { version: 1, templates: { 4: [], 7: [] }, days: { [date]: { 4: blank, 7: blank, [grade]: record } } };
      if (!validateState(candidate)) throw new StoreError(400, "Invalid record.");
      return statements.dayPut.run(grade, date, record.updatedAt, JSON.stringify(record)).changes > 0;
    },
    putTemplates(grade, templates, updatedAt) {
      checkGrade(grade);
      if (!validStamp(updatedAt)) throw new StoreError(400, "Invalid timestamp.");
      const candidate = { version: 1, templates: { 4: [], 7: [], [grade]: templates }, days: {} };
      if (!validateState(candidate)) throw new StoreError(400, "Invalid templates.");
      return statements.templatePut.run(grade, updatedAt, JSON.stringify(templates)).changes > 0;
    },
    close() { db.close(); },
  };
}
