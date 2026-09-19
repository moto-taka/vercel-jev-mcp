import { z } from 'zod';

// Gateway's native evaluation primitives. No added none option or score threshold.
export const jsonInput = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const id = z.string().min(1).max(128).refine(
  (s) => !['__proto__', 'constructor', 'prototype'].includes(s),
  'Reserved identifier',
);
const choiceCriteria = z.record(id, jsonInput.nullable()).refine(
  (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 255,
  'Choice requires 1..255 options',
);
const scoreCriteria = z.array(jsonInput.nullable()).min(2).max(10);
const booleanCriteria = z.object({ true: jsonInput.nullable().optional(), false: jsonInput.nullable().optional() }).strict();
export const choiceQuestion = z.object({
  type: z.literal('choice'), instructions: jsonInput, criteria: choiceCriteria,
}).strict();
export const scoreQuestion = z.object({
  type: z.literal('score'), instructions: jsonInput, criteria: scoreCriteria,
}).strict();
export const booleanQuestion = z.object({
  type: z.literal('boolean'), instructions: jsonInput, criteria: booleanCriteria.optional(),
}).strict();
export const question = z.discriminatedUnion('type', [choiceQuestion, scoreQuestion, booleanQuestion]);
export const askSchema = z.object({
  state: jsonInput,
  questions: z.record(id, question).refine(
    (v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 64,
    'Provide 1..64 questions',
  ),
}).strict();
export const classifySchema = choiceQuestion.omit({ type: true }).extend({ state: jsonInput }).strict();
export const scoreSchema = scoreQuestion.omit({ type: true }).extend({ state: jsonInput }).strict();
export const checkSchema = booleanQuestion.omit({ type: true }).extend({ state: jsonInput }).strict();
export type AskInput = z.infer<typeof askSchema>;
