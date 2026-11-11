import { describe, it, expect } from 'vitest';
import { makeDraft, isDate, offsetDate, localDate, contentText, normalizeTags, validateEntry, validateContent, hasContent } from '../../packages/contracts/src/entry.js';

function entryWithText(text = '今天值得记下来。') {
  return { ...makeDraft({ entryDate: '2026-09-08' }), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } };
}

describe('diary date and input contract', () => {
  it('validates actual calendar dates, including leap years', () => {
    expect(isDate('2024-02-29')).toBe(true);
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2026-13-01')).toBe(false);
    expect(isDate('2026-9-8')).toBe(false);
    expect(isDate(null)).toBe(false);
  });
  it('changes date without relying on the machine timezone', () => {
    expect(offsetDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(offsetDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(localDate(new Date('2026-09-07T17:00:00Z'), 'Asia/Shanghai')).toBe('2026-09-08');
    expect(localDate(new Date('2026-09-07T17:00:00Z'), 'America/New_York')).toBe('2026-09-07');
  });
  it('does not count an empty editor as a diary', () => {
    expect(hasContent(makeDraft())).toBe(false);
    expect(() => validateEntry(makeDraft())).toThrow('请写一点内容');
    expect(() => validateEntry(makeDraft(), { allowEmpty: true })).not.toThrow();
    expect(() => validateEntry(entryWithText('  \n '))).toThrow();
  });
  it('allows a title-only entry and preserves Chinese text', () => {
    expect(() => validateEntry({ ...makeDraft(), title: '今天' })).not.toThrow();
    const entry = entryWithText();
    expect(validateEntry(entry)).toEqual(entry);
    expect(contentText(entry.content)).toBe('今天值得记下来。\n');
  });
  it('deduplicates normalized labels while preserving the display text', () => {
    expect(normalizeTags([' 生活 ', '生活', 'ＷＯＲＫ', 'work'])).toEqual([{ name: '生活' }, { name: 'ＷＯＲＫ' }]);
    expect(() => normalizeTags(['长'.repeat(25)])).toThrow('24');
    expect(() => normalizeTags(Array.from({ length: 11 }, (_, index) => String(index)))).toThrow('10');
  });
  it('validates title by Unicode code points, not UTF-16 units', () => {
    expect(() => validateEntry({ ...entryWithText(), title: '🌿'.repeat(120) })).not.toThrow();
    expect(() => validateEntry({ ...entryWithText(), title: '🌿'.repeat(121) })).toThrow('120');
  });
  it('rejects unknown schema versions and invalid moods', () => {
    expect(() => validateEntry({ ...entryWithText(), contentSchemaVersion: 2 })).toThrow('版本');
    expect(() => validateEntry({ ...entryWithText(), mood: 6 })).toThrow('心情');
  });
  it('requires an actual timestamp for moments', () => {
    expect(() => validateEntry({ ...entryWithText(), kind: 'moment', occurredAt: null })).toThrow('随记时间');
    expect(() => validateEntry({ ...entryWithText(), kind: 'moment', occurredAt: '2026-09-08T08:30:00Z' })).not.toThrow();
  });
  it('rejects missing or malformed timezones', () => {
    expect(() => validateEntry({ ...entryWithText(), timezone: undefined })).toThrow('时区');
    expect(() => validateEntry({ ...entryWithText(), timezone: 'Mars/Test' })).toThrow('时区');
  });
});

describe('rich text whitelist', () => {
  it('accepts the supported formatting without executing text that resembles HTML', () => {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>', marks: [{ type: 'bold' }] }] }] };
    expect(validateContent(content)).toEqual(content);
    expect(contentText(content)).toContain('<img');
  });
  it('rejects arbitrary HTML, links, unknown properties and image URLs', () => {
    for (const node of [
      { type: 'iframe', attrs: { src: 'https://example.com' } },
      { type: 'paragraph', attrs: { onclick: 'alert(1)' } },
      { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      { type: 'image', attrs: { src: 'data:image/png;base64,abc' } },
      { type: 'text', text: 'x', extra: true },
    ]) expect(() => validateContent({ type: 'doc', content: [node] })).toThrow();
  });
  it('bounds recursion, node count and text size', () => {
    let node = { type: 'paragraph' };
    for (let n = 0; n < 21; n++) node = { type: 'blockquote', content: [node] };
    expect(() => validateContent({ type: 'doc', content: [node] })).toThrow('结构过大');
    expect(() => validateContent({ type: 'doc', content: Array.from({ length: 10001 }, () => ({ type: 'paragraph' })) })).toThrow('结构过大');
    expect(() => validateContent(entryWithText('a'.repeat(100001)).content)).toThrow('长度');
  });
  it('rejects valid names in invalid parent-child structures', () => {
    for (const content of [
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] },
      { type: 'doc', content: [{ type: 'text', text: 'missing paragraph' }] },
      { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'paragraph' }] }] },
      { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'yes' }, content: [{ type: 'paragraph' }] }] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
    ]) expect(() => validateContent(content)).toThrow();
  });
});
