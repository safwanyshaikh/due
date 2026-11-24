/** Public surface of the Savings engine. UI code imports only from here. */
export * from './types';
export {
  defaultSavingsState,
  defaultSavingsProfile,
  normaliseSavingsState,
  setCityPack,
  setHomeLocality,
  upsertCommuteLeg,
  removeCommuteLeg,
  setOverride,
  setCommunityOptIn,
  markResearchSent,
  type CommuteLegInput,
} from './state';
export { parseStatementText } from './statement';
export { detectRecurring, railFor, statementMerchant } from './recurring';
export { matchModule, matchesKey, type ModuleMatch } from './match';
export {
  computeMoves,
  rankMoves,
  foundTotalInr,
  TYPICAL,
  CONFIDENCE_WEIGHT,
  DEBT_LEGAL_NOTE,
  LOAN_LEGAL_NOTE,
  type MovesResult,
  obligationMonthlyInr,
  targetObligationId,
  RBI_SOURCE,
} from './engine';
export {
  ledgerFromMoves,
  markMove,
  proveSavings,
  returnRatio,
  planFeeMonthlyInr,
  type ReturnRatio,
} from './ledger';
export { researchLabel, researchNeeds, unsentResearch } from './research';
export {
  fetchSavingsCatalog,
  postResearch,
  postReport,
  fetchCommunity,
  loadSavingsCatalogCache,
  saveSavingsCatalogCache,
  parseSavingsCatalog,
  roundReportInr,
  SAVINGS_CATALOG_PATH,
  SAVINGS_CATALOG_CACHE_KEY,
  type SavingsCatalogResult,
  type CommunityItem,
  type CommunityResponse,
  type ResearchResponse,
  type SavingsReport,
  type SavingsFetchLike,
  type ApiOpts,
} from './api';
export { parseCardStatementSummary, cardKey } from './cardSummary';
export { parseLoanStatement, loanKey } from './loanSummary';
export { addCardBill, addLoanEmi, saveCardStatement, saveLoanStatement, nextOnDay } from './adopt';
export { lineKindOf, statementPeriodOf } from './statement';
export { statementAlias, STATEMENT_ALIASES, type StatementAlias } from './recurring';
export { bouncesIn12Months, BOUNCE_TRANSFER_NOTE } from './engine';
export {
  parseBankStatementSummary,
  incomeTiming,
  balanceAt,
  priceSteps,
  bankMonths,
  type IncomeTimingMonth,
} from './bankSummary';
export { saveBankStatement } from './state';
export { timingSentence } from './engine';
export { isMultiLineBankText, isTwoDateBankText, holderName } from './statement';
