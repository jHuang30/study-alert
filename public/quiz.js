import { initialQuizState, validPublicQuiz, validAnswers, validResult } from "./quiz-model.js";

export function createQuizPanel({ getContext, save, element }) {
  const container = document.querySelector("#quiz-content");
  const busy = new Map();
  const errors = new Map();
  let status = null;
  let statusError = "";
  let lastSignature = "";
  const keyFor = ({ grade, date }) => `${grade}-${date}`;
  const signature = () => {
    const context = getContext();
    return JSON.stringify([context, status, statusError, busy.get(keyFor(context)), errors.get(keyFor(context))]);
  };

  async function request(path, data) {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data), signal: AbortSignal.timeout(105000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The AI request failed. Please try again.");
    return result;
  }

  function showError(error, key) {
    errors.set(key, error.name === "TimeoutError" || error.name === "AbortError" ?
      "The request timed out. Your saved answers are safe. Please try again." : error.message || "Unable to reach the server. Please try again.");
  }

  async function checkSetup() {
    statusError = "";
    status = null;
    render();
    try {
      const response = await fetch("/api/ai-status", { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Could not check AI setup.");
      const result = await response.json();
      if (typeof result.configured !== "boolean") throw new Error("Invalid AI setup response.");
      status = result;
    } catch {
      statusError = "Could not check AI setup. Make sure the local server is running.";
    }
    render();
  }

  async function generate(context) {
    const key = keyFor(context);
    if (busy.has(key)) return;
    busy.set(key, "Creating your questions… This can take about a minute.");
    errors.delete(key);
    render();
    try {
      const questions = await request("/api/quiz", { grade: context.grade, date: context.date, link: context.record.article.link });
      if (!validPublicQuiz(questions) || questions.grade !== context.grade || questions.date !== context.date ||
          questions.article.link !== context.record.article.link) throw new Error("The server returned a quiz for the wrong article. Please try again.");
      if (!save(context.date, context.grade, (record) => {
        if (record.article?.link !== questions.article.link) throw new Error("The reading has changed. Refresh the page before starting a quiz.");
        if (!record.quiz) record.quiz = initialQuizState(questions);
      })) throw new Error("The quiz could not be saved in this browser. Check the storage warning above, then try again.");
    } catch (error) { showError(error, key); }
    finally { busy.delete(key); render(); }
  }

  function saveAnswer(context, type, index, answer) {
    const success = save(context.date, context.grade, (record) => {
      if (record.quiz?.questions.id !== context.record.quiz.questions.id || record.quiz.result) {
        throw new Error("This quiz changed in another tab. Refresh the page to continue.");
      }
      record.quiz.answers[type][index] = answer;
    });
    if (!success) {
      errors.set(keyFor(context), "Your latest edit was not saved. Check the storage warning above and enter it again.");
      render();
    } else {
      errors.delete(keyFor(context));
      lastSignature = signature();
    }
  }

  async function submit(context) {
    const key = keyFor(context);
    if (busy.has(key)) return;
    const quiz = context.record.quiz;
    if (!validAnswers(quiz.answers, true)) {
      errors.set(key, "Please answer all seven questions before submitting.");
      render();
      return;
    }
    const answers = structuredClone(quiz.answers);
    busy.set(key, "Reading your answers and preparing feedback…");
    errors.delete(key);
    render();
    try {
      const result = await request("/api/grade", { quizId: quiz.questions.id, answers });
      if (!validResult(result)) throw new Error("The server returned invalid scores. No grade has been saved. Please try again.");
      if (!save(context.date, context.grade, (record) => {
        if (record.quiz?.questions.id !== quiz.questions.id || JSON.stringify(record.quiz.answers) !== JSON.stringify(answers)) {
          throw new Error("Your answers changed while AI was grading. Submit the updated answers again.");
        }
        record.quiz.result = result;
      })) throw new Error("Your feedback could not be saved. Check the storage warning above, then submit again.");
    } catch (error) { showError(error, key); }
    finally { busy.delete(key); render(); }
  }

  function renderSetup() {
    const details = element("details", "ai-setup");
    details.open = status?.configured === false;
    details.append(element("summary", "", status?.configured ? "AI setup & privacy" : "Parent setup: connect OpenAI"));
    const paragraph = element("p", "", "A parent must set OPENAI_API_KEY in the server's environment, then restart npm start. Never enter an API key in a task or answer. OPENAI_MODEL is optional (default: gpt-5.4-mini).");
    details.append(paragraph, element("p", "", "Creating a quiz sends the article text to OpenAI. Submitting sends the article, questions and your short answers. API usage may cost money. Do not include names, contact details or other personal information."));
    details.append(element("p", "", "OpenAI response storage is disabled (store: false); provider retention policies still apply. Answer keys are saved on this computer in .little-daily. Your answers and feedback are saved in this browser."));
    container.append(details);
    if (statusError) {
      const warning = element("p", "quiz-error", statusError);
      warning.setAttribute("role", "alert");
      const retry = element("button", "quiz-secondary", "Check setup again");
      retry.type = "button";
      retry.addEventListener("click", checkSetup);
      container.append(warning, retry);
    }
  }

  function render() {
    if (lastSignature === signature()) return;
    lastSignature = signature();
    const context = getContext();
    const { record, date, today, usable } = context;
    const key = keyFor(context);
    const working = busy.get(key);
    const quiz = record?.quiz;
    const historical = date !== today;
    container.replaceChildren();
    if (!usable) {
      container.append(element("p", "muted", "Local storage must be available before starting a quiz."));
      return;
    }
    if (!record?.article) {
      container.append(element("p", "muted", "Your reading quiz will be available after an article has been loaded."));
      return;
    }
    container.append(element("p", "quiz-article", `Based on: ${record.article.title}`));
    if (errors.has(key)) {
      const alert = element("p", "quiz-error", errors.get(key));
      alert.setAttribute("role", "alert");
      container.append(alert);
    }
    if (working) {
      const progress = element("p", "quiz-working", working);
      progress.setAttribute("role", "status");
      container.append(progress);
    }
    if (!quiz) {
      if (historical) {
        container.append(element("p", "muted", "No quiz was saved for this day. Return to today to start a new one."));
        return;
      }
      container.append(element("p", "quiz-description", "Finished reading? Try 5 multiple-choice questions and 2 short answers. Every question is based on this article, not just its headline."));
      renderSetup();
      const start = element("button", "quiz-primary", working ? "Creating your quiz…" :
        status === null ? "Checking AI setup…" : status.configured ? "I've read it — create my quiz" : "Set up AI to begin");
      start.type = "button";
      start.disabled = Boolean(working) || !status?.configured;
      start.addEventListener("click", () => generate(getContext()));
      container.append(start);
      return;
    }
    const result = quiz.result;
    if (result) {
      const score = element("div", "quiz-score");
      score.append(element("strong", "", `${result.total} / 100`), element("p", "", result.summary));
      container.append(score, element("p", "quiz-description", "AI feedback is a learning aid, not an official grade. Review any surprising feedback with a parent. Grammar and spelling do not affect your score."));
    } else if (historical) {
      container.append(element("p", "muted", "This is a saved draft from a past day. Past quizzes are read-only."));
    } else {
      container.append(element("p", "quiz-description", "Multiple choice: 10 points each. Short answers: 25 points each. Show what you understood; grammar and spelling get tips, not deductions. Drafts save as you type."));
      renderSetup();
    }
    const form = element("form", "quiz-form");
    const locked = Boolean(working || result || historical);
    quiz.questions.multipleChoice.forEach((question, index) => {
      const fieldset = element("fieldset", "quiz-question");
      fieldset.disabled = locked;
      fieldset.append(element("legend", "", `${index + 1}. ${question.prompt}`));
      question.options.forEach((option, optionIndex) => {
        const label = element("label", `quiz-option ${result?.multipleChoice[index].correctIndex === optionIndex ? "correct-option" : ""}`);
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `mc-${index}`;
        input.value = String(optionIndex);
        input.required = true;
        input.checked = quiz.answers.multipleChoice[index] === optionIndex;
        input.addEventListener("change", () => saveAnswer(context, "multipleChoice", index, optionIndex));
        label.append(input, element("span", "", `${String.fromCharCode(65 + optionIndex)}. ${option}`));
        fieldset.append(label);
      });
      if (result) {
        const feedback = result.multipleChoice[index];
        fieldset.append(element("p", "quiz-feedback", `${feedback.score}/10 · Correct answer: ${String.fromCharCode(65 + feedback.correctIndex)}. ${feedback.explanation}`));
      }
      form.append(fieldset);
    });
    quiz.questions.shortAnswer.forEach((question, index) => {
      const fieldset = element("fieldset", "quiz-question");
      fieldset.disabled = locked;
      const id = `short-${context.grade}-${context.date}-${index}`;
      const helpId = `${id}-help`;
      fieldset.append(element("legend", "", `${index + 6}. ${question.prompt}`));
      const label = element("label", "sr-only", `Your answer to question ${index + 6}`);
      label.htmlFor = id;
      const textarea = document.createElement("textarea");
      textarea.id = id;
      textarea.rows = 4;
      textarea.maxLength = 2000;
      textarea.required = true;
      textarea.placeholder = "Explain in your own words. Use details from the article.";
      textarea.value = quiz.answers.shortAnswer[index];
      textarea.setAttribute("aria-describedby", helpId);
      textarea.addEventListener("input", () => saveAnswer(context, "shortAnswer", index, textarea.value));
      const help = element("p", "quiz-answer-help", "Up to 2,000 characters. No names or personal information, please.");
      help.id = helpId;
      fieldset.append(label, textarea, help);
      if (result) {
        const feedback = result.shortAnswer[index];
        fieldset.append(element("p", "quiz-feedback", `${feedback.score}/25 · ${feedback.feedback}`),
          element("p", "quiz-language", `Writing tip (no points deducted): ${feedback.languageTips}`));
      }
      form.append(fieldset);
    });
    if (!result && !historical) {
      const button = element("button", "quiz-primary", working ? "AI is reviewing…" : "Submit for feedback");
      button.type = "submit";
      button.disabled = Boolean(working) || !status?.configured;
      form.append(element("p", "quiz-description", "Submitting sends your short answers to OpenAI for feedback. Once graded, this attempt is saved as read-only."), button);
      form.addEventListener("submit", (event) => { event.preventDefault(); submit(getContext()); });
    }
    container.append(form);
  }

  checkSetup();
  return { render };
}
