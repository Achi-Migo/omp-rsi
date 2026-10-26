export interface VerificationViolation {
  rule: string;
  message: string;
  context: Record<string, unknown>;
}

export interface VerificationReport {
  readonly ok: boolean;
  target: string;
  timestamp: string;
  totalRunsScanned: number;
  totalEventsScanned: number;
  violations: VerificationViolation[];
}

export function verifyJsonl(jsonlPath: string): Promise<VerificationReport>;
export function verifyDatabase(dbPath: string): VerificationReport;
