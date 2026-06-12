import { ApiProperty } from '@nestjs/swagger';

export class FieldValueSchema {
  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'array', items: {} },
      { type: 'object' },
    ],
    nullable: true,
    example: 'Bangkok Hospital',
  })
  value: string | number | Record<string, unknown> | unknown[] | null;

  @ApiProperty({ example: 0.95, minimum: 0, maximum: 1 })
  confidence: number;
}

export class ValidationErrorSchema {
  @ApiProperty({ example: 'grand_total' })
  field: string;

  @ApiProperty({
    example: 'MATHEMATICAL_MISMATCH',
    enum: [
      'INVALID_DATE',
      'AMBIGUOUS_DATE',
      'NEGATIVE_AMOUNT',
      'MATHEMATICAL_MISMATCH',
      'SUSPICIOUS_VALUE',
      'UNIFORM_CONFIDENCE',
    ],
  })
  error_type:
    | 'INVALID_DATE'
    | 'AMBIGUOUS_DATE'
    | 'NEGATIVE_AMOUNT'
    | 'MATHEMATICAL_MISMATCH'
    | 'SUSPICIOUS_VALUE'
    | 'UNIFORM_CONFIDENCE';

  @ApiProperty({
    example: "Item totals sum (150.00) differs from grand_total (200.00) by 50.00 (25.0%)",
  })
  message: string;

  @ApiProperty({ example: 'WARNING', enum: ['WARNING', 'ERROR'] })
  severity: 'WARNING' | 'ERROR';
}

export class ExtractionResponseSchema {
  @ApiProperty({
    example: 'receipt',
    enum: ['receipt', 'discharge_summary', 'lab_report', 'prescription'],
  })
  document_type: string;

  @ApiProperty({ example: 0.95, minimum: 0, maximum: 1 })
  confidence: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/FieldValueSchema' },
    example: {
      hospital_name: { value: 'Bangkok Hospital', confidence: 0.98 },
      patient_name: { value: 'John Doe', confidence: 0.92 },
      grand_total: { value: 15750.0, confidence: 0.97 },
    },
  })
  fields: Record<string, FieldValueSchema>;

  @ApiProperty({ type: [ValidationErrorSchema], example: [] })
  validation_errors: ValidationErrorSchema[];
}
