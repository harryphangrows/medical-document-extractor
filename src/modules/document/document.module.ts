import { Module } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { DocumentValidationService } from './document-validation.service';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService, DocumentValidationService],
})
export class DocumentModule {}
