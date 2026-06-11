import { Injectable } from '@nestjs/common';
import { ExtractionResponseSchema } from './schemas/response.schema';

@Injectable()
export class DocumentService {
  // AI extraction logic will be implemented here
  async extract(_file: Express.Multer.File): Promise<ExtractionResponseSchema> {
    return {
      document_type: 'receipt',
      confidence: 0,
      fields: {},
      validation_errors: ['Not implemented yet'],
    };
  }
}
