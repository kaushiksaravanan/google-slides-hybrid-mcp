/**
 * @module shared/schema-converter
 * @description Converts Zod schemas to JSON Schema representations suitable
 * for MCP tool definitions.
 *
 * This is a lightweight converter that handles the most common Zod types
 * used across all tool layers (API, Browser, Vision). For full Zod → JSON
 * Schema conversion, consider using `zod-to-json-schema`.
 */

import { z } from 'zod';

/**
 * Convert a Zod schema to a JSON Schema representation suitable
 * for MCP tool definitions.
 *
 * Handles: ZodObject, ZodString, ZodNumber, ZodBoolean, ZodArray,
 * ZodEnum, ZodOptional, ZodDefault, ZodNullable, ZodUnion,
 * ZodEffects (.refine() — unwrap to inner schema), ZodLiteral, ZodRecord.
 *
 * @param schema - The Zod schema to convert.
 * @returns A JSON Schema object.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Handle ZodOptional — unwrap and recurse
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }

  // Handle ZodDefault — unwrap to the inner schema
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema._def.innerType as z.ZodTypeAny);
  }

  // Handle ZodNullable — unwrap to the inner schema
  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap());
    return { ...inner, nullable: true };
  }

  // Handle ZodEffects (.refine(), .transform(), etc.) — unwrap to inner schema
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(schema._def.schema as z.ZodTypeAny);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  // Handle ZodString
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    if (schema.description) result['description'] = schema.description;
    return result;
  }

  // Handle ZodNumber
  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    if (schema.description) result['description'] = schema.description;
    return result;
  }

  // Handle ZodBoolean
  if (schema instanceof z.ZodBoolean) {
    const result: Record<string, unknown> = { type: 'boolean' };
    if (schema.description) result['description'] = schema.description;
    return result;
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodToJsonSchema(schema.element),
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: schema.options,
      ...(schema.description ? { description: schema.description } : {}),
    };
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value;
    const result: Record<string, unknown> = {
      type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
      const: value,
    };
    if (schema.description) result['description'] = schema.description;
    return result;
  }

  // Handle ZodUnion
  if (schema instanceof z.ZodUnion) {
    const options = (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options;
    return {
      oneOf: options.map((opt: z.ZodTypeAny) => zodToJsonSchema(opt)),
    };
  }

  // Handle ZodRecord
  if (schema instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: true };
  }

  // Fallback
  return { type: 'object' };
}
