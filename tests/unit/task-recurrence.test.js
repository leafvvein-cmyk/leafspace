import { describe, expect, it } from 'vitest';
import { nextTaskDueAt, normalizeTaskRecurrence } from '@diary/contracts/task-recurrence';

describe('task recurrence calendar rules', () => {
  it('keeps the same wall-clock time across a daylight-saving boundary', () => {
    expect(nextTaskDueAt('2026-03-07T14:00:00.000Z', 'America/New_York', { frequency: 'daily', interval: 1 }))
      .toBe('2026-03-08T13:00:00.000Z');
  });

  it('moves through selected weekdays and then advances by the chosen week interval', () => {
    const rule = { frequency: 'weekly', interval: 2, weekdays: [1, 3, 5] };
    expect(nextTaskDueAt('2026-09-09T01:00:00.000Z', 'Asia/Shanghai', rule)).toBe('2026-09-11T01:00:00.000Z');
    expect(nextTaskDueAt('2026-09-11T01:00:00.000Z', 'Asia/Shanghai', rule)).toBe('2026-09-21T01:00:00.000Z');
  });

  it('clamps a monthly day to month end without losing the original rule', () => {
    const rule = { frequency: 'monthly', interval: 1, dayOfMonth: 31 };
    expect(nextTaskDueAt('2026-01-31T01:00:00.000Z', 'Asia/Shanghai', rule)).toBe('2026-02-28T01:00:00.000Z');
    expect(nextTaskDueAt('2026-02-28T01:00:00.000Z', 'Asia/Shanghai', rule)).toBe('2026-03-31T01:00:00.000Z');
  });

  it('fills backward-compatible weekly and monthly defaults from the due date', () => {
    expect(normalizeTaskRecurrence({ frequency: 'weekly', interval: 1 }, '2026-09-09T01:00:00.000Z', 'Asia/Shanghai').weekdays).toEqual([3]);
    expect(normalizeTaskRecurrence({ frequency: 'monthly', interval: 1 }, '2026-09-09T01:00:00.000Z', 'Asia/Shanghai').dayOfMonth).toBe(9);
  });

  it('rejects empty weekly selections and invalid monthly dates', () => {
    expect(() => normalizeTaskRecurrence({ frequency: 'weekly', interval: 1, weekdays: [] }, '2026-09-09T01:00:00Z', 'Asia/Shanghai')).toThrow('每周');
    expect(() => normalizeTaskRecurrence({ frequency: 'monthly', interval: 1, dayOfMonth: 32 }, '2026-09-09T01:00:00Z', 'Asia/Shanghai')).toThrow('每月');
  });
});
