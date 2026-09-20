import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import archiver from 'archiver';
import type { Response } from 'express';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { S3Service } from '../../integrations/s3/s3.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';

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
  ) {}

  private async resolve(reviewId: string, documentId: string) {
    const review = await this.admin.senderIdReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) throw new NotFoundException('Review not found');

    const document = await this.zapiack.read.senderIdDocument.findFirst({
      // Scoped to the application: a document id alone is not enough to reach a file.
      where: { id: documentId, applicationId: review.applicationId },
    });
    if (!document)
      throw new NotFoundException('Document not found on this application');

    return { review, document };
  }

  async presign(
    actor: StaffPrincipal,
    reviewId: string,
    documentId: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ) {
    const { review, document } = await this.resolve(reviewId, documentId);

    // Audited before the URL is minted: a link handed out is a download, whether or
    // not the browser follows it.
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
        fileName: document.fileName,
        kind: document.kind,
      },
    });

    const link = await this.s3.presignSenderIdDocument(
      document.objectKey,
      document.fileName,
      disposition,
    );

    return {
      url: link.url,
      expiresAt: link.expiresAt,
      fileName: document.fileName,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      disposition,
    };
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
      where: { applicationId: review.applicationId },
      orderBy: { uploadedAt: 'asc' },
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
      // Headers are already sent, so the only honest signal left is a truncated stream.
      res.destroy(err);
    });
    archive.pipe(res);

    const seen = new Map<string, number>();
    for (const document of documents) {
      // Two files named the same would silently overwrite inside the archive.
      const count = seen.get(document.fileName) ?? 0;
      seen.set(document.fileName, count + 1);
      const entryName =
        count === 0 ? document.fileName : prefixName(document.fileName, count);

      try {
        const body = await this.s3.openSenderIdDocument(document.objectKey);
        archive.append(body, { name: `${document.kind}/${entryName}` });
      } catch (err) {
        this.logger.error(
          `Skipped ${document.id} in zip: ${(err as Error).message}`,
        );
        archive.append(
          `This document could not be retrieved from storage at ${new Date().toISOString()}.\n`,
          { name: `${document.kind}/${entryName}.MISSING.txt` },
        );
      }
    }

    await archive.finalize();
  }
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
