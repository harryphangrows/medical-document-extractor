import { ApiProperty } from '@nestjs/swagger';

export class FieldValueSchema {
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    nullable: true,
    example: 'Bangkok Hospital',
  })
  value: string | number | null;

  @ApiProperty({ example: 0.95, minimum: 0, maximum: 1 })
  confidence: number;
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

  @ApiProperty({ type: [String], example: [] })
  validation_errors: string[];
}
