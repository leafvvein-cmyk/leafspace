const entries = [
  { id: '1', title: '雨后的路', content: '空气很安静，路边的叶子还带着水。', entryDate: '2026-09-10', tags: ['生活', '散步'] },
  { id: '2', title: '项目周会', content: '整理接口清单，并确认下周的工作计划。', entryDate: '2026-09-08', tags: ['工作'] },
  { id: '3', title: '学习 C++', content: '今天理解了指针与引用的区别。', entryDate: '2026-09-05', tags: ['学习', '编程'] },
  { id: '4', title: '咖啡店随记', content: '店里播放着旧唱片；窗外很亮。', entryDate: '2026-08-28', tags: ['生活', '随记'] },
  { id: '5', title: '跑步五公里', content: '配速不重要，保持呼吸和节奏。', entryDate: '2026-08-20', tags: ['运动'] },
  { id: '6', title: '读完一本书', content: '记下三个问题，明天再回头思考。', entryDate: '2026-08-12', tags: ['学习', '阅读'] },
];

const queryInput = document.querySelector('#query');
const tagSelect = document.querySelector('#tag');
const dateFrom = document.querySelector('#date-from');
const dateTo = document.querySelector('#date-to');
const resetButton = document.querySelector('#reset-button');
const filterError = document.querySelector('#filter-error');
const resultCount = document.querySelector('#result-count');
const resultList = document.querySelector('#result-list');
const emptyState = document.querySelector('#empty-state');
let searchTimer;

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function allTags() {
  return [...new Set(entries.flatMap((entry) => entry.tags.map(normalize)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function createCard(entry) {
  const article = document.createElement('article');
  const meta = document.createElement('p');
  const heading = document.createElement('h3');
  const content = document.createElement('p');
  const tags = document.createElement('div');
  article.className = 'entry-card';
  meta.className = 'entry-meta';
  meta.textContent = entry.entryDate;
  heading.textContent = entry.title;
  content.textContent = entry.content;
  tags.className = 'tag-list';
  for (const name of entry.tags) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `#${name}`;
    tags.append(tag);
  }
  article.append(meta, heading, content, tags);
  return article;
}

function matches(entry, filters) {
  const searchable = normalize([entry.title, entry.content, ...entry.tags].join('\n'));
  return (!filters.query || searchable.includes(filters.query))
    && (!filters.tag || entry.tags.some((tag) => normalize(tag) === filters.tag))
    && (!filters.from || entry.entryDate >= filters.from)
    && (!filters.to || entry.entryDate <= filters.to);
}

function renderResults() {
  const filters = { query: normalize(queryInput.value), tag: normalize(tagSelect.value), from: dateFrom.value, to: dateTo.value };
  if (filters.from && filters.to && filters.from > filters.to) {
    filterError.textContent = '开始日期不能晚于结束日期。';
    filterError.hidden = false;
    resultList.replaceChildren();
    resultCount.textContent = '0 篇';
    emptyState.hidden = true;
    return;
  }

  filterError.hidden = true;
  const results = entries.filter((entry) => matches(entry, filters));
  resultList.replaceChildren(...results.map(createCard));
  resultCount.textContent = `${results.length} 篇`;
  emptyState.hidden = results.length > 0;
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderResults, 300);
}

function resetFilters() {
  clearTimeout(searchTimer);
  queryInput.value = '';
  tagSelect.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  renderResults();
  queryInput.focus();
}

for (const name of allTags()) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  tagSelect.append(option);
}

queryInput.addEventListener('input', scheduleSearch);
tagSelect.addEventListener('change', renderResults);
dateFrom.addEventListener('change', renderResults);
dateTo.addEventListener('change', renderResults);
resetButton.addEventListener('click', resetFilters);
renderResults();
