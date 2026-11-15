import { grades, localDate, initialState, ensureDay, addTask, removeTask, validateState, migrateToEnglish, addDailyActivities } from "./model.js";
import { createQuizPanel } from "./quiz.js";

const $ = (selector) => document.querySelector(selector);
const storageKey = "little-daily-v1";
let state;
let grade = "4";
let today = localDate();
let selectedDate = today;
let loading = new Set();
let errors = new Map();
let deleting = null;
let usable = true;
let quizPanel;

function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}

try {
  const saved = localStorage.getItem(storageKey);
  state = saved ? JSON.parse(saved) : initialState();
  if (!validateState(state)) throw new Error("Unrecognized saved data format");
  migrateToEnglish(state);
  addDailyActivities(state, today);
  ensureDay(state, today);
  localStorage.setItem(storageKey, JSON.stringify(state));
} catch (error) {
  usable = false;
  notice(`Unable to read or save your records: ${error.message}. Allow local storage in your browser, then refresh. Existing records will not be overwritten.`);
}

function update(mutate) {
  if (!usable) return false;
  try {
    const stored = localStorage.getItem(storageKey);
    const next = stored ? JSON.parse(stored) : structuredClone(state);
    if (!validateState(next)) throw new Error("Unrecognized saved data format. Please refresh the page");
    mutate(next);
    migrateToEnglish(next);
    if (!validateState(next)) throw new Error("The updated records are invalid. No changes were saved");
    localStorage.setItem(storageKey, JSON.stringify(next));
    state = next;
    notice("");
    return true;
  } catch (error) {
    notice(`Changes were not saved: ${error.message}. Check your browser's available storage and try again.`);
    return false;
  }
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function renderReading() {
  const container = $("#reading-content");
  container.replaceChildren();
  const article = state.days[selectedDate]?.[grade].article;
  const key = `${selectedDate}-${grade}`;
  if (article) {
    container.append(element("span", "source-label", article.source), element("h3", "article-title", article.title));
    container.append(element("p", "article-level", article.level));
    container.append(element("p", "muted article-date", `Published ${new Date(article.published).toLocaleDateString("en-US")} · A daily pick from recent stories`));
    const link = element("a", "read-link", "Read the original article ↗");
    link.href = article.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (article.body) {
      const reading = element("section", "article-text");
      reading.setAttribute("aria-label", "Article text");
      reading.append(element("p", "", article.body));
      container.append(reading);
    } else {
      container.append(element("p", "muted", errors.get(key) || "Loading article text…"));
    }
    container.append(link, element("p", "access-note", "Text supplied by the publisher's news feed. Visit the original for images and full formatting."));
  } else if (selectedDate !== today) {
    container.append(element("p", "muted", "No reading recommendation was saved for this day."));
  } else {
    container.append(element("p", "muted", errors.get(key) || "Finding today's news for you…"));
    if (errors.has(key)) {
      const retry = element("button", "read-link", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => loadReading(grade, selectedDate));
      container.append(retry);
    }
  }
  quizPanel?.render();
}

async function loadReading(targetGrade, date) {
  const key = `${date}-${targetGrade}`;
  const existing = state.days[date]?.[targetGrade];
  const enoughText = existing?.article?.body?.trim().split(/\s+/).length >= 100;
  if (!usable || date !== today || enoughText || existing?.quiz || loading.has(key)) return;
  loading.add(key);
  errors.delete(key);
  renderReading();
  try {
    const response = await fetch(`/api/reading?grade=${targetGrade}&date=${date}`, { signal: AbortSignal.timeout(20000) });
    const article = await response.json();
    if (!response.ok) throw new Error(article.error || "Unable to fetch news. Please try again.");
    const validHost = targetGrade === "4" ? "www.timeforkids.com" : "www.snexplores.org";
    const link = new URL(article.link);
    if (link.protocol !== "https:" || link.hostname !== validHost ||
        !["title", "source", "level", "published"].every((field) => typeof article[field] === "string") ||
        !Number.isFinite(Date.parse(article.published))) throw new Error("The news source returned invalid data.");
    if (!update((next) => {
      const day = ensureDay(next, date);
      if (!day[targetGrade].quiz) day[targetGrade].article = article;
    })) errors.set(key, "The article was fetched but could not be saved. Check your browser storage and try again.");
  } catch (error) {
    errors.set(key, `Unable to load your recommendation. ${error.message}`);
  } finally {
    loading.delete(key);
    renderReading();
  }
}

function render() {
  if (!usable) {
    document.querySelectorAll("input, button").forEach((node) => { node.disabled = true; });
    return;
  }
  const historical = selectedDate !== today;
  const day = state.days[selectedDate];
  const tasks = day?.[grade].tasks ?? [];
  const complete = tasks.filter((task) => task.done).length;
  const percent = tasks.length ? Math.round(complete / tasks.length * 100) : 0;
  const now = new Date();
  $("#weekday").textContent = now.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
  $("#date-label").textContent = now.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  $("#day-picker").max = today;
  $("#day-picker").value = selectedDate;
  $(".checklist h2").textContent = historical ? "That day's little goals" : "Today's little goals";
  $("#task-count").textContent = `${complete} / ${tasks.length}`;
  $("#progress-caption").textContent = tasks.length && complete === tasks.length ? "All done. Give yourself a high five!" : "One small step closer with every check";
  $("#progress-percent").textContent = `${percent}%`;
  $("#progress").value = percent;
  $("#add-form").hidden = historical;
  $("#history-note").hidden = !historical;
  for (const tab of document.querySelectorAll("[data-grade]")) {
    const active = tab.dataset.grade === grade;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $("#student-panel").setAttribute("aria-labelledby", `tab-${grade}`);
  const list = $("#tasks");
  list.replaceChildren();
  if (!tasks.length) list.append(element("li", "empty", historical ? "No goals were recorded for this day." : "Start with one little goal."));
  tasks.forEach((task) => {
    const row = element("li", `task ${task.done ? "done" : ""}`);
    const label = element("label", "task-label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.disabled = historical;
    checkbox.addEventListener("change", () => {
      const checked = checkbox.checked;
      update((next) => { next.days[selectedDate][grade].tasks.find((item) => item.id === task.id).done = checked; });
      render();
    });
    label.append(checkbox, element("span", "task-text", task.text));
    row.append(label, element("span", "task-type", task.recurring ? "Daily" : "Today"));
    if (!historical) {
      const remove = element("button", "delete-task", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${task.text}`);
      remove.addEventListener("click", () => {
        deleting = { id: task.id, date: selectedDate, grade };
        $("#delete-label").textContent = task.text;
        $("#delete-future-label").hidden = !task.recurring;
        $("#delete-future").checked = false;
        $("#delete-dialog").showModal();
      });
      row.append(remove);
    }
    list.append(row);
  });
  const allDone = tasks.length > 0 && complete === tasks.length;
  const remaining = tasks.length - complete;
  const evening = !historical && now.getHours() >= 19;
  $("#evening-check").className = `evening-check ${allDone ? "success" : evening && remaining ? "attention" : ""}`;
  $("#evening-check").textContent = allDone ? "✓ All goals complete. A little effort, a lovely day." :
    remaining ? `${evening ? "☾ Evening check-in" : historical ? "Daily record" : "☾ Before bedtime"} · ${remaining} ${remaining === 1 ? "goal" : "goals"} left${historical ? "." : ". Check each one off when you're done."}` : "Add a goal to start today's checklist.";
  $("#family-status").replaceChildren(...grades.map((item) => {
    const items = day?.[item].tasks ?? [];
    const done = items.filter((task) => task.done).length;
    return element("span", `family-pill ${items.length && done === items.length ? "complete" : ""}`, `Grade ${item}  ${done} / ${items.length} ${items.length && done === items.length ? "✓" : ""}`);
  }));
  renderReading();
}

$("#add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedDate !== today) return;
  const input = $("#task-input");
  if (!input.value.trim()) { input.setCustomValidity("Please enter a goal."); input.reportValidity(); return; }
  if (update((next) => addTask(next, selectedDate, grade, input.value, $("#repeat-input").checked, crypto.randomUUID()))) input.value = "";
  render();
  input.focus();
});
$("#task-input").addEventListener("input", () => $("#task-input").setCustomValidity(""));
$("#delete-dialog").addEventListener("close", () => {
  if ($("#delete-dialog").returnValue === "remove" && deleting) {
    update((next) => removeTask(next, deleting.date, deleting.grade, deleting.id, $("#delete-future").checked));
    render();
  }
  deleting = null;
});
function selectGrade(value) {
  grade = value;
  render();
  loadReading(grade, selectedDate);
}
document.querySelectorAll("[data-grade]").forEach((tab) => {
  tab.addEventListener("click", () => selectGrade(tab.dataset.grade));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectGrade(event.key === "Home" ? "4" : event.key === "End" ? "7" : grade === "4" ? "7" : "4");
    $(`#tab-${grade}`).focus();
  });
});
$("#day-picker").addEventListener("change", () => {
  const date = $("#day-picker").value;
  if (!date || date > today) { $("#day-picker").value = selectedDate; return; }
  selectedDate = date;
  render();
  loadReading(grade, selectedDate);
});
function tick() {
  if (!usable) return;
  const date = localDate();
  if (date !== today) {
    const wasToday = selectedDate === today;
    if (!update((next) => ensureDay(next, date))) return;
    today = date;
    if (wasToday) selectedDate = date;
    grades.forEach((item) => loadReading(item, today));
  }
  render();
}
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey && event.key !== null) return;
  try {
    const saved = localStorage.getItem(storageKey);
    const next = JSON.parse(saved);
    if (!validateState(next)) throw new Error("Records were removed or changed in another tab");
    state = next;
    if (!update((draft) => ensureDay(draft, today))) return;
    render();
  } catch (error) { usable = false; notice(`${error.message}. Refresh the page to continue.`); render(); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
setInterval(tick, 60000);
quizPanel = createQuizPanel({
  getContext: () => ({ grade, date: selectedDate, today, record: state?.days?.[selectedDate]?.[grade], usable }),
  save: (date, targetGrade, mutate) => update((next) => {
    const record = next.days[date]?.[targetGrade];
    if (!record) throw new Error("The daily record no longer exists. Refresh the page to continue");
    mutate(record);
  }),
  element,
});
render();
if (usable) grades.forEach((item) => loadReading(item, today));
