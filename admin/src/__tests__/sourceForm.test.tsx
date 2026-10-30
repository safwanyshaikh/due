import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { frequencyToMinutes, minutesToFrequency, checkedEvery } from '../lib/format';
import { SourceForm } from '../pages/Sources';
import type { Company, Source } from '../lib/types';
import { renderAs } from './helpers';

describe('frequency conversion', () => {
  it('converts hours and days to minutes', () => {
    expect(frequencyToMinutes(1, 'hours')).toBe(60);
    expect(frequencyToMinutes(6, 'hours')).toBe(360);
    expect(frequencyToMinutes(1, 'days')).toBe(1440);
    expect(frequencyToMinutes(7, 'days')).toBe(10080);
    expect(frequencyToMinutes(0, 'days')).toBe(0);
    expect(frequencyToMinutes(Number.NaN, 'hours')).toBe(0);
  });
  it('splits minutes back to the friendliest unit', () => {
    expect(minutesToFrequency(10080)).toEqual({ amount: 7, unit: 'days' });
    expect(minutesToFrequency(1440)).toEqual({ amount: 1, unit: 'days' });
    expect(minutesToFrequency(360)).toEqual({ amount: 6, unit: 'hours' });
  });
  it('labels polling as a schedule', () => {
    expect(checkedEvery(60)).toBe('Checked every 1 hour');
    expect(checkedEvery(10080)).toBe('Checked every 7 days');
  });
});

const companies: Company[] = [
  { id: 'c1', kind: 'vendor', name: 'Vendor One', status: 'active', verificationStatus: 'pending', monitoringEnabled: true },
];

describe('SourceForm', () => {
  it('submits frequency in minutes (days)', async () => {
    const onSubmit = vi.fn(async () => true);
    renderAs('editor', <SourceForm companies={companies} defaultCompanyId="c1" onSubmit={onSubmit} onCancel={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('URL'), 'https://example.test/terms');
    const every = screen.getByLabelText('Every');
    await user.clear(every);
    await user.type(every, '3');
    await user.selectOptions(screen.getByLabelText('Unit'), 'days');
    expect(screen.getByTestId('freq-preview')).toHaveTextContent('Checked every 3 days (4320 minutes)');
    await user.click(screen.getByRole('button', { name: /save source/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]).toEqual([expect.objectContaining({ companyId: 'c1', url: 'https://example.test/terms', frequencyMinutes: 4320 })]);
  });

  it('submits frequency in minutes (hours) and prefills from an existing source', async () => {
    const onSubmit = vi.fn(async () => true);
    const existing: Source = {
      id: 's1',
      companyId: 'c1',
      url: 'https://example.test/feed',
      label: 'Feed',
      sourceCategory: 'rss',
      isOfficial: true,
      extractionMethod: 'rss',
      priority: 'critical',
      frequencyMinutes: 1440,
      enabled: true,
      status: 'active',
    };
    renderAs('editor', <SourceForm source={existing} companies={companies} onSubmit={onSubmit} onCancel={() => undefined} />);
    const user = userEvent.setup();
    expect(screen.getByLabelText('Every')).toHaveValue(1);
    expect(screen.getByLabelText('Unit')).toHaveValue('days');
    await user.clear(screen.getByLabelText('Every'));
    await user.type(screen.getByLabelText('Every'), '12');
    await user.selectOptions(screen.getByLabelText('Unit'), 'hours');
    await user.click(screen.getByRole('button', { name: /save source/i }));
    expect(onSubmit.mock.calls[0]).toEqual([expect.objectContaining({ frequencyMinutes: 720, extractionMethod: 'rss', priority: 'critical' })]);
  });

  it('rejects a non-http URL', async () => {
    const onSubmit = vi.fn(async () => true);
    renderAs('editor', <SourceForm companies={companies} defaultCompanyId="c1" onSubmit={onSubmit} onCancel={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('URL'), 'ftp://example.test');
    await user.click(screen.getByRole('button', { name: /save source/i }));
    expect(await screen.findByText(/must start with http/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
