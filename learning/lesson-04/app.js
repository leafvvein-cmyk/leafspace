const newEntryButton = document.querySelector('#new-entry-button');
const entryForm = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const contentInput = document.querySelector('#entry-content');
const cancelButton = document.querySelector('#cancel-button');
const formError = document.querySelector('#form-error');
const pageStatus = document.querySelector('#page-status');
const savedEntry = document.querySelector('#saved-entry');
const savedTitle = document.querySelector('#saved-title');
const savedContent = document.querySelector('#saved-content');

let savedCount = 0;

function openEditor() {
  entryForm.hidden = false;
  formError.hidden = true;
  titleInput.focus();
  pageStatus.textContent = '编辑器已经打开，请填写标题和正文。';
}

function closeEditor() {
  entryForm.hidden = true;
  formError.hidden = true;
  entryForm.reset();
  newEntryButton.focus();
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function saveEntry(event) {
  event.preventDefault();

  const title = titleInput.value.trim();
  const content = contentInput.value.trim();

  if (title === '') {
    showError('请先填写标题。');
    titleInput.focus();
    return;
  }

  if (content === '') {
    showError('请先填写正文。');
    contentInput.focus();
    return;
  }

  savedCount = savedCount + 1;
  savedTitle.textContent = title;
  savedContent.textContent = content;
  savedEntry.hidden = false;
  pageStatus.textContent = `已在本次练习中保存 ${savedCount} 篇日记。刷新页面后会清空。`;
  closeEditor();
}

newEntryButton.addEventListener('click', openEditor);
cancelButton.addEventListener('click', closeEditor);
entryForm.addEventListener('submit', saveEntry);
