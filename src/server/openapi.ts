/**
 * @module server/openapi
 * @description OpenAPI 3.1 specification for the Google Slides Hybrid MCP REST API.
 *
 * Exports a `generateOpenApiSpec()` function that returns the full OpenAPI JSON
 * object covering all 17 REST endpoints plus the spec endpoint itself.
 */

/**
 * Generate the complete OpenAPI 3.1 JSON specification for the REST API.
 *
 * @returns A plain object conforming to the OpenAPI 3.1 schema.
 */
export function generateOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Google Slides Hybrid MCP REST API',
      version: '1.0.0',
      description:
        'RESTful API for presentation management, template operations, vision/analysis, and markdown conversion. All routes are mounted under `/api/v1/`.',
      license: {
        name: 'MIT',
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'REST API v1 base path',
      },
    ],
    security: [
      { ApiKeyAuth: [] },
      { BearerAuth: [] },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key passed via the X-API-Key header.',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token passed via the Authorization header.',
        },
      },
      schemas: {
        // ── Standard Envelope ────────────────────────────────────────────
        ApiEnvelope: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {},
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
              },
              required: ['code', 'message'],
            },
            meta: {
              type: 'object',
              additionalProperties: true,
            },
          },
          required: ['success'],
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
              },
              required: ['code', 'message'],
            },
          },
          required: ['success', 'error'],
        },

        // ── Presentation ────────────────────────────────────────────────
        PresentationResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            title: { type: 'string' },
            slideCount: { type: 'integer' },
            slides: {
              type: 'array',
              items: { $ref: '#/components/schemas/SlideContent' },
            },
            pageWidth: { type: 'number' },
            pageHeight: { type: 'number' },
            url: { type: 'string', format: 'uri' },
          },
        },
        SlideContent: {
          type: 'object',
          properties: {
            slideId: { type: 'string' },
            slideIndex: { type: 'integer' },
            title: { type: 'string' },
            elements: {
              type: 'array',
              items: { $ref: '#/components/schemas/SlideElement' },
            },
            notes: { type: 'string' },
            layoutId: { type: 'string' },
          },
        },
        SlideElement: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            position: { $ref: '#/components/schemas/ElementPosition' },
            text: { type: 'string' },
            imageUrl: { type: 'string', format: 'uri' },
            shapeType: { type: 'string' },
            styles: { $ref: '#/components/schemas/ElementStyles' },
          },
          required: ['id', 'type', 'position'],
        },
        ElementPosition: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        ElementStyles: {
          type: 'object',
          properties: {
            fontFamily: { type: 'string' },
            fontSize: { type: 'number' },
            bold: { type: 'boolean' },
            italic: { type: 'boolean' },
            underline: { type: 'boolean' },
            foregroundColor: { type: 'string' },
            backgroundColor: { type: 'string' },
            alignment: { type: 'string', enum: ['START', 'CENTER', 'END', 'JUSTIFIED'] },
            lineSpacing: { type: 'number' },
            spaceAbove: { type: 'number' },
            spaceBelow: { type: 'number' },
            borderColor: { type: 'string' },
            borderWeight: { type: 'number' },
            opacity: { type: 'number' },
          },
        },

        // ── Slide ──────────────────────────────────────────────────────
        SlideResponse: {
          type: 'object',
          properties: {
            slideId: { type: 'string' },
            slideIndex: { type: 'integer' },
            title: { type: 'string' },
            elements: {
              type: 'array',
              items: { $ref: '#/components/schemas/SlideElement' },
            },
            notes: { type: 'string' },
            layoutId: { type: 'string' },
          },
        },

        // ── Share ──────────────────────────────────────────────────────
        ShareResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            role: { type: 'string' },
            shareUrl: { type: 'string', format: 'uri' },
          },
        },

        // ── Template ──────────────────────────────────────────────────
        TemplateResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            colors: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        TemplateListResponse: {
          type: 'object',
          properties: {
            templates: {
              type: 'array',
              items: { $ref: '#/components/schemas/TemplateResponse' },
            },
            count: { type: 'integer' },
          },
        },

        // ── Analysis ──────────────────────────────────────────────────
        DesignIssue: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            element: { type: 'string' },
            description: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['type', 'severity', 'description'],
        },
        AnalysisResponse: {
          type: 'object',
          properties: {
            issues: {
              type: 'array',
              items: { $ref: '#/components/schemas/DesignIssue' },
            },
            score: { type: 'number' },
            suggestions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },

        // ── Polish ────────────────────────────────────────────────────
        PolishSlideResult: {
          type: 'object',
          properties: {
            slideIndex: { type: 'integer' },
            beforeScore: { type: 'number' },
            afterScore: { type: 'number' },
            fixes: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PolishResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            slidesPolished: { type: 'integer' },
            results: {
              type: 'array',
              items: { $ref: '#/components/schemas/PolishSlideResult' },
            },
            overallScoreBefore: { type: 'number' },
            overallScoreAfter: { type: 'number' },
          },
        },

        // ── Markdown Preview ──────────────────────────────────────────
        MarkdownSlidePreview: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            title: { type: 'string' },
            bodyLines: { type: 'integer' },
            hasNotes: { type: 'boolean' },
            layout: { type: 'string' },
          },
        },
        PreviewResponse: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            slideCount: { type: 'integer' },
            slides: {
              type: 'array',
              items: { $ref: '#/components/schemas/MarkdownSlidePreview' },
            },
          },
        },

        // ── Export ────────────────────────────────────────────────────
        ExportPdfResponse: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
          },
        },

        // ── Delete ────────────────────────────────────────────────────
        DeleteResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            status: { type: 'string', enum: ['deleted'] },
          },
        },

        // ── Theme Applied ────────────────────────────────────────────
        ThemeAppliedResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            theme: { type: 'string' },
            status: { type: 'string', enum: ['applied'] },
          },
        },

        // ── Template Applied ─────────────────────────────────────────
        TemplateAppliedResponse: {
          type: 'object',
          properties: {
            presentationId: { type: 'string' },
            templateId: { type: 'string' },
            status: { type: 'string', enum: ['applied'] },
          },
        },

        // ── Request Bodies ───────────────────────────────────────────
        CreatePresentationBody: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 500 },
            markdown: { type: 'string' },
            theme: { type: 'string' },
            polish: { type: 'boolean' },
          },
        },
        UpdatePresentationBody: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 500 },
            markdown: { type: 'string' },
          },
        },
        AddSlideBody: {
          type: 'object',
          properties: {
            layoutId: { type: 'string' },
            insertionIndex: { type: 'integer', minimum: 0 },
            content: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        },
        DuplicateSlideBody: {
          type: 'object',
          properties: {
            insertionIndex: { type: 'integer', minimum: 0 },
          },
        },
        ShareBody: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['reader', 'writer', 'commenter'] },
          },
        },
        ApplyTemplateBody: {
          type: 'object',
          required: ['presentationId'],
          properties: {
            presentationId: { type: 'string' },
            variables: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        AnalyzeBody: {
          type: 'object',
          properties: {
            slideIndex: { type: 'integer', minimum: 0 },
            checks: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        PolishBody: {
          type: 'object',
          properties: {
            maxIterations: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
        ThemeBody: {
          type: 'object',
          required: ['theme'],
          properties: {
            theme: { type: 'string', minLength: 1 },
          },
        },
        MarkdownPreviewBody: {
          type: 'object',
          required: ['markdown'],
          properties: {
            markdown: { type: 'string', minLength: 1, maxLength: 100000 },
            title: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        MarkdownCreateBody: {
          type: 'object',
          required: ['title', 'markdown'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 500 },
            markdown: { type: 'string', minLength: 1, maxLength: 100000 },
            theme: { type: 'string' },
            polish: { type: 'boolean' },
          },
        },
      },

      // ── Reusable Response Objects ──────────────────────────────────────
      responses: {
        BadRequest: {
          description: 'Validation or client error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        Unauthorized: {
          description: 'Authentication required or invalid credentials',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        NotFound: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        InternalError: {
          description: 'Internal server error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },

      // ── Reusable Parameters ────────────────────────────────────────────
      parameters: {
        PresentationId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Google Slides presentation ID',
          schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
        },
        SlideId: {
          name: 'slideId',
          in: 'path',
          required: true,
          description: 'Slide page object ID',
          schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
        },
        TemplateId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Template / theme ID',
          schema: { type: 'string' },
        },
      },
    },

    // =====================================================================
    // PATHS
    // =====================================================================
    paths: {
      // ── Presentations ─────────────────────────────────────────────────

      '/presentations': {
        post: {
          summary: 'Create a new presentation',
          operationId: 'createPresentation',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreatePresentationBody' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Presentation created successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PresentationResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/presentations/{id}': {
        get: {
          summary: 'Get presentation details',
          operationId: 'getPresentation',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          responses: {
            '200': {
              description: 'Presentation details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PresentationResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
        put: {
          summary: 'Update a presentation',
          operationId: 'updatePresentation',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdatePresentationBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Presentation updated successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PresentationResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
        delete: {
          summary: 'Delete a presentation',
          operationId: 'deletePresentation',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          responses: {
            '200': {
              description: 'Presentation deleted',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/DeleteResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Slides ────────────────────────────────────────────────────────

      '/presentations/{id}/slides': {
        post: {
          summary: 'Add a new slide to a presentation',
          operationId: 'addSlide',
          tags: ['Slides'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AddSlideBody' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Slide created successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/SlideResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/presentations/{id}/slides/{slideId}': {
        get: {
          summary: 'Get a specific slide from a presentation',
          operationId: 'getSlide',
          tags: ['Slides'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PresentationId' },
            { $ref: '#/components/parameters/SlideId' },
          ],
          responses: {
            '200': {
              description: 'Slide details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/SlideResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
        delete: {
          summary: 'Delete a slide from a presentation',
          operationId: 'deleteSlide',
          tags: ['Slides'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PresentationId' },
            { $ref: '#/components/parameters/SlideId' },
          ],
          responses: {
            '200': {
              description: 'Slide deleted',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/SlideResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/presentations/{id}/slides/{slideId}/duplicate': {
        post: {
          summary: 'Duplicate a slide within a presentation',
          operationId: 'duplicateSlide',
          tags: ['Slides'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/PresentationId' },
            { $ref: '#/components/parameters/SlideId' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DuplicateSlideBody' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Slide duplicated successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/SlideResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Export ─────────────────────────────────────────────────────────

      '/presentations/{id}/export/pdf': {
        get: {
          summary: 'Export a presentation to PDF',
          operationId: 'exportPdf',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          responses: {
            '200': {
              description: 'PDF export details including download URL',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/ExportPdfResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Share ──────────────────────────────────────────────────────────

      '/presentations/{id}/share': {
        post: {
          summary: 'Share a presentation',
          operationId: 'sharePresentation',
          tags: ['Presentations'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ShareBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Presentation shared successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/ShareResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Templates ─────────────────────────────────────────────────────

      '/templates': {
        get: {
          summary: 'List available templates and themes',
          operationId: 'listTemplates',
          tags: ['Templates'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            {
              name: 'category',
              in: 'query',
              required: false,
              description: 'Filter templates by category',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'List of templates',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/TemplateListResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/templates/{id}/apply': {
        post: {
          summary: 'Apply a template/theme to a presentation',
          operationId: 'applyTemplate',
          tags: ['Templates'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/TemplateId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApplyTemplateBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Template applied successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/TemplateAppliedResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Vision / Analysis ─────────────────────────────────────────────

      '/presentations/{id}/analyze': {
        post: {
          summary: 'Analyze design quality of a presentation',
          operationId: 'analyzePresentation',
          tags: ['Vision'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AnalyzeBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Analysis results',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/AnalysisResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/presentations/{id}/polish': {
        post: {
          summary: 'Auto-polish a presentation to improve design quality',
          operationId: 'polishPresentation',
          tags: ['Vision'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PolishBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Polish results with before/after scores',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PolishResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/presentations/{id}/theme': {
        post: {
          summary: 'Apply a visual theme to a presentation',
          operationId: 'applyTheme',
          tags: ['Vision'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/PresentationId' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ThemeBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Theme applied successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/ThemeAppliedResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── Markdown ──────────────────────────────────────────────────────

      '/markdown/preview': {
        post: {
          summary: 'Preview markdown structure without creating a presentation',
          operationId: 'previewMarkdown',
          tags: ['Markdown'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MarkdownPreviewBody' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Parsed slide structure preview',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PreviewResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      '/markdown/create': {
        post: {
          summary: 'Create a new presentation from markdown content',
          operationId: 'createFromMarkdown',
          tags: ['Markdown'],
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MarkdownCreateBody' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Presentation created from markdown',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ApiEnvelope' },
                      {
                        type: 'object',
                        properties: {
                          data: { $ref: '#/components/schemas/PresentationResponse' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '500': { $ref: '#/components/responses/InternalError' },
          },
        },
      },

      // ── OpenAPI Spec ──────────────────────────────────────────────────

      '/openapi.json': {
        get: {
          summary: 'Get the OpenAPI specification',
          operationId: 'getOpenApiSpec',
          tags: ['Meta'],
          security: [],
          responses: {
            '200': {
              description: 'OpenAPI 3.1 JSON specification',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    description: 'OpenAPI 3.1 specification document',
                  },
                },
              },
            },
          },
        },
      },
    },

    tags: [
      { name: 'Presentations', description: 'Create, read, update, and delete presentations' },
      { name: 'Slides', description: 'Manage individual slides within a presentation' },
      { name: 'Templates', description: 'List and apply templates/themes' },
      { name: 'Vision', description: 'Design analysis, polishing, and theme application' },
      { name: 'Markdown', description: 'Preview and create presentations from markdown' },
      { name: 'Meta', description: 'API metadata and specification' },
    ],
  };
}
