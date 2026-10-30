import type { ImportCandidate } from './csv';
import { previewCSV, type CsvPreview } from './csv';
import type { Commitment } from './types';

export class IntegrationDisabledError extends Error {
  constructor(id: string, reason: string) {
    super(`${id} is disabled: ${reason}`);
    this.name = 'IntegrationDisabledError';
  }
}

export interface IntakeAdapter {
  id: string;
  label: string;
  status: 'live' | 'disabled';
  /** Why it is disabled and what must happen before it can be enabled. */
  note: string;
  /** Items proposed to the user. Nothing is saved without preview and confirmation. */
  propose(input?: string, existing?: Commitment[]): Promise<ImportCandidate[] | CsvPreview>;
}

export const manualEntryAdapter: IntakeAdapter = {
  id: 'manual',
  label: 'Manual entry',
  status: 'live',
  note: 'You type in what you owe. Nothing is read from anywhere else.',
  propose: async () => [],
};

export const csvImportAdapter: IntakeAdapter = {
  id: 'csv',
  label: 'CSV import (file you choose)',
  status: 'live',
  note: 'Parsed in your browser. You preview and confirm every row. The raw file is not uploaded or stored.',
  propose: async (input = '', existing = []) => previewCSV(input, existing),
};

function disabled(id: string, label: string, note: string): IntakeAdapter {
  return {
    id,
    label,
    status: 'disabled',
    note,
    propose: async () => {
      throw new IntegrationDisabledError(id, note);
    },
  };
}

export const emailForwardAdapter = disabled(
  'email_forward',
  'Email intake',
  'Future only. Reading mailbox content needs restricted Google access and a separate platform security review. For now, billing-email labels are just labels; we are not reading that inbox.',
);

export const whatsappBusinessAdapter = disabled(
  'whatsapp_business',
  'WhatsApp (official business number)',
  'Future only. Would accept only a specific message you deliberately send to the official business number after clear notice and opt-in. It cannot read your personal chats.',
);

export const smsAdapter = disabled(
  'sms',
  'SMS',
  'Future only. No broad SMS permission will be requested. Any SMS design needs Google Play policy and legal review first.',
);

export const accountAggregatorAdapter = disabled(
  'account_aggregator',
  'Account Aggregator (bank data)',
  'Future only. Needs an eligible partner, a consent flow, ecosystem certification and legal review.',
);

export const ALL_ADAPTERS: IntakeAdapter[] = [
  manualEntryAdapter,
  csvImportAdapter,
  emailForwardAdapter,
  whatsappBusinessAdapter,
  smsAdapter,
  accountAggregatorAdapter,
];
