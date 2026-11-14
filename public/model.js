export const grades = ["4", "7"];

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function initialState() {
  const state = {
    version: 1,
    templates: Object.fromEntries(grades.map((grade) => [grade, [
      { id: `reading-${grade}`, text: "Read today's English article" },
    ]])),
    days: {},
  };
  addDailyActivities(state);
  return state;
}

export function addDailyActivities(state, date) {
  if (state.dailyActivitiesAdded) return;
  for (const grade of grades) {
    for (const [name, text] of [
      ["instrument", "Practice an instrument for 30 minutes"],
      ["book", "Read a book for 30 minutes"],
      ["high-jump", "Practice high jump"],
    ]) {
      const id = `${name}-${grade}`;
      let template = state.templates[grade].find((task) => task.id === id || task.text === text);
      if (!template) {
        template = { id, text };
        state.templates[grade].push(template);
      }
      const tasks = state.days[date]?.[grade].tasks;
      if (tasks && !tasks.some((task) => task.id === template.id || task.text === text)) {
        tasks.push({ ...template, recurring: true, done: false });
      }
    }
  }
  state.dailyActivitiesAdded = true;
}

export function readingLevel(grade) {
  return grade === "4" ? "Publisher level: Grades 3–4" : "For middle school readers · Estimated Grade 7 fit";
}

export function migrateToEnglish(state) {
  const legacyTask = "\u5b8c\u6210\u4eca\u65e5\u82f1\u6587\u9605\u8bfb";
  for (const grade of grades) {
    const translateDefault = (task) => {
      if (task.id === `reading-${grade}` && task.text === legacyTask) task.text = "Read today's English article";
    };
    state.templates[grade].forEach(translateDefault);
    for (const day of Object.values(state.days)) {
      day[grade].tasks.forEach(translateDefault);
      if (day[grade].article) day[grade].article.level = readingLevel(grade);
    }
  }
  return state;
}

export function ensureDay(state, date) {
  if (!state.days[date]) {
    state.days[date] = Object.fromEntries(grades.map((grade) => [grade, {
      tasks: state.templates[grade].map((task) => ({ ...task, recurring: true, done: false })),
      article: null,
    }]));
  }
  return state.days[date];
}

export function addTask(state, date, grade, text, recurring, id) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 100) throw new Error("Goals must contain 1–100 characters.");
  const day = ensureDay(state, date);
  day[grade].tasks.push({ id, text: trimmed, recurring, done: false });
  if (recurring) state.templates[grade].push({ id, text: trimmed });
}

export function removeTask(state, date, grade, id, future) {
  const day = ensureDay(state, date);
  day[grade].tasks = day[grade].tasks.filter((task) => task.id !== id);
  if (future) state.templates[grade] = state.templates[grade].filter((task) => task.id !== id);
}

export function validateState(state) {
  const taskValid = (task) => task && typeof task.id === "string" && typeof task.text === "string" && task.text.trim().length > 0 && task.text.length <= 100;
  const articleValid = (article) => article === null || (
    article && ["title", "link", "published", "source", "level"].every((key) => typeof article[key] === "string") &&
    /^https:\/\//.test(article.link) && Number.isFinite(Date.parse(article.published))
  );
  return state?.version === 1 && state.templates && grades.every((grade) =>
    Array.isArray(state.templates[grade]) && state.templates[grade].every(taskValid)) &&
    state.days && typeof state.days === "object" && !Array.isArray(state.days) &&
    Object.entries(state.days).every(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      grades.every((grade) => Array.isArray(day?.[grade]?.tasks) &&
        day[grade].tasks.every((task) => taskValid(task) && typeof task.done === "boolean" && typeof task.recurring === "boolean") &&
        articleValid(day[grade].article) && validQuizState(day[grade].quiz) &&
        (!day[grade].quiz || (day[grade].quiz.questions.grade === grade &&
          day[grade].quiz.questions.date === date && day[grade].quiz.questions.article.link === day[grade].article?.link))));
}
import { validQuizState } from "./quiz-model.js";

