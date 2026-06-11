// Validation helpers — detailed logic will be added later
export const ALLOWED_DOCUMENT_TYPES = [
  'receipt',
  'discharge_summary',
  'lab_report',
  'prescription',
] as const;

export type DocumentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

export const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mimeType);
}

export function isAllowedExtension(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}
