import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { MOODS, contentText, normalizeTags, makeDraft, hasContent, isDate } from '@diary/contracts';
import { h, button, iconButton, icon, toast, downloadFile } from './dom.js';
import { isNative } from '../services/platform.js';
import { prepareLocalImage } from '../services/local-assets.js';

function diaryImage(resolveAsset) {
  return Node.create({
    name: 'image', group: 'block', atom: true, draggable: true,
    addAttributes() { return { assetId: { default: null }, alt: { default: '' }, caption: { default: '' } }; },
    parseHTML() { return [{ tag: 'figure[data-diary-image]', getAttrs: (element) => ({ assetId: element.dataset.assetId, alt: element.querySelector('img')?.alt ?? '', caption: element.querySelector('figcaption')?.textContent ?? '' }) }]; },
    renderHTML({ HTMLAttributes }) { return ['figure', { 'data-diary-image': '', 'data-asset-id': HTMLAttributes.assetId }, ['img', { alt: HTMLAttributes.alt || '' }], ...(HTMLAttributes.caption ? [['figcaption', {}, HTMLAttributes.caption]] : [])]; },
    addNodeView() {
      return ({ node }) => {
        const figure = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption');
        let objectUrl;
        figure.className = 'diary-image'; figure.dataset.assetId = node.attrs.assetId; figure.contentEditable = 'false';
        image.alt = node.attrs.alt || ''; caption.textContent = node.attrs.caption || '正在读取本机图片…';
        figure.append(image, caption);
        Promise.resolve(resolveAsset?.(node.attrs.assetId)).then((asset) => {
          if (!asset?.bytes || !figure.isConnected) throw new Error('图片尚未保存在此设备');
          objectUrl = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType })); image.src = objectUrl;
          caption.textContent = node.attrs.caption || (asset.status === 'ready' ? '图片已同步' : '图片已保存在此设备');
        }).catch((error) => { figure.classList.add('is-missing'); caption.textContent = error.message || '图片暂时无法读取'; });
        return { dom: figure, destroy() { if (objectUrl) URL.revokeObjectURL(objectUrl); } };
      };
    },
  });
}

/** The view owns editing, while the caller owns navigation and durable saving. */
export function createEditorView(entry, { onSave, onBack, onTrash, onSaved, onRecovered, onAddImage, onPickImage, resolveAsset, onAssetState, focus = false }) {
  let draft = structuredClone(entry);
  let lastSaved = entry.localRevision || entry.revision !== '0' ? structuredClone(entry) : null;
  let generation = 0;
  let savedGeneration = 0;
  let timer;
  let maxTimer;
  let pending = Promise.resolve();
  let failure = null;
  let disposed = false;
  let composing = false;
  let frozen = false;
  let assetStateVersion = 0;
  const status = h('span', { className: 'save-status', role: 'status', 'aria-live': 'polite' }, '尚未输入内容');
  const assetStatus = h('span', { className: 'asset-save-status muted', role: 'status', 'aria-live': 'polite', hidden: true });
  const count = h('span', { className: 'word-count' }, '0 字');
  const surface = h('div', { className: 'editor-body' });
  const heading = h('input', { className: 'entry-title', placeholder: '给这一天起个名字', 'aria-label': '日记标题', value: draft.title, maxlength: 240 });
  const entryDate = h('input', { type: 'date', className: 'entry-date', 'aria-label': '日记日期', value: draft.entryDate });
  const tagInput = h('input', { className: 'tag-input', placeholder: '添加标签，以逗号分隔', 'aria-label': '标签', value: draft.tags.map((tag) => tag.name).join('，') });
  const moodButtons = [];
  const conflictPanel = h('div', { className: 'conflict-panel', hidden: true });
  const trashButton = onTrash && iconButton('移到回收站', 'trash', () => onTrash(draft.id));
  if (trashButton) trashButton.hidden = (!entry.localRevision && entry.revision === '0') || !hasContent(entry);

  function freeze(value) {
    frozen = value;
    editor.setEditable(!value, false);
    root.querySelectorAll('input,button').forEach((control) => { control.disabled = value; });
  }

  function showConflict(error) {
    if (!error.current) {
      conflictPanel.hidden = false;
      conflictPanel.replaceChildren(h('h3', {}, '这次修改尚未保存'),
        h('p', {}, lastSaved ? '可以修正内容后重试，也可以导出当前草稿，或撤销未保存的修改。' : '这份草稿尚未写入本机。请先导出当前草稿，检查存储空间后再重试。'),
        button('重试保存', () => flush().catch(() => {})),
        lastSaved && button('撤销未保存修改', () => {
          if (!window.confirm('撤销当前未保存的修改，恢复上次成功保存在本机的内容？')) return;
          draft = structuredClone(lastSaved);
          heading.value = draft.title; entryDate.value = draft.entryDate; tagInput.value = draft.tags.map((tag) => tag.name).join('，');
          editor.commands.setContent(draft.content, { emitUpdate: false });
          moodButtons.forEach(({ control, value }) => control.setAttribute('aria-pressed', String(value === draft.mood)));
          savedGeneration = generation; failure = null; pending = Promise.resolve(draft);
          conflictPanel.hidden = true; count.textContent = `${[...contentText(draft.content).replace(/\s/g, '')].length} 字`;
          setStatus('已恢复上次保存在本机的内容'); refreshToolbar();
        }, { className: 'button' }));
      return;
    }
    conflictPanel.hidden = false;
    conflictPanel.replaceChildren(
      h('h3', {}, '另一份内容也已保存'),
      h('p', {}, '本机稿不会覆盖已有版本。你可以另存一份随记，或先导出当前草稿。'),
      h('p', { className: 'conflict-preview' }, `已保存版本：${error.current.title || contentText(error.current.content).slice(0, 120) || '空草稿'}`),
      button('另存本机稿为随记', async () => {
        freeze(true);
        try {
          await pending.catch(() => {});
          const current = snapshot();
          const separate = { ...makeDraft({ kind: 'moment', entryDate: current.entryDate }), title: current.title, content: current.content, tags: current.tags, mood: current.mood, timezone: current.timezone };
          const saved = await onSave(separate, 0);
          draft = saved; lastSaved = structuredClone(saved); failure = null; savedGeneration = generation; pending = Promise.resolve(saved);
          conflictPanel.hidden = true; setStatus('已另存为随记，原记录未改变');
          onSaved?.(saved);
          await onRecovered?.(saved);
        } catch (problem) { setStatus(problem.message, true); failure = problem; }
        finally { if (!disposed) freeze(false); }
      }, { className: 'button primary', glyph: 'plus' }),
    );
  }

  function setStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('save-error', error);
  }

  async function refreshAssetStatus(content = editor.getJSON()) {
    if (!onAssetState || disposed) return;
    const version = ++assetStateVersion;
    try {
      const state = await onAssetState(content);
      if (disposed || version !== assetStateVersion) return;
      assetStatus.hidden = !state.total;
      assetStatus.classList.toggle('save-error', Boolean(state.failed));
      if (!state.total) assetStatus.textContent = '';
      else if (state.failed) assetStatus.textContent = `图片上传失败 ${state.failed} 张，可在“我的 → 图片上传问题”中重试`;
      else if (state.missing) assetStatus.textContent = `图片尚未下载 ${state.missing} 张，联网查看时会读取`;
      else if (!state.canUpload && state.waiting) assetStatus.textContent = `图片仅保存在本机 ${state.waiting} 张`;
      else if (state.waiting) assetStatus.textContent = `图片待上传 ${state.waiting} 张；文字可先同步`;
      else assetStatus.textContent = `图片已准备同步 ${state.ready} 张`;
    } catch { /* A status read must never turn a successful diary save into a failure. */ }
  }

  function snapshot() {
    if (!isDate(entryDate.value)) throw new Error('请选择有效日期');
    return { ...draft, entryDate: entryDate.value, title: heading.value, content: editor.getJSON(), tags: normalizeTags(tagInput.value.split(/[,，]/)) };
  }

  async function flush() {
    clearTimeout(timer); clearTimeout(maxTimer); maxTimer = null;
    if (savedGeneration === generation && !failure) return pending;
    const targetGeneration = generation;
    let captured;
    try { captured = snapshot(); }
    catch (error) { failure = error; setStatus(error.message, true); showConflict(error); throw error; }
    setStatus('正在保存…');
    const run = async () => {
      // A queued save uses the prior local acknowledgement, never a later remote edit.
      captured.localRevision = draft.localRevision;
      try {
        const saved = await onSave(captured, draft.localRevision);
        lastSaved = structuredClone(saved);
        if (trashButton && hasContent(saved)) trashButton.hidden = false;
        draft = { ...draft, localRevision: saved.localRevision, updatedAt: saved.updatedAt };
        savedGeneration = Math.max(savedGeneration, targetGeneration);
        failure = null;
        conflictPanel.hidden = true;
        if (!disposed && generation === targetGeneration) setStatus('已保存在此设备');
        void refreshAssetStatus(saved.content);
        onSaved?.(saved);
        return saved;
      } catch (error) {
        failure = error;
        if (!disposed) setStatus(error.message, true);
        if (!disposed) showConflict(error);
        throw error;
      }
    };
    pending = pending.catch(() => {}).then(run);
    return pending;
  }

  function changed() {
    if (frozen || disposed) return;
    generation++;
    count.textContent = `${[...contentText(editor.getJSON()).replace(/\s/g, '')].length} 字`;
    setStatus('等待保存…');
    clearTimeout(timer);
    timer = setTimeout(() => { if (!composing) flush().catch(() => {}); }, 500);
    if (!maxTimer) maxTimer = setTimeout(() => { maxTimer = null; if (!composing) flush().catch(() => {}); }, 2000);
  }

  const editor = new Editor({
    element: surface,
    extensions: [
      diaryImage(resolveAsset),
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, strike: false, code: false, codeBlock: false }),
      TaskList, TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: '此刻，想记下些什么？\n从一句话开始就好。' }),
    ],
    content: draft.content,
    editorProps: { attributes: { role: 'textbox', 'aria-label': '日记正文', 'aria-multiline': 'true', spellcheck: 'false' } },
    onUpdate: changed,
    onSelectionUpdate: () => refreshToolbar(),
  });
  const formatButtons = [];
  const format = (label, command, active, glyph = label) => {
    const control = h('button', { type: 'button', className: 'format-button', title: label, 'aria-label': label, 'aria-pressed': 'false', onmousedown: (event) => event.preventDefault(), onclick: () => { command(editor.chain().focus()).run(); refreshToolbar(); } }, glyph);
    formatButtons.push({ control, active });
    return control;
  };
  function refreshToolbar() {
    for (const { control, active } of formatButtons) control.setAttribute('aria-pressed', String(active?.(editor) ?? false));
  }
  const imageInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true, 'aria-label': '选择日记图片' });
  const chooseNativeSource = () => new Promise((resolve) => {
    let chosen = null;
    const dialog = h('dialog', { className: 'confirmation' }, h('h2', {}, '添加日记照片'), h('p', {}, '只有现在选择来源后，App 才会打开相机或系统相册。'),
      h('div', { className: 'account-actions' }, button('取消', () => dialog.close()), button('拍照', () => { chosen = 'camera'; dialog.close(); }), button('从相册选择', () => { chosen = 'photos'; dialog.close(); }, { className: 'button primary' })));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(chosen); }); document.body.append(dialog); dialog.showModal();
  });
  async function addImage(file) {
    if (!file || disposed || frozen) return;
    imageButton.disabled = true; setStatus('正在处理并保存图片…');
    try {
      const asset = await prepareLocalImage(file, draft.id);
      await onAddImage(asset);
      editor.chain().focus().insertContent({ type: 'image', attrs: { assetId: asset.id, alt: file.name.replace(/\.[^.]+$/, ''), caption: '' } }).run();
      setStatus('图片已保存在此设备，等待正文保存…');
      void refreshAssetStatus(editor.getJSON());
    } catch (error) { failure = error; setStatus(error.message || '图片没有添加成功', true); toast(error.message || '图片没有添加成功'); }
    finally { if (!disposed) imageButton.disabled = false; }
  }
  const imageButton = onAddImage && h('button', { type: 'button', className: 'format-button image-button', title: '插入图片', 'aria-label': '插入图片', onclick: async () => {
    if (!onPickImage) { imageInput.click(); return; }
    const source = await chooseNativeSource(); if (!source || disposed || frozen) return;
    try { await addImage(await onPickImage(source)); } catch (error) { setStatus(error.message || '图片没有添加成功', true); toast(error.message || '图片没有添加成功'); }
  } }, icon('image', 18));
  imageInput.addEventListener('change', () => { const file = imageInput.files?.[0]; imageInput.value = ''; void addImage(file); });
  surface.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  });
  surface.addEventListener('drop', (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault(); void addImage(file);
  });
  const toolbar = h('div', { className: 'editor-toolbar', role: 'toolbar', 'aria-label': '文字格式' },
    format('粗体', (chain) => chain.toggleBold(), (editor) => editor.isActive('bold'), h('b', {}, 'B')),
    format('斜体', (chain) => chain.toggleItalic(), (editor) => editor.isActive('italic'), h('i', {}, 'I')),
    format('下划线', (chain) => chain.toggleUnderline(), (editor) => editor.isActive('underline'), h('u', {}, 'U')),
    h('span', { className: 'toolbar-divider', 'aria-hidden': 'true' }),
    format('二级标题', (chain) => chain.toggleHeading({ level: 2 }), (editor) => editor.isActive('heading'), 'H₂'),
    format('无序列表', (chain) => chain.toggleBulletList(), (editor) => editor.isActive('bulletList'), '• ≡'),
    format('有序列表', (chain) => chain.toggleOrderedList(), (editor) => editor.isActive('orderedList'), '1. ≡'),
    format('待办列表', (chain) => chain.toggleTaskList(), (editor) => editor.isActive('taskList'), '☑'),
    format('引用', (chain) => chain.toggleBlockquote(), (editor) => editor.isActive('blockquote'), '❝'),
    format('分隔线', (chain) => chain.setHorizontalRule(), null, '―'),
    imageButton, imageInput,
    h('span', { className: 'toolbar-divider', 'aria-hidden': 'true' }),
    format('撤销', (chain) => chain.undo(), null, '↶'),
    format('重做', (chain) => chain.redo(), null, '↷'),
  );
  for (const mood of MOODS) {
    const control = button(mood.label, () => {
      draft.mood = draft.mood === mood.value ? null : mood.value;
      moodButtons.forEach(({ control, value }) => control.setAttribute('aria-pressed', String(value === draft.mood)));
      changed();
    }, { className: `mood mood-${mood.value}`, 'aria-pressed': String(draft.mood === mood.value) });
    moodButtons.push({ control, value: mood.value });
  }
  const recovery = button('导出当前草稿', async () => {
    const source = JSON.stringify({ ...draft, title: heading.value, content: editor.getJSON(), unparsedTags: tagInput.value }, null, 2);
    try {
      await downloadFile(`日记草稿-${draft.entryDate}.json`, source);
      toast(isNative ? '已打开系统导出，请确认保存并妥善保管明文草稿。' : '草稿已交给浏览器下载，请妥善保存明文文件。');
    } catch (error) { toast(error.message || '导出没有完成，草稿仍保留在编辑器。'); }
  }, { glyph: 'download', className: 'text-button' });
  const root = h('section', { className: 'writing-sheet', 'aria-label': '日记编辑器' },
    h('div', { className: 'sheet-topline' },
      h('span', { className: 'eyebrow' }, draft.kind === 'daily' ? '每日一页' : '随记'),
      h('div', { className: 'sheet-actions' },
        iconButton('专注写作', 'focus', () => document.body.classList.toggle('focus-mode')),
        trashButton,
        onBack && iconButton('返回', 'back', onBack))),
    h('div', { className: 'sheet-content' },
      heading,
      h('label', { className: 'entry-date-row' }, h('span', {}, draft.kind === 'daily' ? '日记日期' : '归档日期'), entryDate,
        h('small', { className: 'muted' }, draft.kind === 'daily' ? '改到已有每日记录的日期时会保留两份，不会覆盖。' : '发生时间保持不变，只调整日历归档日期。')),
      h('div', { className: 'save-line writing-status' }, icon('check', 16), h('span', { className: 'save-status-stack' }, status, assetStatus)),
      h('div', { className: 'mood-row', role: 'group', 'aria-label': '今天的心情' }, h('span', { className: 'mood-label' }, '今天的心情'), moodButtons.map(({ control }) => control)),
      h('label', { className: 'tag-row' }, icon('tag', 16), tagInput),
      toolbar, surface, conflictPanel),
    h('footer', { className: 'editor-footer' }, count, recovery),
  );
  heading.addEventListener('input', changed);
  entryDate.addEventListener('change', () => { if (isDate(entryDate.value)) changed(); });
  tagInput.addEventListener('input', changed);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; changed(); });
  count.textContent = `${[...contentText(draft.content).replace(/\s/g, '')].length} 字`;
  if (entry.localRevision) setStatus('已保存在此设备');
  else if (entry.revision !== '0') setStatus('已下载云端副本；修改将先保存在此设备');
  void refreshAssetStatus(draft.content);
  if (focus) requestAnimationFrame(() => {
    // Tiptap's focus command schedules another frame. A delayed command can
    // steal focus from a title field the user has already started typing in.
    if (!disposed && root.isConnected && [document.body, document.documentElement, null].includes(document.activeElement)) editor.view.focus();
  });
  return {
    root, flush,
    snapshot: () => ({ ...draft, entryDate: entryDate.value, title: heading.value, content: editor.getJSON(), unparsedTags: tagInput.value }),
    async prepareLeave() {
      freeze(true);
      try { await flush(); }
      catch (error) { freeze(false); throw error; }
    },
    resume() { if (!disposed) freeze(false); },
    pause() { if (!disposed) freeze(true); },
    get dirty() { return generation !== savedGeneration || Boolean(failure); },
    get id() { return draft.id; },
    destroy() { disposed = true; clearTimeout(timer); clearTimeout(maxTimer); editor.destroy(); },
  };
}
