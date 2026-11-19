/**
 * GitView Phase 5 — Milestone 5: Archive Extraction Domain Errors
 */

import { AppError } from '../../utils/AppError.js';

export const ArchiveErrorCode = Object.freeze({
  ARCHIVE_DOWNLOAD_FAILED: 'ARCHIVE_DOWNLOAD_FAILED',
  ARCHIVE_TOO_LARGE: 'ARCHIVE_TOO_LARGE',
  ARCHIVE_TIMEOUT: 'ARCHIVE_TIMEOUT',
  ARCHIVE_CORRUPTED: 'ARCHIVE_CORRUPTED',
  ARCHIVE_PATH_TRAVERSAL: 'ARCHIVE_PATH_TRAVERSAL',
  ARCHIVE_UNSAFE_ENTRY: 'ARCHIVE_UNSAFE_ENTRY',
  ARCHIVE_ENTRY_LIMIT_EXCEEDED: 'ARCHIVE_ENTRY_LIMIT_EXCEEDED',
  ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED: 'ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED',
  ARCHIVE_EXTRACTION_FAILED: 'ARCHIVE_EXTRACTION_FAILED',
});

export class ArchiveExtractionError extends AppError {
  constructor(code, message) {
    super(400, code, message);
    this.name = 'ArchiveExtractionError';
    this.errorCode = code;
  }
}
