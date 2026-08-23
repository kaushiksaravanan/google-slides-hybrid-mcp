/**
 * @module api/client
 * @description Google Slides API client wrapper.
 *
 * Wraps every Google Slides and Drive API call with:
 * - Automatic retry with exponential backoff (via shared/retry.ts)
 * - Structured error handling via {@link SlidesApiError}
 * - Structured logging via shared/logger.ts
 *
 * All public methods are thin, well-typed wrappers around the raw
 * `googleapis` library and are designed to be consumed by the MCP tool
 * handlers in `tools.ts`.
 */

import type { slides_v1, drive_v3 } from 'googleapis';
import { getSlidesService, getDriveService, clearAuthCache } from './auth.js';
import type { ApiConfig } from '../shared/types.js';
import {
  SlidesApiError,
  createApiError,
} from '../shared/errors.js';
import { withGoogleApiRetry } from '../shared/retry.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('api.client');

// ─────────────────────────────────────────────────────────────────────────────
// Internal Service Accessors
// ─────────────────────────────────────────────────────────────────────────────

/** Cached service instances to avoid re-authenticating on every call. */
let _slidesService: slides_v1.Slides | null = null;
let _driveService: drive_v3.Drive | null = null;

/**
 * Get (or lazily create) the authenticated Slides service.
 *
 * @param config - Optional explicit API credentials.
 */
async function slides(config?: Partial<ApiConfig>): Promise<slides_v1.Slides> {
  if (!_slidesService || config) {
    _slidesService = await getSlidesService(config);
  }
  return _slidesService;
}

/**
 * Get (or lazily create) the authenticated Drive service.
 *
 * @param config - Optional explicit API credentials.
 */
async function drive(config?: Partial<ApiConfig>): Promise<drive_v3.Drive> {
  if (!_driveService || config) {
    _driveService = await getDriveService(config);
  }
  return _driveService;
}

/**
 * Invalidate cached service instances.
 * Call this after credential rotation or auth errors.
 */
export function clearServiceCache(): void {
  _slidesService = null;
  _driveService = null;
  log.info('Service cache cleared');
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a Google API call, converting raw googleapis errors into
 * structured {@link SlidesApiError} instances.
 *
 * On 401 (Unauthorized) or 403 (Forbidden) errors the service and auth
 * caches are cleared so that the next call re-authenticates.
 *
 * @param fn - The async operation to execute.
 * @param presentationId - Optional presentation ID for error context.
 * @returns The result of `fn`.
 */
async function wrapApiCall<T>(
  fn: () => Promise<T>,
  presentationId?: string,
): Promise<T> {
  try {
    return await withGoogleApiRetry(fn);
  } catch (error) {
    // On auth errors, invalidate caches so the next call re-authenticates.
    const statusCode =
      (error instanceof SlidesApiError ? error.statusCode : undefined) ??
      ((error as Record<string, unknown> | undefined)?.code as number | undefined) ??
      (((error as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined)?.status as number | undefined);
    if (statusCode === 401 || statusCode === 403) {
      log.warn('Auth error detected, clearing service and auth caches', { statusCode });
      clearServiceCache();
      clearAuthCache();
    }
    throw createApiError(error, presentationId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new Google Slides presentation.
 *
 * @param title - The title for the new presentation.
 * @param config - Optional explicit credentials.
 * @returns The full presentation resource from the API.
 */
export async function createPresentation(
  title: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$Presentation> {
  log.info('Creating presentation', { title });
  const service = await slides(config);

  const res = await wrapApiCall(
    () =>
      service.presentations.create({
        requestBody: { title },
      }),
  );

  log.info('Presentation created', {
    presentationId: res.data.presentationId,
    title: res.data.title,
  });
  return res.data;
}

/**
 * Retrieve a presentation by ID.
 *
 * @param presentationId - The presentation ID.
 * @param fields - Optional field mask to limit the response (e.g. "slides,title").
 * @param config - Optional explicit credentials.
 * @returns The presentation resource.
 */
export async function getPresentation(
  presentationId: string,
  fields?: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$Presentation> {
  log.debug('Getting presentation', { presentationId, fields });
  const service = await slides(config);

  const res = await wrapApiCall(
    () =>
      service.presentations.get({
        presentationId,
        ...(fields ? { fields } : {}),
      }),
    presentationId,
  );

  return res.data;
}

/**
 * Get all pages (slides) of a presentation.
 *
 * @param presentationId - The presentation ID.
 * @param config - Optional explicit credentials.
 * @returns Array of page resources.
 */
export async function getPresentationPages(
  presentationId: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$Page[]> {
  log.debug('Getting presentation pages', { presentationId });
  const pres = await getPresentation(
    presentationId,
    'slides',
    config,
  );
  return pres.slides ?? [];
}

/**
 * Get a specific page (slide) by its object ID.
 *
 * @param presentationId - The presentation ID.
 * @param pageId - The page object ID.
 * @param config - Optional explicit credentials.
 * @returns The page resource.
 */
export async function getPage(
  presentationId: string,
  pageId: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$Page> {
  log.debug('Getting page', { presentationId, pageId });
  const service = await slides(config);

  const res = await wrapApiCall(
    () =>
      service.presentations.pages.get({
        presentationId,
        pageObjectId: pageId,
      }),
    presentationId,
  );

  return res.data;
}

/**
 * Get a thumbnail URL for a specific page.
 *
 * @param presentationId - The presentation ID.
 * @param pageId - The page object ID.
 * @param thumbnailSize - Thumbnail size enum. Defaults to MEDIUM.
 * @param config - Optional explicit credentials.
 * @returns An object with `contentUrl` (the thumbnail image URL) and `width`/`height`.
 */
export async function getPageThumbnail(
  presentationId: string,
  pageId: string,
  thumbnailSize: 'SMALL' | 'MEDIUM' | 'LARGE' = 'MEDIUM',
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$Thumbnail> {
  log.debug('Getting page thumbnail', { presentationId, pageId, thumbnailSize });
  const service = await slides(config);

  const res = await wrapApiCall(
    () =>
      service.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId: pageId,
        'thumbnailProperties.thumbnailSize': thumbnailSize,
      }),
    presentationId,
  );

  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a batch of mutation requests to a presentation.
 *
 * @param presentationId - The presentation ID.
 * @param requests - Array of Google Slides API request objects.
 * @param writeControl - Optional write-control value for conditional writes.
 *   Supply the `requiredRevisionId` from a previous `get` to ensure you're
 *   writing against the expected revision.
 * @param config - Optional explicit credentials.
 * @returns The batch-update response containing reply objects for each request.
 */
export async function batchUpdate(
  presentationId: string,
  requests: slides_v1.Schema$Request[],
  writeControl?: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$BatchUpdatePresentationResponse> {
  log.info('Executing batch update', {
    presentationId,
    requestCount: requests.length,
  });
  const service = await slides(config);

  const requestBody: slides_v1.Schema$BatchUpdatePresentationRequest = {
    requests,
  };

  if (writeControl) {
    requestBody.writeControl = { requiredRevisionId: writeControl };
  }

  const res = await wrapApiCall(
    () =>
      service.presentations.batchUpdate({
        presentationId,
        requestBody,
      }),
    presentationId,
  );

  log.info('Batch update complete', {
    presentationId,
    repliesCount: res.data.replies?.length ?? 0,
  });
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Duplicate a slide within a presentation.
 *
 * @param presentationId - The presentation ID.
 * @param slideId - The object ID of the slide to duplicate.
 * @param insertionIndex - Optional zero-based index for the new slide.
 * @param config - Optional explicit credentials.
 * @returns The batch-update response.
 */
export async function duplicateSlide(
  presentationId: string,
  slideId: string,
  insertionIndex?: number,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$BatchUpdatePresentationResponse> {
  log.info('Duplicating slide', { presentationId, slideId, insertionIndex });

  const duplicateRequest: slides_v1.Schema$Request = {
    duplicateObject: {
      objectId: slideId,
    },
  };

  const requests: slides_v1.Schema$Request[] = [duplicateRequest];

  // If an insertion index is specified we need to move the duplicated slide
  // after creation. The duplicate is placed immediately after the original
  // by default, so we only move it if the caller wants it elsewhere.
  // We'll handle this after the duplicate completes.
  const response = await batchUpdate(presentationId, requests, undefined, config);

  // If caller specified an insertion index, move the duplicated slide.
  if (insertionIndex !== undefined && response.replies?.[0]?.duplicateObject?.objectId) {
    const newSlideId = response.replies[0].duplicateObject.objectId;
    await batchUpdate(
      presentationId,
      [
        {
          updateSlidesPosition: {
            slideObjectIds: [newSlideId],
            insertionIndex,
          },
        },
      ],
      undefined,
      config,
    );
  }

  return response;
}

/**
 * Delete a slide from a presentation.
 *
 * @param presentationId - The presentation ID.
 * @param slideId - The object ID of the slide to delete.
 * @param config - Optional explicit credentials.
 * @returns The batch-update response.
 */
export async function deleteSlide(
  presentationId: string,
  slideId: string,
  config?: Partial<ApiConfig>,
): Promise<slides_v1.Schema$BatchUpdatePresentationResponse> {
  log.info('Deleting slide', { presentationId, slideId });
  return batchUpdate(
    presentationId,
    [{ deleteObject: { objectId: slideId } }],
    undefined,
    config,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive-based Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a PDF export URL for a presentation.
 *
 * The URL returned is a direct Google Drive export link that can be
 * accessed with the current OAuth credentials. It triggers a download
 * of the presentation as a PDF.
 *
 * @param presentationId - The presentation ID.
 * @param config - Optional explicit credentials.
 * @returns The PDF export URL.
 */
export async function exportPdf(
  presentationId: string,
  config?: Partial<ApiConfig>,
): Promise<string> {
  log.info('Generating PDF export URL', { presentationId });

  // Verify the file exists (and is accessible) first.
  const driveService = await drive(config);
  await wrapApiCall(
    () =>
      driveService.files.get({
        fileId: presentationId,
        fields: 'id,name',
      }),
    presentationId,
  );

  // The Google Drive export URL pattern for PDFs.
  const exportUrl = `https://docs.google.com/presentation/d/${presentationId}/export/pdf`;
  log.info('PDF export URL generated', { presentationId, exportUrl });
  return exportUrl;
}

/**
 * Create a shareable link for a presentation by granting the specified role.
 *
 * @param presentationId - The presentation ID.
 * @param role - The permission role: "reader", "writer", or "commenter".
 * @param config - Optional explicit credentials.
 * @returns The shareable URL.
 */
export async function sharePresentation(
  presentationId: string,
  role: 'reader' | 'writer' | 'commenter' = 'reader',
  config?: Partial<ApiConfig>,
): Promise<string> {
  log.info('Sharing presentation', { presentationId, role });
  const driveService = await drive(config);

  await wrapApiCall(
    () =>
      driveService.permissions.create({
        fileId: presentationId,
        requestBody: {
          type: 'anyone',
          role,
        },
      }),
    presentationId,
  );

  const shareUrl = `https://docs.google.com/presentation/d/${presentationId}/edit?usp=sharing`;
  log.info('Presentation shared', { presentationId, shareUrl });
  return shareUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Extraction Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all text content from a page element, recursively handling
 * groups and text runs.
 *
 * @param element - A Google Slides page element.
 * @returns The concatenated plain text.
 */
export function extractElementText(
  element: slides_v1.Schema$PageElement,
): string {
  if (element.shape?.text?.textElements) {
    return element.shape.text.textElements
      .map((te: any) => te.textRun?.content ?? '')
      .join('');
  }
  if (element.table?.tableRows) {
    return extractTableText(element);
  }
  if (element.elementGroup?.children) {
    return element.elementGroup.children
      .map(extractElementText)
      .join('\n');
  }
  return '';
}

/**
 * Extract text from a table element.
 *
 * @param element - A Google Slides page element containing a table.
 * @returns Tab-separated rows of text.
 */
function extractTableText(element: slides_v1.Schema$PageElement): string {
  if (!element.table?.tableRows) return '';

  return element.table.tableRows
    .map((row) =>
      (row.tableCells ?? [])
        .map((cell) =>
          (cell.text?.textElements ?? [])
            .map((te) => te.textRun?.content ?? '')
            .join('')
            .trim(),
        )
        .join('\t'),
    )
    .join('\n');
}

/**
 * Extract all text from a presentation for summarization.
 *
 * @param presentationId - The presentation ID.
 * @param config - Optional explicit credentials.
 * @returns An array of objects, one per slide, containing the slide's
 *   text content and speaker notes.
 */
export async function extractAllText(
  presentationId: string,
  config?: Partial<ApiConfig>,
): Promise<
  Array<{
    slideIndex: number;
    slideId: string;
    text: string;
    notes: string;
  }>
> {
  log.debug('Extracting all text', { presentationId });
  const pres = await getPresentation(presentationId, undefined, config);
  const slidesArr = pres.slides ?? [];

  return slidesArr.map((slide, index) => {
    // Extract text from page elements.
    const elements = slide.pageElements ?? [];
    const text = elements
      .map(extractElementText)
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // Extract speaker notes.
    const notesPage = slide.slideProperties?.notesPage;
    const notesElements = notesPage?.pageElements ?? [];
    const notes = notesElements
      .map(extractElementText)
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      slideIndex: index,
      slideId: slide.objectId ?? `slide_${index}`,
      text,
      notes,
    };
  });
}
