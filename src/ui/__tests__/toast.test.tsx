// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../components/Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger({ undo }: { undo: () => void }) {
  const t = useToast();
  return (
    <button type="button" onClick={() => t.show({ message: 'Moved Netflix', undo })}>
      go
    </button>
  );
}

describe('Undo toast', () => {
  it('stays for at least 6 seconds and calls undo once', () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Trigger undo={undo} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    const btn = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(btn);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('toast').textContent).toMatch(/Undone/);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('is announced politely', () => {
    render(
      <ToastProvider>
        <Trigger undo={() => undefined} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});
