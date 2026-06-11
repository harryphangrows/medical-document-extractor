import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Medical Extractor API')
    .setDescription(
      'AI-powered pipeline that extracts structured data from medical documents (receipts, discharge summaries, lab reports, prescriptions).',
    )
    .setVersion('1.0')
    .addTag('Document Extraction')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
  console.log(`Application running on: http://localhost:${process.env.PORT ?? 3000}`);
  console.log(`Swagger UI: http://localhost:${process.env.PORT ?? 3000}/api/docs`);
}
bootstrap();
