import { BadRequestException, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { RequirePermissions } from '../common/decorators';
import {
  availableSlots,
  dayBounds,
  groupSlotsByPartOfDay,
  SLOT_HOLDING_STATUSES,
} from '../appointments/slot-availability';

@Injectable()
export class PractitionersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Directory for the booking flow, optionally narrowed to one specialty. */
  async list(specialty?: string) {
    const practitioners = await this.prisma.practitioner.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        is_active: true,
        ...(specialty ? { specialties: { has: specialty } } : {}),
      },
      select: {
        id: true,
        given_names: true,
        family_name: true,
        specialties: true,
        qualifications: true,
        gender: true,
        license_expires_at: true,
      },
      orderBy: { family_name: 'asc' },
    });

    // A practitioner whose licence has lapsed must not appear as bookable.
    const now = new Date();
    return practitioners.filter(
      (p) => p.license_expires_at === null || p.license_expires_at > now,
    );
  }

  /** Distinct specialties actually offered, for the first step of booking. */
  async specialties(): Promise<string[]> {
    const rows = await this.prisma.practitioner.findMany({
      where: { tenant_id: currentContext().tenantId, deleted_at: null, is_active: true },
      select: { specialties: true },
    });
    return [...new Set(rows.flatMap((r) => r.specialties))].sort();
  }

  /**
   * Bookable slots for one practitioner on one day.
   *
   * Slots and the appointments already claiming them are read together, then
   * filtered by the pure availability rules, so what the picker offers and what
   * the booking endpoint accepts cannot drift apart.
   */
  async slotsForDay(practitionerId: string, isoDay: string, minLeadMinutes = 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const tenantId = currentContext().tenantId;
    const { from, to } = dayBounds(isoDay);

    const [slots, claims] = await Promise.all([
      this.prisma.slot.findMany({
        where: {
          tenant_id: tenantId,
          deleted_at: null,
          start: { gte: from, lte: to },
          schedule: { deleted_at: null, is_active: true, practitioner_id: practitionerId },
        },
        select: {
          id: true,
          start: true,
          end: true,
          status: true,
          overbooked: true,
          schedule_id: true,
        },
        orderBy: { start: 'asc' },
      }),
      this.prisma.appointment.findMany({
        where: {
          tenant_id: tenantId,
          deleted_at: null,
          practitioner_id: practitionerId,
          start: { gte: from, lte: to },
          status: { in: [...SLOT_HOLDING_STATUSES] as never },
        },
        select: { slot_id: true, start: true, end: true, status: true },
      }),
    ]);

    const available = availableSlots(slots, claims, { minLeadMinutes });

    return {
      practitioner_id: practitionerId,
      date: isoDay,
      total_slots: slots.length,
      available_count: available.length,
      slots: available,
      groups: groupSlotsByPartOfDay(available),
    };
  }
}

@ApiTags('practitioners')
@Controller('practitioners')
export class PractitionersController {
  constructor(private readonly service: PractitionersService) {}

  @Get()
  @RequirePermissions('patient:read')
  list(@Query('specialty') specialty?: string) {
    return this.service.list(specialty);
  }

  @Get('specialties')
  @RequirePermissions('patient:read')
  specialties() {
    return this.service.specialties();
  }

  @Get(':id/slots')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Bookable slots for a practitioner on a given day' })
  slots(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('date') date: string,
    @Query('min_lead_minutes') minLead?: string,
  ) {
    return this.service.slotsForDay(id, date, minLead ? Number(minLead) : 0);
  }
}

@Module({
  controllers: [PractitionersController],
  providers: [PractitionersService],
  exports: [PractitionersService],
})
export class PractitionersModule {}
