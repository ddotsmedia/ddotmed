import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { RequirePermissions } from '../common/decorators';
import { AiClient, AiModule } from '../ai/ai.module';
import {
  actionFor,
  fallbackExplanation,
  findCatalogueInteraction,
  type InteractionAction,
  type InteractionSeverity,
} from './interaction-catalogue';

export interface InteractionLookup {
  found: boolean;
  drug_a: string;
  drug_b: string;
  severity: InteractionSeverity | null;
  action: InteractionAction | null;
  mechanism: string | null;
  clinical_effect: string | null;
  management: string | null;
  /** Plain-English wording; model-written on first lookup, then read from the cache. */
  explanation: string | null;
  explanation_model: string | null;
  source: 'tenant' | 'bundled' | null;
}

/**
 * Pair lookup for the prescribing screen.
 *
 * The severity and the clinical facts are never model-generated — they come from
 * a tenant's own register or from the bundled catalogue. Only the wording is
 * written by the model, once per pair, and then it lives in the database: a
 * clinician reading the same warning twice must read the same words twice.
 */
@Injectable()
export class DrugInteractionsService {
  private readonly log = new Logger(DrugInteractionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
  ) {}

  async lookup(drugA: string, drugB: string, name?: { a?: string; b?: string }): Promise<InteractionLookup> {
    const displayA = name?.a?.trim() || drugA;
    const displayB = name?.b?.trim() || drugB;

    const row = await this.prisma.drugInteraction.findFirst({
      where: {
        deleted_at: null,
        OR: [
          { rxnorm_a: drugA, rxnorm_b: drugB },
          { rxnorm_a: drugB, rxnorm_b: drugA },
        ],
      },
    });

    if (row) {
      const severity = row.severity as InteractionSeverity;
      const explanation =
        row.plain_explanation ??
        (await this.writeExplanation(row.id, {
          drug_a: displayA,
          drug_b: displayB,
          severity,
          clinical_effect: row.clinical_effect,
          mechanism: row.mechanism,
          management: row.management,
        }));

      return {
        found: true,
        drug_a: displayA,
        drug_b: displayB,
        severity,
        action: actionFor(severity),
        mechanism: row.mechanism,
        clinical_effect: row.clinical_effect,
        management: row.management,
        explanation,
        explanation_model: row.explanation_model ?? this.ai.model,
        source: 'tenant',
      };
    }

    const entry = findCatalogueInteraction(
      { rxnorm: drugA, name: displayA },
      { rxnorm: drugB, name: displayB },
    );
    if (!entry) {
      return {
        found: false,
        drug_a: displayA,
        drug_b: displayB,
        severity: null,
        action: null,
        mechanism: null,
        clinical_effect: null,
        management: null,
        explanation: null,
        explanation_model: null,
        source: null,
      };
    }

    // First lookup of a bundled pair persists it, so the wording is written once
    // and every later lookup — by anyone, on any replica — reads the same row.
    const created = await this.prisma.drugInteraction.upsert({
      where: { rxnorm_a_rxnorm_b: { rxnorm_a: entry.rxnorm_a, rxnorm_b: entry.rxnorm_b } },
      create: {
        rxnorm_a: entry.rxnorm_a,
        rxnorm_b: entry.rxnorm_b,
        severity: entry.severity,
        mechanism: entry.mechanism,
        clinical_effect: entry.clinical_effect,
        management: entry.management,
        source: 'bundled',
      },
      update: {},
    });

    const explanation =
      created.plain_explanation ??
      (await this.writeExplanation(created.id, {
        drug_a: displayA,
        drug_b: displayB,
        severity: entry.severity,
        clinical_effect: entry.clinical_effect,
        mechanism: entry.mechanism,
        management: entry.management,
      }));

    return {
      found: true,
      drug_a: displayA,
      drug_b: displayB,
      severity: entry.severity,
      action: actionFor(entry.severity),
      mechanism: entry.mechanism,
      clinical_effect: entry.clinical_effect,
      management: entry.management,
      explanation,
      explanation_model: created.explanation_model ?? this.ai.model,
      source: 'bundled',
    };
  }

  /**
   * Asks the model for the wording and caches it. A failure here degrades to the
   * deterministic sentence rather than showing the prescriber a blank warning —
   * losing the explanation must never mean losing the alert.
   */
  private async writeExplanation(
    id: string,
    facts: {
      drug_a: string;
      drug_b: string;
      severity: InteractionSeverity;
      clinical_effect: string;
      mechanism: string | null;
      management: string | null;
    },
  ): Promise<string> {
    const fallback = fallbackExplanation(facts);
    try {
      const raw = (await this.ai.post('/ai/interactions/explain', facts)) as {
        explanation?: string;
        model_version?: string;
      };
      const explanation = raw.explanation?.trim();
      if (!explanation) return fallback;

      await this.prisma.drugInteraction.update({
        where: { id },
        data: {
          plain_explanation: explanation,
          explanation_model: raw.model_version ?? this.ai.model,
          explanation_written_at: new Date(),
        },
      });
      return explanation;
    } catch (error) {
      this.log.warn(
        `Could not write an interaction explanation for ${facts.drug_a} + ${facts.drug_b}: ${(error as Error).message}`,
      );
      return fallback;
    }
  }
}

@ApiTags('drug-interactions')
@Controller('drug-interactions')
export class DrugInteractionsController {
  constructor(private readonly service: DrugInteractionsService) {}

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Look up one drug pair; explanation is model-written once, then cached' })
  lookup(
    @Query('drugA') drugA?: string,
    @Query('drugB') drugB?: string,
    @Query('nameA') nameA?: string,
    @Query('nameB') nameB?: string,
  ) {
    if (!drugA?.trim() || !drugB?.trim()) {
      throw new BadRequestException('drugA and drugB are both required');
    }
    return this.service.lookup(drugA.trim(), drugB.trim(), { a: nameA, b: nameB });
  }
}

@Module({
  imports: [AiModule],
  controllers: [DrugInteractionsController],
  providers: [DrugInteractionsService],
  exports: [DrugInteractionsService],
})
export class DrugInteractionsModule {}
