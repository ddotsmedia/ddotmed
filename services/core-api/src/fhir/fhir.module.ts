import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, Ctx, Public, RequirePermissions } from '../common/decorators';
import type { RequestContext } from '../common/tenant-context';
import { AllergiesModule } from '../allergies/allergies.module';
import { MedicationsModule } from '../medications/medications.module';
import { FhirSyncService } from './fhir-sync.service';
import { Hl7Service } from './hl7.service';
import { SmartService } from './smart.service';
import { CdsHooksService } from './cds-hooks.service';
import { AbdmAdapter, HieRegistry, MalaffiAdapter, NphiesAdapter } from './hie-adapters';

@ApiTags('fhir')
@Controller('fhir')
export class FhirController {
  constructor(
    private readonly sync: FhirSyncService,
    private readonly hl7: Hl7Service,
    private readonly smart: SmartService,
    private readonly hie: HieRegistry,
  ) {}

  @Public()
  @Get('.well-known/smart-configuration')
  smartConfiguration() {
    return this.smart.wellKnownConfiguration();
  }

  @Post('smart/launch')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Mint an EHR launch token carrying patient/encounter context' })
  launch(
    @Body() body: { patient_id?: string; encounter_id?: string },
    @Ctx() ctx: RequestContext,
  ) {
    return {
      launch: this.smart.createLaunchContext(ctx.tenantId, body.patient_id, body.encounter_id),
    };
  }

  @Post('smart/authorize')
  @RequirePermissions('patient:read')
  authorize(@Body() body: Record<string, string>, @Ctx() ctx: RequestContext) {
    return this.smart.authorize({
      response_type: body.response_type!,
      client_id: body.client_id!,
      redirect_uri: body.redirect_uri!,
      scope: body.scope ?? '',
      state: body.state ?? '',
      aud: body.aud ?? '',
      code_challenge: body.code_challenge,
      code_challenge_method: body.code_challenge_method,
      launch: body.launch,
      userId: ctx.userId!,
      tenantId: ctx.tenantId,
    });
  }

  @Public()
  @Post('smart/token')
  token(@Body() body: Record<string, string>) {
    return this.smart.token({
      grant_type: body.grant_type!,
      code: body.code!,
      redirect_uri: body.redirect_uri!,
      client_id: body.client_id!,
      code_verifier: body.code_verifier!,
    });
  }

  @Get(':resourceType/:id')
  @RequirePermissions('patient:read')
  @Audit({ action: 'fhir.read', resourceType: 'FhirResource', isPhi: true })
  read(@Param('resourceType') resourceType: string, @Param('id') id: string) {
    return this.sync.read(resourceType, id);
  }

  @Get(':resourceType')
  @RequirePermissions('patient:read')
  @Audit({ action: 'fhir.search', resourceType: 'FhirResource', isPhi: true })
  search(@Param('resourceType') resourceType: string, @Query() query: Record<string, string>) {
    return this.sync.search(resourceType, query);
  }

  @Post('hl7')
  @RequirePermissions('encounter:write')
  @Audit({ action: 'hl7.receive', resourceType: 'Hl7Message', isPhi: true })
  @ApiOperation({ summary: 'Receive an HL7 v2 ADT/ORM/ORU/RDS message and return an ACK' })
  receiveHl7(@Body('message') message: string) {
    return this.hl7.receive(message);
  }

  @Get('hie/status')
  @RequirePermissions('config:manage')
  hieStatus() {
    return this.hie.status();
  }

  @Post('hie/:countryPack/submit')
  @RequirePermissions('patient:write')
  @Audit({ action: 'hie.submit', resourceType: 'Bundle', isPhi: true })
  hieSubmit(
    @Param('countryPack') countryPack: string,
    @Body() body: { patient_identifier: string; bundle: Record<string, unknown> },
  ) {
    const adapter = this.hie.forCountryPack(countryPack);
    if (!adapter) return { accepted: false, message: `No HIE adapter for ${countryPack}` };
    return adapter.submitDocument(body.patient_identifier, body.bundle);
  }
}

@ApiTags('cds-hooks')
@Controller('cds-services')
export class CdsHooksController {
  constructor(private readonly cds: CdsHooksService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'CDS Hooks service discovery' })
  discovery() {
    return this.cds.discovery();
  }

  @Post(':serviceId')
  @RequirePermissions('patient:read')
  @Audit({ action: 'cds.invoke', resourceType: 'CdsHook', isPhi: true })
  invoke(
    @Param('serviceId') serviceId: string,
    @Body() body: { context: Record<string, unknown>; prefetch?: Record<string, unknown> },
  ) {
    return this.cds.invoke(serviceId, body);
  }
}

@Module({
  imports: [AllergiesModule, MedicationsModule],
  controllers: [FhirController, CdsHooksController],
  providers: [
    FhirSyncService,
    Hl7Service,
    SmartService,
    CdsHooksService,
    MalaffiAdapter,
    AbdmAdapter,
    NphiesAdapter,
    HieRegistry,
  ],
  exports: [FhirSyncService, Hl7Service],
})
export class FhirModule {}
