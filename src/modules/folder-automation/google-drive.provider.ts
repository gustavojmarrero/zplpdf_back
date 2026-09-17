import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash, randomUUID } from 'node:crypto';
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];
const FILE_FIELDS =
  'id,mimeType,parents,trashed,headRevisionId,size,appProperties,capabilities(canAddChildren,canListChildren,canDownload),md5Checksum';
export class DriveProviderError extends Error {
  constructor(readonly status?: number) {
    super('DRIVE_PROVIDER_REQUEST_FAILED');
  }
}
@Injectable()
export class GoogleDriveProvider {
  constructor(private readonly config: ConfigService) {}
  settings() {
    const clientId = this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID'),
      clientSecret = this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET'),
      redirectUri = this.config.get<string>('GOOGLE_DRIVE_REDIRECT_URI');
    if (
      !clientId ||
      !clientSecret ||
      !redirectUri ||
      !redirectUri.startsWith('https://')
    )
      throw new ServiceUnavailableException('GOOGLE_DRIVE_OAUTH_UNAVAILABLE');
    return { clientId, clientSecret, redirectUri };
  }
  authorization(state: string, challenge: string) {
    const c = this.settings();
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: DRIVE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
  }
  private async token(fields: Record<string, string>) {
    const c = this.settings();
    try {
      return (
        await axios.post(
          'https://oauth2.googleapis.com/token',
          new URLSearchParams({
            ...fields,
            client_id: c.clientId,
            client_secret: c.clientSecret,
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
            maxRedirects: 0,
            proxy: false,
            maxContentLength: 65536,
          },
        )
      ).data;
    } catch (e) {
      throw new DriveProviderError(e?.response?.status);
    }
  }
  exchange(code: string, verifier: string) {
    return this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.settings().redirectUri,
    });
  }
  async refresh(refreshToken: string) {
    const row = await this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (typeof row.access_token !== 'string') throw new DriveProviderError();
    return row.access_token as string;
  }
  async picker(refreshToken: string) {
    const appId = this.config.get<string>('GOOGLE_DRIVE_PICKER_APP_ID');
    if (!appId || !/^\d+$/.test(appId))
      throw new ServiceUnavailableException('GOOGLE_DRIVE_PICKER_UNAVAILABLE');
    const row = await this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (
      typeof row.access_token !== 'string' ||
      !Number.isFinite(row.expires_in) ||
      row.expires_in <= 0 ||
      row.expires_in > 86400
    )
      throw new DriveProviderError();
    return {
      accessToken: row.access_token,
      expiresIn: row.expires_in,
      appId,
      scopes: DRIVE_SCOPES,
    };
  }
  async revoke(token: string) {
    try {
      await axios.post(
        'https://oauth2.googleapis.com/revoke',
        new URLSearchParams({ token }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
          maxRedirects: 0,
          proxy: false,
          maxContentLength: 65536,
        },
      );
    } catch (e) {
      if (
        e?.response?.status !== 400 ||
        e?.response?.data?.error !== 'invalid_token'
      )
        throw new DriveProviderError(e?.response?.status);
    }
  }
  private async api(
    token: string,
    path: string,
    params: any = {},
    method = 'GET',
    data?: any,
    headers: any = {},
  ) {
    try {
      return (
        await axios.request({
          url: `https://www.googleapis.com${path}`,
          method,
          data,
          params,
          headers: { Authorization: `Bearer ${token}`, ...headers },
          timeout: 15000,
          maxRedirects: 0,
          proxy: false,
          maxContentLength: 12 * 1024 * 1024,
          maxBodyLength: 21 * 1024 * 1024,
        })
      ).data;
    } catch (e) {
      throw new DriveProviderError(e?.response?.status);
    }
  }
  file(token: string, id: string) {
    return this.api(token, `/drive/v3/files/${encodeURIComponent(id)}`, {
      fields: FILE_FIELDS,
    });
  }
  async startToken(token: string) {
    const value = (await this.api(token, '/drive/v3/changes/startPageToken'))
      .startPageToken;
    if (typeof value !== 'string' || !value) throw new DriveProviderError();
    return value;
  }
  listFiles(token: string, folder: string, pageToken?: string) {
    return this.api(token, '/drive/v3/files', {
      q: `'${folder}' in parents and trashed = false`,
      pageSize: 100,
      pageToken,
      fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
    });
  }
  changes(token: string, pageToken: string) {
    return this.api(token, '/drive/v3/changes', {
      pageToken,
      pageSize: 100,
      spaces: 'drive',
      fields: `nextPageToken,newStartPageToken,changes(removed,fileId,file(${FILE_FIELDS}))`,
    });
  }
  async revision(
    token: string,
    fileId: string,
    revisionId: string,
    maxBytes = 1024 * 1024,
  ) {
    try {
      const response = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`,
        {
          params: { alt: 'media' },
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'arraybuffer',
          timeout: 15000,
          maxRedirects: 0,
          proxy: false,
          maxContentLength: Math.min(maxBytes, 20 * 1024 * 1024),
        },
      );
      return Buffer.from(response.data);
    } catch (e) {
      throw new DriveProviderError(e?.response?.status);
    }
  }
  async outputId(token: string) {
    const data = await this.api(token, '/drive/v3/files/generateIds', {
      count: 1,
      space: 'drive',
      type: 'files',
    });
    if (typeof data.ids?.[0] !== 'string') throw new DriveProviderError();
    return data.ids[0] as string;
  }
  async upload(
    token: string,
    id: string,
    folder: string,
    pdf: Buffer,
    runId: string,
  ) {
    const boundary = `zplpdf_${randomUUID()}`;
    const metadata = {
      id,
      name: `${runId}.pdf`,
      mimeType: 'application/pdf',
      parents: [folder],
      appProperties: { zplpdfOutput: 'true', zplpdfRunId: runId },
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    try {
      await this.api(
        token,
        '/upload/drive/v3/files',
        { uploadType: 'multipart', fields: 'id' },
        'POST',
        body,
        { 'Content-Type': `multipart/related; boundary=${boundary}` },
      );
    } catch (e) {
      if (!(e instanceof DriveProviderError) || e.status !== 409) throw e;
    }
    const existing = await this.file(token, id);
    if (
      existing.trashed ||
      existing.md5Checksum !== createHash('md5').update(pdf).digest('hex') ||
      existing.id !== id ||
      existing.appProperties?.zplpdfRunId !== runId ||
      !existing.parents?.includes(folder) ||
      existing.mimeType !== 'application/pdf'
    )
      throw new DriveProviderError();
    return existing;
  }
}
