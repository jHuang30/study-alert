import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readingLevel } from "./public/model.js";
import { createQuizService, QuizError } from "./quiz.mjs";

const sources = {
  4: { name: "TIME for Kids", feed: "https://www.timeforkids.com/g34/feed/", host: "www.timeforkids.com", level: readingLevel("4"), path: "/g34/" },
  7: { name: "Science News Explores", feed: "https://www.snexplores.org/feed", host: "www.snexplores.org", level: readingLevel("7"), path: "/article/" },
};
const cache = new Map();
const pending = new Map();

function text(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      if (entity.startsWith("#")) {
        const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()] ?? whole;
    }).replace(/\s+/g, " ").trim();
}

export function parseFeed(xml, source) {
  const articles = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const field = (name) => text(match[1].match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? "");
    const title = field("title");
    const link = field("link");
    const published = Date.parse(field("pubDate"));
    let url;
    try { url = new URL(link); } catch { continue; }
    if (!title || !Number.isFinite(published) || url.protocol !== "https:" || url.hostname !== source.host ||
        !url.pathname.startsWith(source.path) || url.username || url.password || url.port) continue;
    if (!articles.some((article) => article.link === link)) {
      articles.push({ title, link, published: new Date(published).toISOString(), source: source.name, level: source.level, body: field("content:encoded") });
    }
  }
  return articles.sort((a, b) => b.published.localeCompare(a.published));
}

async function loadArticles(grade) {
  const cached = cache.get(grade);
  if (cached && Date.now() - cached.at < 3600000) return cached.articles;
  if (pending.has(grade)) return pending.get(grade);
  const request = (async () => {
    const source = sources[grade];
    const response = await fetch(source.feed, { signal: AbortSignal.timeout(12000), headers: { Accept: "application/rss+xml" } });
    if (!response.ok) throw new Error(`News source returned HTTP ${response.status}`);
    const articles = parseFeed(await response.text(), source);
    if (!articles.length) throw new Error("News feed contained no eligible articles");
    cache.set(grade, { at: Date.now(), articles });
    return articles;
  })();
  pending.set(grade, request);
  try { return await request; } finally { pending.delete(grade); }
}

export function selectArticle(articles, date) {
  const eligible = articles.filter((article) => article.published.slice(0, 10) <= date).slice(0, 7);
  if (!eligible.length) throw new Error("No article available for this date");
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return eligible[day % eligible.length];
}

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/model.js", ["model.js", "text/javascript"]],
  ["/quiz.js", ["quiz.js", "text/javascript"]],
  ["/quiz-model.js", ["quiz-model.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

async function readJSON(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new QuizError(415, "Send quiz requests as JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20000) throw new QuizError(413, "The submitted answers are too long.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid object");
    return body;
  } catch { throw new QuizError(400, "The quiz request is not valid JSON."); }
}

export function createServer({ quizService } = {}) {
  const quizzes = quizService ?? createQuizService({
    loadArticle: async (grade, link) => {
      let articles;
      try { articles = await loadArticles(grade); }
      catch { throw new QuizError(502, "The news source could not be reached. Please try again later."); }
      const article = articles.find((item) => item.link === link);
      if (!article) throw new QuizError(422, "This article is no longer in the publisher's feed. We cannot generate a reliable quiz without its text.");
      return article;
    },
  });
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    try {
      const host = req.headers.host;
      const allowedHosts = (process.env.ALLOWED_HOSTS || "").split(",").map((value) => value.trim()).filter(Boolean);
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host ?? "") && !allowedHosts.includes(host)) {
        res.writeHead(403); res.end("Local access only"); return;
      }
      const url = new URL(req.url, "http://localhost");
      const json = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/quiz" || url.pathname === "/api/grade") {
        try {
          if (req.method !== "POST") throw new QuizError(405, "Use POST for quiz requests.");
          if (req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") {
            throw new QuizError(403, "Quiz requests must come from this website.");
          }
          const body = await readJSON(req);
          if (url.pathname === "/api/quiz") {
            const source = sources[body.grade];
            let link;
            try { link = new URL(body.link); } catch { throw new QuizError(400, "Invalid article link."); }
            if (!["4", "7"].includes(body.grade) || !validDate(body.date) || link.protocol !== "https:" ||
                link.hostname !== source.host || !link.pathname.startsWith(source.path) || link.port || link.username || link.password ||
                link.search || link.hash) throw new QuizError(400, "Invalid grade, date or article source.");
            json(200, await quizzes.generate({ grade: body.grade, date: body.date, link: link.href }));
          } else {
            json(200, await quizzes.grade(body));
          }
        } catch (error) {
          console.error("Quiz request failed:", error instanceof QuizError ? error.message : error.name);
          json(error instanceof QuizError ? error.status : 500, {
            error: error instanceof QuizError ? error.message : "An unexpected quiz error occurred. Your answers have not been graded. Please try again.",
          });
        }
        return;
      }
      if (req.method !== "GET") { res.writeHead(405); res.end("Method not allowed"); return; }
      if (url.pathname === "/api/ai-status") { json(200, quizzes.status()); return; }
      if (url.pathname === "/api/reading") {
        const grade = url.searchParams.get("grade");
        const date = url.searchParams.get("date");
        if (!Object.hasOwn(sources, grade ?? "") || !validDate(date)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid grade or date." })); return;
        }
        try {
          const article = selectArticle(await loadArticles(grade), date);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(article));
        } catch (error) {
          console.error("Reading feed failed:", error.message);
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "News is temporarily unavailable. Check your connection and try again." }));
        }
        return;
      }
      const file = files.get(url.pathname);
      if (!file) { res.writeHead(404); res.end("Not found"); return; }
      const content = await readFile(new URL(`public/${file[0]}`, import.meta.url));
      res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
      res.end(content);
    } catch (error) {
      console.error("Request failed:", error);
      res.writeHead(500); res.end("Internal server error");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, process.env.HOST || "127.0.0.1", () => console.log(`Little Daily is ready: http://localhost:${port}`));
}
