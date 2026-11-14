const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = (value, size, valid) => Array.isArray(value) && value.length === size && value.every(valid);

export function validPublicQuiz(quiz) {
  return Boolean(quiz && /^[a-f0-9]{64}$/.test(quiz.id ?? "") &&
    ["4", "7"].includes(quiz.grade) && /^\d{4}-\d{2}-\d{2}$/.test(quiz.date ?? "") &&
    text(quiz.article?.title, 1000) && text(quiz.article?.link, 2000) &&
    list(quiz.multipleChoice, 5, (question) => text(question?.prompt, 1000) &&
      list(question.options, 4, (option) => text(option, 700)) && new Set(question.options).size === 4) &&
    list(quiz.shortAnswer, 2, (question) => text(question?.prompt, 1000)));
}

export function validAnswers(answers, complete = false) {
  return Boolean(answers &&
    list(answers.multipleChoice, 5, (answer) => (!complete && answer === null) || (Number.isInteger(answer) && answer >= 0 && answer <= 3)) &&
    list(answers.shortAnswer, 2, (answer) => typeof answer === "string" && answer.length <= 2000 && (!complete || answer.trim().length > 0)));
}

export function validResult(result) {
  return Boolean(result && result.max === 100 && Number.isInteger(result.total) && result.total >= 0 && result.total <= 100 &&
    text(result.summary, 2000) && typeof result.gradedAt === "string" && Number.isFinite(Date.parse(result.gradedAt)) &&
    list(result.multipleChoice, 5, (answer) => answer && [0, 10].includes(answer.score) &&
      Number.isInteger(answer.correctIndex) && answer.correctIndex >= 0 && answer.correctIndex <= 3 && text(answer.explanation, 1500)) &&
    list(result.shortAnswer, 2, (answer) => answer && [0, 5, 10, 15, 20, 25].includes(answer.score) &&
      text(answer.feedback, 2000) && text(answer.languageTips, 1500)) &&
    result.total === [...result.multipleChoice, ...result.shortAnswer].reduce((sum, answer) => sum + answer.score, 0));
}

export function validQuizState(value) {
  return value === undefined || value === null || Boolean(validPublicQuiz(value.questions) &&
    validAnswers(value.answers) && (value.result === null || (validAnswers(value.answers, true) && validResult(value.result))));
}

export function initialQuizState(questions) {
  return { questions, answers: { multipleChoice: Array(5).fill(null), shortAnswer: ["", ""] }, result: null };
}
