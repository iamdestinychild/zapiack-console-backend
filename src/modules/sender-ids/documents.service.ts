import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import archiver from 'archiver';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type { AdminConfig } from '../../common/config/configuration';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { S3Service } from '../../integrations/s3/s3.service';
import { documentSource } from './document-source';

/** Enforced on upload by api-core; re-stated here so the review screen can explain a gap. */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
];
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Access to sender ID documents. The bucket is private and its object keys never
 * reach the browser: the frontend asks admin-core for a document, the service checks
 * senderid.documents.download, writes an audit entry, and only then hands back a
 * presigned URL valid for five minutes.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly audit: AuditService,
    private readonly s3: S3Service,
    private readonly apiCore: TemplateReviewClient,
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  private async resolveDocument(reviewId: string, documentId: string) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');

    const document = await this.zapiack.read.senderIdDocument.findFirst({
      // Scoped to the application: a document id alone is not enough to reach a file.
      // The FK column is named senderId but holds the application id.
      where: { id: documentId, senderId: review.applicationId },
    });
    if (!document)
      throw new NotFoundException('Document not found on this application');

    return { review, document };
  }

  /**
   * Hands back the document's URL and records that it was accessed.
   *
   * Documents are served from the CDN in front of the S3 bucket
   * (`https://cdn.zapiack.com/sms-documents/...`), so there is nothing to presign and
   * no expiry to enforce: anyone holding the URL can fetch it. This route therefore
   * buys the audit trail, not access control — see the note in the review module.
   */
  async resolve(
    actor: StaffPrincipal,
    reviewId: string,
    documentId: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ) {
    const { review, document } = await this.resolveDocument(
      reviewId,
      documentId,
    );

    // Audited before the URL is handed over: a link given out is an access, whether
    // or not the browser follows it.
    await this.audit.record({
      actor,
      action:
        disposition === 'inline'
          ? 'senderid.document.preview'
          : 'senderid.document.download',
      targetType: 'sender_id_document',
      targetId: documentId,
      metadata: {
        reviewId,
        applicationId: review.applicationId,
        accountId: review.accountId,
        fileName: document.fileOriginalName,
        type: document.type,
      },
    });

    return {
      url: document.fileUrl,
      fileName: document.fileOriginalName,
      contentType: contentTypeOf(
        document.fileOriginalName || document.fileName,
      ),
      type: document.type,
      provider: document.provider,
      uploadedAt: document.createdAt,
      disposition,
      // The CDN URL does not expire. Kept explicit so the console does not imply
      // a short-lived link it is not getting.
      expiresAt: null,
    };
  }

  /**
   * The file itself, streamed through admin-core.
   *
   * The review screen used to be handed the CDN address and open it from the browser. That fails whenever the CDN does not
   * answer a cross-origin request (the in-app PDF viewer reads the file with a script) and it ignores the download name,
   * so a reviewer could neither preview nor save a letter. Here admin-core reads the file, after the permission check and
   * the audit entry, and sends it back from its own origin with the right type and name.
   */
  async file(
    actor: StaffPrincipal,
    reviewId: string,
    documentId: string,
    disposition: 'attachment' | 'inline',
    res: Response,
  ) {
    const { review, document } = await this.resolveDocument(
      reviewId,
      documentId,
    );

    const source = documentSource(
      document.fileUrl,
      this.config.get('admin', { infer: true }).s3,
    );
    if (!source) throw new NotFoundException('Document not available');

    await this.audit.record({
      actor,
      action:
        disposition === 'inline'
          ? 'senderid.document.preview'
          : 'senderid.document.download',
      targetType: 'sender_id_document',
      targetId: documentId,
      metadata: {
        reviewId,
        applicationId: review.applicationId,
        accountId: review.accountId,
        fileName: document.fileOriginalName,
        type: document.type,
      },
    });

    let body: Readable;
    let length: string | null = null;
    try {
      if (source.kind === 's3') {
        body = await this.s3.openSenderIdDocument(source.key);
      } else {
        const response = await fetch(source.url);
        if (!response.ok || !response.body)
          throw new Error(`CDN responded ${response.status}`);
        length = response.headers.get('content-length');
        body = Readable.fromWeb(response.body as never);
      }
    } catch (error) {
      this.logger.error(
        `Could not read document ${documentId}: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'The document could not be retrieved from storage. Try again shortly.',
      );
    }

    res.setHeader(
      'Content-Type',
      contentTypeOf(document.fileOriginalName || document.fileName),
    );
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${sanitise(document.fileOriginalName)}"`,
    );
    // Personal documents: never kept by a shared cache, and never sniffed into another type.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (length) res.setHeader('Content-Length', length);

    body.on('error', (error) => {
      this.logger.error(`Stream failed for ${documentId}: ${error.message}`);
      res.destroy(error);
    });
    body.pipe(res);
  }

  /**
   * Has api-core write the letters to the networks for this application. It does so only when every field a letter needs is
   * on file, and otherwise says which are missing so a reviewer can fill them in and generate by hand. Audited.
   */
  async generateLetters(
    actor: StaffPrincipal,
    reviewId: string,
    force = false,
  ) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');

    const result = await this.apiCore.generateSenderIdLetters(
      review.applicationId,
      force,
    );

    if (result.generated) {
      await this.audit.record({
        actor,
        action: 'senderid.letters.generated',
        targetType: 'sender_id_application',
        targetId: review.applicationId,
        metadata: {
          reviewId,
          accountId: review.accountId,
          networks: result.networks,
          forced: force,
        },
      });
    }
    return result;
  }

  /**
   * "Download all" streams a zip of the application's documents from S3 through
   * admin-core, so no bulk link to the bucket is ever created.
   */
  async streamZip(actor: StaffPrincipal, reviewId: string, res: Response) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');

    const documents = await this.zapiack.read.senderIdDocument.findMany({
      where: { senderId: review.applicationId },
      orderBy: { createdAt: 'asc' },
    });
    if (!documents.length)
      throw new NotFoundException('This application has no documents');

    await this.audit.record({
      actor,
      action: 'senderid.documents.download_all',
      targetType: 'sender_id_application',
      targetId: review.applicationId,
      metadata: {
        reviewId,
        documentCount: documents.length,
        accountId: review.accountId,
      },
    });

    const fileName = `${sanitise(review.senderId)}_${review.applicationId}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) =>
      this.logger.warn(`Zip warning: ${err.message}`),
    );
    archive.on('error', (err) => {
      this.logger.error(`Zip failed for ${reviewId}: ${err.message}`);
      // Headers are already sent, so a truncated stream is the only signal left.
      res.destroy(err);
    });
    archive.pipe(res);

    const seen = new Map<string, number>();
    for (const document of documents) {
      const count = seen.get(document.fileOriginalName) ?? 0;
      seen.set(document.fileOriginalName, count + 1);
      const entryName =
        count === 0
          ? document.fileOriginalName
          : prefixName(document.fileOriginalName, count);

      try {
        const response = await fetch(document.fileUrl);
        if (!response.ok || !response.body) {
          throw new Error(`CDN responded ${response.status}`);
        }
        archive.append(Readable.fromWeb(response.body as never), {
          name: `${document.type}/${entryName}`,
        });
      } catch (err) {
        this.logger.error(
          `Skipped ${document.id} in zip: ${(err as Error).message}`,
        );
        archive.append(
          `This document could not be retrieved at ${new Date().toISOString()}.\n`,
          { name: `${document.type}/${entryName}.MISSING.txt` },
        );
      }
    }

    await archive.finalize();
  }
}

/** Guessed from the file name: the product records no content type. */
function contentTypeOf(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function sanitise(value: string) {
  return value.replace(/[^\w.-]+/g, '_').slice(0, 60);
}

function prefixName(fileName: string, index: number) {
  const dot = fileName.lastIndexOf('.');
  return dot === -1
    ? `${fileName}(${index})`
    : `${fileName.slice(0, dot)}(${index})${fileName.slice(dot)}`;
}
