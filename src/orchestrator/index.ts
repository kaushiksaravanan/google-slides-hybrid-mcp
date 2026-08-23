/**
 * @module orchestrator
 * @description Orchestrator layer barrel exports.
 *
 * Re-exports the HybridOrchestrator and WorkflowEngine for consumers:
 *
 * ```ts
 * import {
 *   HybridOrchestrator,
 *   WorkflowEngine,
 * } from '../orchestrator/index.js';
 * ```
 */

export {
  HybridOrchestrator,
  type LayerStatus,
  type CreateFromMarkdownOptions,
  type PolishResult,
  type PipelineResult,
} from './orchestrator.js';

export {
  WorkflowEngine,
  type WorkflowStatus,
  type ProgressCallback,
  type WorkflowProgress,
  type WorkflowResult,
  type BatchPolishResult,
  type SlideReviewResult,
} from './workflow.js';
