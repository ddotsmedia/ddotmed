import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { JwtAuthGuard, RolesGuard } from './auth/guards';
import { AuditLogInterceptor, TenantInterceptor } from './common/interceptors';
import { AuditService } from './audit/audit.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 32 * 1024 * 1024 }),
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'wss:', 'https:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(compress, { global: true });
  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? undefined });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 second',
    // Auth endpoints get a far tighter budget than general PHI reads.
    keyGenerator: (req) => `${req.ip}:${req.url.startsWith('/api/auth') ? 'auth' : 'general'}`,
    allowList: (req) => req.url === '/health',
  });

  // Explicit origin allow-list — never reflect the request origin.
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Tenant'],
    maxAge: 86400,
  });

  app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] });
  app.enableVersioning();

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const reflector = app.get(Reflector);
  app.useGlobalGuards(app.get(JwtAuthGuard), new RolesGuard(reflector));
  app.useGlobalInterceptors(
    new TenantInterceptor(),
    new AuditLogInterceptor(reflector, app.get(AuditService)),
  );

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('MediCore HMS Core API')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`core-api listening on :${port}`);
}

void bootstrap();
