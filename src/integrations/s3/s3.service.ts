import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { AdminConfig } from '../../common/config/configuration';

/**
 * Sender ID documents live in a private, server-side-encrypted bucket that blocks
 * public access. admin-core's IAM role is read-only and scoped to the bucket prefix;
 * object keys never reach the browser — the frontend asks for a document and gets a
 * short-lived presigned URL back.
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly cfg: AdminConfig['s3'];
  private readonly urlTtl: number;

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    const admin = config.get('admin', { infer: true });
    this.cfg = admin.s3;
    this.urlTtl = admin.limits.documentUrlTtlSeconds;
    this.client = new S3Client({ region: this.cfg.region });
  }

  /** Refuses any key outside the sender ID prefix, whatever the database says. */
  private assertSenderIdKey(objectKey: string) {
    if (
      !objectKey.startsWith(this.cfg.senderIdPrefix) ||
      objectKey.includes('..')
    ) {
      throw new NotFoundException('Document not available');
    }
  }

  /**
   * Presigned GET, valid for 5 minutes. `attachment` for downloads, `inline` for the
   * in-app PDF and image preview.
   */
  async presignSenderIdDocument(
    objectKey: string,
    fileName: string,
    disposition: 'attachment' | 'inline',
  ): Promise<{ url: string; expiresAt: Date }> {
    this.assertSenderIdKey(objectKey);
    const command = new GetObjectCommand({
      Bucket: this.cfg.senderIdBucket,
      Key: objectKey,
      ResponseContentDisposition: `${disposition}; filename="${sanitiseFileName(fileName)}"`,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.urlTtl,
    });
    return { url, expiresAt: new Date(Date.now() + this.urlTtl * 1000) };
  }

  /** Streams an object through admin-core, used when zipping a whole application. */
  async openSenderIdDocument(objectKey: string): Promise<Readable> {
    this.assertSenderIdKey(objectKey);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.senderIdBucket, Key: objectKey }),
    );
    if (!result.Body)
      throw new NotFoundException('Document body missing in S3');
    return result.Body as Readable;
  }

  async senderIdDocumentExists(objectKey: string): Promise<boolean> {
    this.assertSenderIdKey(objectKey);
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.cfg.senderIdBucket,
          Key: objectKey,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- exports

  async putExport(
    key: string,
    body: string | Buffer,
    contentType = 'text/csv',
  ): Promise<string> {
    const objectKey = `${this.cfg.exportPrefix}${key}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.exportBucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    return objectKey;
  }

  /** Short-lived download link for a finished export. */
  async presignExport(objectKey: string, fileName: string, ttlSeconds: number) {
    const command = new GetObjectCommand({
      Bucket: this.cfg.exportBucket,
      Key: objectKey,
      ResponseContentDisposition: `attachment; filename="${sanitiseFileName(fileName)}"`,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: ttlSeconds,
    });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 180);
}
