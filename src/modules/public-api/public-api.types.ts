export const API_SCOPES = ['jobs:read', 'jobs:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export interface ApiPrincipal {
  accountId: string;
  credentialId: string;
  scopes: ApiScope[];
}
export interface SealedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface ApiJobInput {
  testMode?: boolean;
  zplContent?: string;
  templateId?: string;
  templateVersion?: number;
  rows?: Record<string, string | number>[];
  labelSize: string;
  callbackId?: string;
}
export type ApiJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export const PUBLIC_API_CONVERSION = Symbol('PUBLIC_API_CONVERSION');
export interface ApiConversionPort {
  run(input: {
    operationId: string;
    accountId: string;
    zplContent: string;
    labelSize: string;
  }): Promise<{ jobId: string; status: string }>;
  result(
    jobId: string,
    accountId: string,
  ): Promise<{ url: string; filename: string }>;
}
