const form = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const dateInput = document.querySelector('#entry-date');
const contentInput = document.querySelector('#entry-content');
const contentCount = document.querySelector('#content-count');
const savedResult = document.querySelector('#saved-result');
const resultTitle = document.querySelector('#result-title');
const resultDate = document.querySelector('#result-date');
const resultMood = document.querySelector('#result-mood');
const resultLength = document.querySelector('#result-length');
const moodLabels = { happy: '开心', calm: '平静', sad: '低落' };

const today = new Date().toLocaleDateString('en-CA');
dateInput.value = today;
dateInput.max = today;

function fieldError(input, message) {
  const error = document.querySelector(`#${input.id.replace('entry-', '')}-error`);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message;
  error.hidden = message === '';
  return message !== '';
}

function validateForm() {
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  const titleInvalid = fieldError(titleInput, title.length < 2 ? '标题至少需要 2 个字符。' : '');
  const dateInvalid = fieldError(dateInput, dateInput.value === '' ? '请选择日记日期。' : dateInput.value > today ? '日记日期不能晚于今天。' : '');
  const contentInvalid = fieldError(contentInput, content.length < 5 ? '正文至少需要 5 个字符。' : content.length > 5000 ? '正文不能超过 5000 个字符。' : '');
  const firstInvalid = [titleInvalid && titleInput, dateInvalid && dateInput, contentInvalid && contentInput].find(Boolean);
  firstInvalid?.focus();
  return !firstInvalid;
}

function saveEntry(event) {
  event.preventDefault();
  if (!validateForm()) {
    savedResult.hidden = true;
    return;
  }

  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  const selectedMood = form.elements.mood.value;
  resultTitle.textContent = title;
  resultDate.textContent = dateInput.value;
  resultMood.textContent = moodLabels[selectedMood] || '未选择';
  resultLength.textContent = `${content.length} 个字符`;
  savedResult.hidden = false;
  savedResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateCount() {
  contentCount.textContent = `${contentInput.value.length} / 5000`;
  if (contentInput.getAttribute('aria-invalid') === 'true') fieldError(contentInput, '');
}

titleInput.addEventListener('input', () => {
  if (titleInput.getAttribute('aria-invalid') === 'true') fieldError(titleInput, '');
});
dateInput.addEventListener('change', () => {
  if (dateInput.getAttribute('aria-invalid') === 'true') fieldError(dateInput, '');
});
contentInput.addEventListener('input', updateCount);
form.addEventListener('submit', saveEntry);
