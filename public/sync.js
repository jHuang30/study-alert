import { grades, ensureDay } from "./model.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A freshly generated day (nothing done, no article/quiz) is never synced, so an
// empty record created on one device can't overwrite real progress from another.
export function isBlank(record, templates) {
  return !record.article && !record.quiz && record.tasks.length === templates.length &&
    record.tasks.every((task, index) => !task.done && task.id === templates[index].id && task.text === templates[index].text);
}

// Stamps records (and templates) that a user action changed. Mutates `after`.
export function stampChanges(before, after, now) {
  for (const grade of grades) {
    if (!same(before.templates?.[grade], after.templates[grade])) (after.templatesUpdatedAt ??= {})[grade] = now;
    for (const [date, day] of Object.entries(after.days)) {
      const record = day[grade];
      const old = before.days?.[date]?.[grade];
      if (old ? !same(old, record) : !isBlank(record, after.templates[grade])) record.updatedAt = now;
    }
  }
}

export function createSync({ getState, update, onChange, onStatus, request = fetch }) {
  let running = false;
  let again = false;
  let timer = null;

  async function call(path, options) {
    const response = await request(path, { signal: AbortSignal.timeout(20000), ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Sync failed.");
    return body;
  }
  const put = (path, data) => call(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  async function syncGrade(grade) {
    let changed = false;
    const summary = await call(`/api/profile?grade=${grade}`);
    const local = getState();
    const newerRemote = Object.entries(summary.days)
      .filter(([date, stamp]) => stamp > (local.days[date]?.[grade]?.updatedAt ?? "")).map(([date]) => date);
    const pullTemplates = Boolean(summary.templatesUpdatedAt) && summary.templatesUpdatedAt > (local.templatesUpdatedAt?.[grade] ?? "");
    for (let i = 0; i < newerRemote.length || (pullTemplates && i === 0); i += 30) {
      const dates = newerRemote.slice(i, i + 30);
      const data = await call(`/api/profile/data?grade=${grade}&dates=${dates.join(",")}&templates=${i === 0 && pullTemplates ? 1 : 0}`);
      const ok = update((next) => {
        if (data.templates && data.templates.updatedAt > (next.templatesUpdatedAt?.[grade] ?? "")) {
          next.templates[grade] = data.templates.templates;
          (next.templatesUpdatedAt ??= {})[grade] = data.templates.updatedAt;
        }
        for (const [date, record] of Object.entries(data.days)) {
          const day = ensureDay(next, date);
          if (record.updatedAt > (day[grade].updatedAt ?? "")) day[grade] = record;
        }
      }, { system: true });
      if (!ok) throw new Error("Saved progress from the server could not be stored in this browser.");
      changed = true;
    }
    const current = getState();
    for (const [date, day] of Object.entries(current.days)) {
      const record = day[grade];
      if (record.updatedAt && record.updatedAt > (summary.days[date] ?? "")) await put("/api/profile/day", { grade, date, record });
    }
    const stamp = current.templatesUpdatedAt?.[grade];
    if (stamp && stamp > (summary.templatesUpdatedAt ?? "")) {
      await put("/api/profile/templates", { grade, templates: current.templates[grade], updatedAt: stamp });
    }
    return changed;
  }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    let changed = false;
    try {
      do {
        again = false;
        for (const grade of grades) changed = (await syncGrade(grade)) || changed;
      } while (again);
      onStatus?.("");
    } catch (error) {
      onStatus?.("Progress is saved on this device only. It will sync to the server when the connection returns.");
    } finally {
      running = false;
      if (changed) onChange?.();
    }
  }

  // Call after local edits: waits a moment so typing doesn't send one request per keystroke.
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  }
  return { run, schedule };
}
