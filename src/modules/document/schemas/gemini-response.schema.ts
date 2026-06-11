import { Type } from '@google/genai';
import type { Schema } from '@google/genai';

// ─── Internal types ────────────────────────────────────────────────────────────

export interface AiFieldValue {
  value: string | number | Record<string, unknown> | unknown[] | null;
  confidence: number;
}

export interface AiExtractionResult {
  document_type: string;
  confidence: number;
  fields: Record<string, AiFieldValue>;
  validation_errors: string[];
}

// ─── Primitive field schema builders ──────────────────────────────────────────

export const stringField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

export const numberField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: { type: Type.NUMBER, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

export const arrayOfStringsField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING, nullable: true },
    },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

// ─── Composite field schemas ────────────────────────────────────────────────────

/** Receipt: items — list of line items */
export const itemsField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        properties: {
          description: { type: Type.STRING, nullable: true },
          quantity: { type: Type.NUMBER, nullable: true },
          unit_price: { type: Type.NUMBER, nullable: true },
          total: { type: Type.NUMBER, nullable: true },
        },
      },
    },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

/** Discharge Summary: diagnosis — primary + secondary */
export const diagnosisField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        primary: { type: Type.STRING, nullable: true },
        secondary: {
          type: Type.ARRAY,
          nullable: true,
          items: { type: Type.STRING },
        },
      },
    },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

/** Lab Report: tests — list of test results */
export const testsField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        properties: {
          test_name: { type: Type.STRING, nullable: true },
          result: { type: Type.STRING, nullable: true },
          unit: { type: Type.STRING, nullable: true },
          reference_range: { type: Type.STRING, nullable: true },
          flag: {
            type: Type.STRING,
            nullable: true,
            enum: ['normal', 'high', 'low'],
          },
        },
      },
    },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

/** Prescription: medications */
export const medicationsField = (): Schema => ({
  type: Type.OBJECT,
  nullable: true,
  properties: {
    value: {
      type: Type.ARRAY,
      nullable: true,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, nullable: true },
          dosage: { type: Type.STRING, nullable: true },
          frequency: { type: Type.STRING, nullable: true },
          duration: { type: Type.STRING, nullable: true },
          quantity: { type: Type.STRING, nullable: true },
        },
      },
    },
    confidence: { type: Type.NUMBER },
  },
  required: ['confidence'],
});

// ─── Master response schema (covers all 4 document types) ─────────────────────

export const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    document_type: {
      type: Type.STRING,
      enum: ['receipt', 'discharge_summary', 'lab_report', 'prescription'],
    },
    confidence: { type: Type.NUMBER },
    fields: {
      type: Type.OBJECT,
      properties: {
        // ── Shared ──────────────────────────────────────────────────────────
        patient_name: stringField(),
        date: stringField(),

        // ── Receipt + Discharge ──────────────────────────────────────────────
        hospital_name: stringField(),

        // ── Receipt only ─────────────────────────────────────────────────────
        items: itemsField(),
        grand_total: numberField(),
        payment_method: stringField(),

        // ── Discharge Summary only ────────────────────────────────────────────
        admission_date: stringField(),
        discharge_date: stringField(),
        diagnosis: diagnosisField(),
        procedures_performed: arrayOfStringsField(),
        attending_physician: stringField(),
        discharge_instructions: stringField(),

        // ── Lab Report only ───────────────────────────────────────────────────
        lab_name: stringField(),
        tests: testsField(),

        // ── Prescription only ─────────────────────────────────────────────────
        doctor_name: stringField(),
        medications: medicationsField(),
      },
    },
    validation_errors: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['document_type', 'confidence', 'fields', 'validation_errors'],
};
