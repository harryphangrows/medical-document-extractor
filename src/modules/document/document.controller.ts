import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiConsumes,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { DocumentService } from './document.service';
import {
  ExtractionResponseSchema,
  FieldValueSchema,
} from './schemas/response.schema';

@ApiTags('Document Extraction')
@ApiExtraModels(FieldValueSchema, ExtractionResponseSchema)
@Controller('api/v1')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('extract')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Extract structured data from a medical document',
    description:
      'Upload a PDF or image (JPEG, PNG, WEBP) of a medical document. ' +
      'Returns structured JSON with extracted fields and confidence scores.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Medical document file (PDF, JPEG, PNG, WEBP) — max 10 MB',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Document extracted successfully',
    type: ExtractionResponseSchema,
  })
  @ApiResponse({ status: 400, description: 'Invalid file type or missing file' })
  async extract(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ExtractionResponseSchema> {
    return this.documentService.extract(file);
  }
}
