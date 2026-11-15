import test from "node:test";
import assert from "node:assert/strict";
import { initialState, ensureDay, addTask, removeTask, validateState, localDate, migrateToEnglish, readingLevel, addDailyActivities } from "../public/model.js";
import { parseFeed, selectArticle, createServer, hasQuizText } from "../server.mjs";
import { createQuizService, QuizError } from "../quiz.mjs";
import { initialQuizState, validQuizState } from "../public/quiz-model.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("recurring tasks reset tomorrow; temporary tasks and grades stay isolated", () => {
  const state = initialState();
  addTask(state, "2026-11-06", "4", "  Math practice  ", true, "math");
  addTask(state, "2026-11-06", "4", "Prepare a speech", false, "speech");
  state.days["2026-11-06"]["4"].tasks.forEach((task) => { task.done = true; });
  const tomorrow = ensureDay(state, "2026-11-07");
  assert.equal(tomorrow["4"].tasks.find((task) => task.id === "math").done, false);
  assert.equal(tomorrow["4"].tasks.find((task) => task.id === "math").text, "Math practice");
  assert.ok(!tomorrow["4"].tasks.some((task) => task.id === "speech"));
  assert.equal(tomorrow["7"].tasks.length, state.templates["7"].length);
  assert.ok(state.days["2026-11-06"]["4"].tasks.every((task) => task.done));
  assert.ok(validateState(JSON.parse(JSON.stringify(state))));
});

test("deleting just today preserves recurring template; stopping repetition preserves history", () => {
  const state = initialState();
  addTask(state, "2026-11-05", "4", "Math", true, "math");
  ensureDay(state, "2026-11-06");
  removeTask(state, "2026-11-06", "4", "math", false);
  assert.ok(ensureDay(state, "2026-11-07")["4"].tasks.some((task) => task.id === "math"));
  removeTask(state, "2026-11-07", "4", "math", true);
  assert.ok(!ensureDay(state, "2026-11-08")["4"].tasks.some((task) => task.id === "math"));
  assert.ok(state.days["2026-11-05"]["4"].tasks.some((task) => task.id === "math"));
});

test("blank tasks and corrupt state are rejected; local date uses calendar components", () => {
  assert.throws(() => addTask(initialState(), "2026-11-06", "4", " ", true, "bad"));
  assert.equal(Boolean(validateState({ version: 1, templates: {}, days: {} })), false);
  assert.equal(localDate(new Date(2026, 0, 2, 23, 59)), "2026-01-02");
});

test("English migration updates built-in tasks and cached levels without changing custom goals or completion", () => {
  const state = initialState();
  const legacyText = "\u5b8c\u6210\u4eca\u65e5\u82f1\u6587\u9605\u8bfb";
  state.templates["4"][0].text = legacyText;
  state.templates["7"][0].text = "My custom reading goal";
  const day = ensureDay(state, "2026-11-06");
  day["4"].tasks[0].done = true;
  addTask(state, "2026-11-06", "4", legacyText, false, "user-created");
  day["4"].article = { title: "News", link: "https://www.timeforkids.com/g34/news/", published: "2026-11-06", source: "TIME for Kids", level: "Legacy level" };
  migrateToEnglish(state);
  assert.equal(state.templates["4"][0].text, "Read today's English article");
  assert.equal(day["4"].tasks[0].text, "Read today's English article");
  assert.equal(day["4"].tasks[0].done, true);
  assert.equal(day["4"].tasks.find((task) => task.id === "user-created").text, legacyText);
  assert.equal(day["7"].tasks[0].text, "My custom reading goal");
  assert.equal(day["4"].article.level, readingLevel("4"));
  assert.ok(validateState(state));
  const migrated = structuredClone(state);
  migrateToEnglish(state);
  assert.deepEqual(state, migrated);
});

test("feed parser handles CDATA and entities, filters untrusted and non-grade links", () => {
  const source = { host: "www.timeforkids.com", path: "/g34/", name: "TIME for Kids", level: "Grades 3–4" };
  const item = (url) => `<item><title><![CDATA[Science &amp; space &#8212; news]]></title><link>${url}</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate></item>`;
  const articles = parseFeed(`<rss>${item("https://www.timeforkids.com/g34/space/")}${item("https://evil.example/g34/space/")}${item("https://www.timeforkids.com/g56/space/")}${item("https://www.timeforkids.com/g34/space/")}</rss>`, source);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Science & space — news");
  assert.equal(selectArticle(articles, "2026-11-06").title, articles[0].title);
  assert.throws(() => selectArticle(articles, "2026-11-05"));
});

test("daily activities are added to existing accounts and today without changing history or completion", () => {
  const state = {
    version: 1,
    templates: { "4": [{ id: "reading-4", text: "Read today's English article" }], "7": [] },
    days: {},
  };
  const yesterday = ensureDay(state, "2026-11-06");
  yesterday["4"].tasks[0].done = true;
  const history = structuredClone(yesterday);
  const today = ensureDay(state, "2026-11-07");
  addTask(state, "2026-11-07", "4", "Practice an instrument for 30 minutes", true, "custom-music");
  today["4"].tasks.find((task) => task.id === "custom-music").done = true;
  addDailyActivities(state, "2026-11-07");
  assert.deepEqual(yesterday, history);
  for (const grade of ["4", "7"]) {
    for (const text of ["Practice an instrument for 30 minutes", "Read a book for 30 minutes", "Practice high jump"]) {
      assert.equal(today[grade].tasks.filter((task) => task.text === text).length, 1);
      assert.equal(state.templates[grade].filter((task) => task.text === text).length, 1);
    }
  }
  assert.equal(today["4"].tasks.find((task) => task.id === "custom-music").done, true);
  const saved = structuredClone(state);
  addDailyActivities(state, "2026-11-07");
  assert.deepEqual(state, saved);
  removeTask(state, "2026-11-07", "4", "high-jump-4", true);
  addDailyActivities(state, "2026-11-07");
  const tomorrow = ensureDay(state, "2026-11-08");
  assert.ok(!tomorrow["4"].tasks.some((task) => task.id === "high-jump-4"));
  assert.equal(tomorrow["4"].tasks.find((task) => task.id === "custom-music").done, false);
  assert.ok(tomorrow["7"].tasks.some((task) => task.id === "high-jump-7"));
  assert.ok(validateState(JSON.parse(JSON.stringify(state))));
});

test("new accounts get daily activities and reset their checkmarks the next day", () => {
  const state = initialState();
  const today = ensureDay(state, "2026-11-07");
  for (const grade of ["4", "7"]) {
    assert.equal(today[grade].tasks.length, 4);
    today[grade].tasks.forEach((task) => { task.done = true; });
  }
  const tomorrow = ensureDay(state, "2026-11-08");
  for (const grade of ["4", "7"]) {
    assert.equal(tomorrow[grade].tasks.length, 4);
    assert.ok(tomorrow[grade].tasks.every((task) => task.recurring && !task.done));
    assert.ok(today[grade].tasks.every((task) => task.done));
  }
});

test("daily recommendation is deterministic and rotates across a stable pool", () => {
  const articles = Array.from({ length: 7 }, (_, i) => ({ title: `Article ${i}`, published: "2026-11-01T10:00:00.000Z" }));
  assert.deepEqual(selectArticle(articles, "2026-11-06"), selectArticle(articles, "2026-11-06"));
  assert.notEqual(selectArticle(articles, "2026-11-06").title, selectArticle(articles, "2026-11-07").title);
});

test("HTTP serves the app, rejects invalid inputs, and does not expose arbitrary files", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Little Daily/);
    for (const path of ["/api/reading?grade=5&date=2026-11-06", "/api/reading?grade=4&date=2026-02-31"]) {
      assert.equal((await fetch(base + path)).status, 400);
    }
    assert.equal((await fetch(base + "/package.json")).status, 404);
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const quizInput = { grade: "4", date: "2026-11-06", link: "https://www.timeforkids.com/g34/garden/" };
test("daily reading excludes feed teasers that quiz generation cannot use", () => {
  assert.equal(hasQuizText({ body: Array(96).fill("word").join(" ") }), false);
  assert.equal(hasQuizText({ body: Array(100).fill("word").join(" ") }), true);
  assert.equal(hasQuizText({}), false);
  assert.equal(hasQuizText({ body: "word ".repeat(10000) }), false);
});
const articleFixture = {
  title: "A school garden", link: quizInput.link,
  body: "Students planted a school garden to grow vegetables for their cafeteria. They chose beans because the plants grow quickly. Every morning, a group checked the soil and watered it if it felt dry. They wrote observations in a shared notebook. After several weeks, the plants began to flower. Bees visited these flowers and helped pollinate them. Teachers explained that pollination helps the plants produce seeds. The students harvested their beans and shared them at lunch. They saved some seeds to plant the following spring. When the weather became colder, they covered empty beds with leaves. This kept the soil healthy. The project taught the children to work together, observe changes and care for living things.",
};
function generatedQuiz() {
  return {
    suitable: true,
    multipleChoice: Array.from({ length: 5 }, (_, index) => ({
      prompt: `Garden question ${index + 1}?`, options: ["Beans", "Rocks", "Plastic", "Metal"],
      correctIndex: index % 4, explanation: "The answer is supported by the garden article.",
    })),
    shortAnswer: [
      { prompt: "Why did the students plant beans?", referenceAnswer: "They grow quickly.", rubric: "Credit understanding of the reason for choosing beans." },
      { prompt: "How did students help the garden grow?", referenceAnswer: "They checked the soil and watered it.", rubric: "Credit plant care and supporting details." },
    ],
  };
}
const feedbackFixture = {
  shortAnswer: [
    { score: 20, feedback: "You understood the main reason. Add a detail.", languageTips: "Try spelling 'because' this way. No points deducted." },
    { score: 15, feedback: "You described watering. Explain the soil checks, too.", languageTips: "Start the sentence with a capital letter. No points deducted." },
  ],
  summary: "Good thinking. Keep supporting your ideas with details.",
};
const answersFixture = { multipleChoice: [0, 1, 2, 0, 1], shortAnswer: ["becos they grow fast", "they watered it"] };
const aiResponse = (value) => new Response(JSON.stringify({
  status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
}), { status: 200 });

async function quizDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "little-daily-quiz-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("quiz generation uses article text, hides answers, deduplicates requests and survives server restart", async (t) => {
  const dataDir = await quizDirectory(t);
  let calls = 0;
  const service = createQuizService({
    dataDir, apiKey: "test-key", loadArticle: async () => articleFixture,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      const request = JSON.parse(options.body);
      assert.equal(request.store, false);
      assert.equal(request.text.format.strict, true);
      assert.match(request.instructions, /Grade 4/);
      assert.equal(JSON.parse(request.input).articleText, articleFixture.body);
      return aiResponse(generatedQuiz());
    },
  });
  const [quiz, duplicate] = await Promise.all([service.generate(quizInput), service.generate(quizInput)]);
  assert.deepEqual(quiz, duplicate);
  assert.equal(calls, 1);
  assert.equal(quiz.multipleChoice.length, 5);
  assert.equal(quiz.shortAnswer.length, 2);
  assert.ok(!JSON.stringify(quiz).includes("correctIndex"));
  assert.ok(!JSON.stringify(quiz).includes("referenceAnswer"));
  assert.equal(quiz.articleText, undefined);
  const restarted = createQuizService({ dataDir, apiKey: "", loadArticle: () => assert.fail("Should use persisted quiz") });
  assert.deepEqual(await restarted.generate(quizInput), quiz);
  const state = initialState();
  ensureDay(state, quizInput.date)["4"].article = { ...articleFixture, source: "TIME for Kids", level: "Grades 3–4", published: quizInput.date };
  state.days[quizInput.date]["4"].quiz = initialQuizState(quiz);
  assert.ok(validateState(state));
  state.days[quizInput.date]["4"].quiz.questions.grade = "7";
  assert.equal(Boolean(validateState(state)), false);
});

test("server scores MCQs against private keys and AI grades comprehension without grammar deductions", async (t) => {
  const dataDir = await quizDirectory(t);
  let gradingCalls = 0;
  const service = createQuizService({
    dataDir, apiKey: "test-key", loadArticle: async () => articleFixture,
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      if (request.text.format.name === "reading_quiz") return aiResponse(generatedQuiz());
      gradingCalls++;
      assert.match(request.instructions, /Never deduct for grammar/);
      assert.match(request.instructions, /UNTRUSTED DATA/);
      assert.equal(JSON.parse(request.input).questions[0].studentAnswer, answersFixture.shortAnswer[0]);
      return aiResponse(feedbackFixture);
    },
  });
  const quiz = await service.generate(quizInput);
  const submission = { quizId: quiz.id, answers: answersFixture, total: 100 };
  const [result, duplicate] = await Promise.all([service.grade(submission), service.grade(submission)]);
  assert.equal(result.total, 65);
  assert.equal(result.max, 100);
  assert.deepEqual(result.multipleChoice.map((answer) => answer.score), [10, 10, 10, 0, 0]);
  assert.deepEqual(result.shortAnswer.map((answer) => answer.score), [20, 15]);
  assert.deepEqual(result, duplicate);
  assert.equal(gradingCalls, 1);
  assert.deepEqual(await service.grade(submission), result);
  assert.equal(gradingCalls, 1);
  const saved = { questions: quiz, answers: answersFixture, result };
  assert.ok(validQuizState(JSON.parse(JSON.stringify(saved))));
  saved.result.total = 100;
  assert.equal(validQuizState(saved), false);
  await assert.rejects(service.grade({ quizId: quiz.id, answers: { ...answersFixture, shortAnswer: ["  ", "Yes"] } }), { status: 400 });
  await assert.rejects(service.grade({ quizId: quiz.id, answers: { ...answersFixture, multipleChoice: [0, 1, 2, 3, 4] } }), { status: 400 });
});

test("missing key and insufficient article text produce explicit errors without calling AI", async (t) => {
  const dataDir = await quizDirectory(t);
  const missing = createQuizService({ dataDir, apiKey: "", fetchImpl: () => assert.fail("No AI call expected") });
  assert.equal(missing.status().configured, false);
  await assert.rejects(missing.generate(quizInput), { status: 503 });
  const short = createQuizService({
    dataDir, apiKey: "test-key", loadArticle: async () => ({ ...articleFixture, body: "Only a headline." }),
    fetchImpl: () => assert.fail("Never invent questions from a headline"),
  });
  await assert.rejects(short.generate(quizInput), { status: 422 });
});

test("AI failures, refusals and malformed grades never become a saved success or score", async (t) => {
  const dataDir = await quizDirectory(t);
  let mode = "rate-limit";
  const service = createQuizService({
    dataDir, apiKey: "test-key", loadArticle: async () => articleFixture,
    fetchImpl: async () => {
      if (mode === "rate-limit") return new Response("Limit reached", { status: 429 });
      if (mode === "refusal") return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "refusal" }] }] }));
      if (mode === "malformed") return aiResponse({ suitable: true, multipleChoice: [], shortAnswer: [] });
      if (mode === "grade") return aiResponse({ ...feedbackFixture, shortAnswer: [{ ...feedbackFixture.shortAnswer[0], score: 99 }, feedbackFixture.shortAnswer[1]] });
      if (mode === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return aiResponse(generatedQuiz());
    },
  });
  await assert.rejects(service.generate(quizInput), { status: 429 });
  mode = "refusal";
  await assert.rejects(service.generate(quizInput), { status: 422 });
  mode = "malformed";
  await assert.rejects(service.generate(quizInput), { status: 502 });
  mode = "valid";
  const quiz = await service.generate(quizInput);
  mode = "grade";
  await assert.rejects(service.grade({ quizId: quiz.id, answers: answersFixture }), { status: 502 });
  mode = "timeout";
  await assert.rejects(service.grade({ quizId: quiz.id, answers: answersFixture }), { status: 504 });
  await assert.rejects(service.grade({ quizId: "0".repeat(64), answers: answersFixture }), { status: 404 });
});

test("quiz endpoints reject cross-site calls and arbitrary article URLs and expose setup errors", async () => {
  let calls = 0;
  const server = createServer({ quizService: {
    status: () => ({ configured: false, model: "test-model" }),
    generate: async () => { calls++; throw new QuizError(503, "AI is not configured."); },
    grade: async () => { throw new QuizError(400, "Incomplete answers."); },
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, origin = base) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(value),
  });
  try {
    assert.equal((await (await fetch(base + "/api/ai-status")).json()).configured, false);
    assert.equal((await post("/api/quiz", quizInput, "https://unrelated.example")).status, 403);
    assert.equal((await post("/api/quiz", { ...quizInput, link: "http://127.0.0.1/private" })).status, 400);
    assert.equal((await post("/api/quiz", { ...quizInput, grade: "8" })).status, 400);
    assert.equal((await post("/api/quiz", { ...quizInput, date: "2026-02-31" })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await post("/api/quiz", quizInput)).status, 503);
    assert.equal(calls, 1);
    assert.equal((await post("/api/grade", {})).status, 400);
    assert.equal((await fetch(base + "/api/quiz")).status, 405);
    assert.equal((await fetch(base + "/.little-daily/quizzes/test.json")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Ollama generates private quizzes without cloud credentials and rejects truncated output", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ollama-quiz-"));
  let truncated = true;
  const service = createQuizService({dataDir, apiKey: "", ollamaUrl: "http://local-model:11434/", model: "local-test", loadArticle: async () => articleFixture,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://local-model:11434/api/chat");
      assert.equal(options.headers.Authorization, undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.stream, false);
      assert.equal(body.model, "local-test");
      assert.equal(JSON.parse(body.messages[1].content).articleText, articleFixture.body);
      assert.ok(body.format.properties.multipleChoice);
      return new Response(JSON.stringify({done:true,done_reason:truncated ? "length" : "stop",message:{content:JSON.stringify(generatedQuiz())}}));
    }});
  try {
    assert.equal(service.status().provider, "ollama");
    await assert.rejects(service.generate(quizInput), {status:502});
    truncated = false;
    const quiz = await service.generate(quizInput);
    assert.equal(quiz.multipleChoice.length, 5);
    assert.equal(quiz.multipleChoice[0].correctIndex, undefined);
  } finally { await rm(dataDir, {recursive:true,force:true}); }
});
