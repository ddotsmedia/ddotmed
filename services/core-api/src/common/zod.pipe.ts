import {
  ArgumentMetadata,
  BadRequestException,
  Body,
  PipeTransform,
  Query,
} from '@nestjs/common';
import type { ZodSchema } from 'zod';

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    return result.data;
  }
}

export const ZodBody = (schema: ZodSchema) => Body(new ZodValidationPipe(schema));
export const ZodQuery = (schema: ZodSchema) => Query(new ZodValidationPipe(schema));
