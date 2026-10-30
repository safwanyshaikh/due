export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Category {
  id: string;
  name: string;
  description?: string | null;
  createdAt?: string;
}

export type CompanyKind = 'company' | 'vendor';
export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface Company {
  id: string;
  kind: CompanyKind;
  name: string;
  slug?: string;
  officialWebsite?: string | null;
  description?: string | null;
  country?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  status: 'active' | 'archived';
  verificationStatus: VerificationStatus;
  verifiedAt?: string | null;
  verificationNote?: string | null;
  monitoringEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  sourceCount?: number;
}

export interface Intel {
  id: string;
  kind: 'offer_pattern' | 'partner' | string;
  data: unknown;
  sourceUrl?: string | null;
  fetchedAt?: string | null;
  method?: string | null;
  verificationStatus?: string | null;
}

export type SourceStatus = 'active' | 'failing' | 'blocked_robots' | 'inaccessible' | 'disabled';

export interface Source {
  id: string;
  companyId: string;
  companyName?: string | null;
  url: string;
  label?: string | null;
  sourceCategory: string;
  isOfficial: boolean;
  extractionMethod: 'html_text' | 'rss' | 'json' | 'sitemap';
  cssSelector?: string | null;
  priority: 'critical' | 'regular' | 'secondary';
  frequencyMinutes: number;
  enabled: boolean;
  status: SourceStatus;
  nextCheckAt?: string | null;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  lastChangeAt?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
}

export interface FetchRun {
  id: number | string;
  sourceId?: string;
  jobRunId?: number | string | null;
  startedAt?: string;
  finishedAt?: string | null;
  outcome: string;
  httpStatus?: number | null;
  error?: string | null;
  attempt?: number;
}

export interface Snapshot {
  id: number | string;
  sourceId?: string;
  fetchedAt: string;
  httpStatus?: number | null;
  contentHash?: string;
  contentType?: string | null;
  title?: string | null;
  textContent?: string | null;
  bytes?: number | null;
  durationMs?: number | null;
}

export interface RecordVersion {
  id: number | string;
  version: number;
  data: unknown;
  contentHash?: string;
  changeType: 'new' | 'modified' | 'manual_correction' | string;
  changedBy?: string | null;
  changedByName?: string | null;
  capturedAt: string;
}

export interface DataRecord {
  id: string;
  companyId: string;
  companyName?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  recordType: string;
  title?: string | null;
  url?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  currentVersion?: number;
  verificationStatus: 'pending' | 'approved' | 'rejected';
  sensitive?: boolean;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  versions?: RecordVersion[];
}

export interface Job {
  id: string;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastStatus?: string | null;
  lastRun?: { status?: string; startedAt?: string; finishedAt?: string | null } | null;
  config?: unknown;
}

export interface JobRun {
  id: number | string;
  jobId: string;
  triggeredBy?: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  stats?: Record<string, unknown> | null;
  error?: string | null;
}

export interface Alert {
  id: number | string;
  level: 'info' | 'important';
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  createdAt: string;
  readAt?: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface LoginEvent {
  id: number | string;
  userId?: string | null;
  email?: string | null;
  success: boolean;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  at: string;
}

export interface SessionRow {
  idHash?: string;
  id?: string;
  userId?: string;
  userEmail?: string | null;
  email?: string | null;
  createdAt?: string;
  expiresAt?: string;
  lastSeenAt?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  revokedAt?: string | null;
}

export interface AuditEntry {
  id: number | string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  at: string;
}

export interface Dashboard {
  companies: number;
  vendors: number;
  activeSources: number;
  monitoredSources: number;
  newRecords7d: number;
  updatedRecords7d: number;
  failedFetches7d: number;
  pendingVerification: number;
  latestRuns: JobRun[];
  automation: { jobs: Job[] };
}
