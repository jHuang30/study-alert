const dayMs = 86400000;
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Weeks run Monday–Sunday. Works on YYYY-MM-DD strings so time zones never shift the day.
export function weekStart(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return toDate(ms - ((new Date(ms).getUTCDay() + 6) % 7) * dayMs);
}
export const addDays = (date, count) => toDate(Date.parse(`${date}T00:00:00Z`) + count * dayMs);

const round = (value) => Math.round(value * 10) / 10;

export function weekReport(state, grade, start, today) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index)).map((date) => {
    const record = state.days[date]?.[grade];
    const tasks = record?.tasks ?? [];
    const result = record?.quiz?.result ?? null;
    return {
      date, future: date > today, result,
      done: tasks.filter((task) => task.done).length, total: tasks.length,
      article: record?.article?.title ?? null, drafted: Boolean(record?.quiz && !result),
    };
  });
  const open = days.filter((day) => !day.future && day.total > 0);
  const graded = days.filter((day) => day.result);
  const mcRight = graded.reduce((sum, day) => sum + day.result.multipleChoice.filter((item) => item.score === 10).length, 0);
  const shorts = graded.flatMap((day) => day.result.shortAnswer.map((item) => item.score));
  const summary = {
    goalsDone: open.reduce((sum, day) => sum + day.done, 0),
    goalsTotal: open.reduce((sum, day) => sum + day.total, 0),
    quizzes: graded.length,
    expectedQuizzes: days.filter((day) => !day.future && (day.article || day.result)).length,
    average: graded.length ? round(graded.reduce((sum, day) => sum + day.result.total, 0) / graded.length) : null,
    mcAccuracy: graded.length ? mcRight / (graded.length * 5) : null,
    shortAverage: shorts.length ? round(shorts.reduce((sum, score) => sum + score, 0) / shorts.length) : null,
    tips: graded.flatMap((day) => day.result.shortAnswer.map((item) => item.languageTips)).filter((tip) => tip && !/^(none|n\/a)\b/i.test(tip)).slice(-3),
  };
  return { days, summary, advice: advice(summary, days) };
}

// Plain, rule-based suggestions so they stay consistent and need no AI call.
export function advice(summary, days) {
  const tips = [];
  if (!days.some((day) => !day.future && day.total > 0)) return ["No records yet this week."];
  if (summary.goalsTotal && summary.goalsDone / summary.goalsTotal < 0.7) {
    tips.push(`Daily goals: only ${summary.goalsDone} of ${summary.goalsTotal} were checked off. Pick a fixed time each day (for example after dinner) for the checklist.`);
  }
  if (summary.expectedQuizzes > summary.quizzes) {
    tips.push(`Reading quiz: ${summary.expectedQuizzes - summary.quizzes} day(s) with an article had no graded quiz. Try finishing the quiz right after reading while it is fresh.`);
  }
  if (summary.mcAccuracy !== null && summary.mcAccuracy < 0.7) {
    tips.push(`Multiple choice: ${Math.round(summary.mcAccuracy * 100)}% correct. Encourage re-reading the paragraph and finding the sentence that proves the answer before choosing.`);
  }
  if (summary.shortAverage !== null && summary.shortAverage < 15) {
    tips.push(`Short answers: averaging ${summary.shortAverage} / 25. Ask for a full answer with one detail from the article ("The article says…") and a reason.`);
  }
  if (summary.average !== null && summary.average >= 85 && !tips.length) {
    tips.push("Strong week. Consider reading a longer or harder article, or discussing one article aloud for a few minutes.");
  }
  if (!tips.length) tips.push("Steady week. Keep the daily routine going.");
  return tips;
}
