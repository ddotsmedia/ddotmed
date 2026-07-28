import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { NotesService } from './notes.module';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const NOTE_ID = '0193c3f0-0000-7000-8000-0000000000a1';

const ctx = (permissions: string[]): RequestContext => ({
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions,
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
});

const run = <T>(permissions: string[], fn: () => Promise<T>): Promise<T> =>
  requestContext.run(ctx(permissions), fn);

const draft = (over: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  tenant_id: 't1',
  patient_id: 'p1',
  encounter_id: 'e1',
  author_id: 'u1',
  type: 'soap',
  status: 'pending_approval',
  subjective: 'Cough for three days.',
  objective: 'Chest clear.',
  assessment: 'Viral URTI.',
  plan: 'Supportive care.',
  body: null,
  linked_evidence: [],
  approved_by: null,
  approved_at: null,
  version: 1,
  supersedes_id: null,
  fhir_id: null,
  ...over,
});

describe('NotesService', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let service: NotesService;

  beforeEach(() => {
    prisma = {
      clinicalNote: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...draft(), ...args.data, id: 'new-note' }),
        ),
        findFirst: jest.fn().mockResolvedValue(draft()),
        update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) =>
          Promise.resolve({ ...draft(), ...args.data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    } as unknown as PrismaService;
    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    service = new NotesService(prisma, kafka);
  });

  describe('write', () => {
    it('lands an AI draft as pending approval, never as a plain draft', async () => {
      await run(['note:write'], () =>
        service.write({
          patient_id: 'p1',
          encounter_id: 'e1',
          type: 'soap',
          ai_drafted: true,
          linked_evidence: [],
        }),
      );
      const data = (prisma.clinicalNote.create as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('pending_approval');
      expect(data.ai_drafted).toBe(true);
    });

    it('lands a clinician-typed note as a draft', async () => {
      await run(['note:write'], () =>
        service.write({
          patient_id: 'p1',
          encounter_id: 'e1',
          type: 'progress',
          ai_drafted: false,
          linked_evidence: [],
        }),
      );
      expect((prisma.clinicalNote.create as jest.Mock).mock.calls[0][0].data.status).toBe('draft');
    });
  });

  describe('approve', () => {
    it('stamps approved_at and the approving clinician', async () => {
      const approved = await run(['note:sign'], () => service.approve(NOTE_ID));
      const data = (prisma.clinicalNote.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('signed');
      expect(data.approved_by).toBe('u1');
      expect(data.approved_at).toBeInstanceOf(Date);
      expect(approved.status).toBe('signed');
    });

    it('publishes the note to the FHIR sync topic', async () => {
      await run(['note:sign'], () => service.approve(NOTE_ID));
      expect(kafka.emit).toHaveBeenCalledWith(
        'medicore.fhir.sync',
        't1',
        expect.objectContaining({ resource_type: 'Composition' }),
      );
    });

    it('refuses a role that may not sign', async () => {
      await expect(run(['note:write'], () => service.approve(NOTE_ID))).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.clinicalNote.update).not.toHaveBeenCalled();
    });

    it('accepts an AI approver permission as well as a signing one', async () => {
      await expect(run(['ai:approve'], () => service.approve(NOTE_ID))).resolves.toBeDefined();
    });

    it('refuses to approve the same note twice', async () => {
      (prisma.clinicalNote.findFirst as jest.Mock).mockResolvedValue(
        draft({ status: 'signed', approved_at: new Date() }),
      );
      await expect(run(['note:sign'], () => service.approve(NOTE_ID))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses to approve a discarded note', async () => {
      (prisma.clinicalNote.findFirst as jest.Mock).mockResolvedValue(
        draft({ status: 'entered_in_error' }),
      );
      await expect(run(['note:sign'], () => service.approve(NOTE_ID))).rejects.toThrow(
        /discarded note/,
      );
    });

    it('sign is the same act, so the legacy route behaves identically', async () => {
      await run(['note:sign'], () => service.sign(NOTE_ID));
      expect((prisma.clinicalNote.update as jest.Mock).mock.calls[0][0].data.status).toBe('signed');
    });
  });

  describe('approval locks the content', () => {
    it('edits an unapproved draft in place', async () => {
      await run(['note:write'], () => service.amend(NOTE_ID, { plan: 'Add azithromycin.' }));
      expect(prisma.clinicalNote.update).toHaveBeenCalledWith({
        where: { id: NOTE_ID },
        data: expect.objectContaining({ plan: 'Add azithromycin.' }),
      });
      expect(prisma.clinicalNote.create).not.toHaveBeenCalled();
    });

    it('never rewrites approved content — it supersedes it with a new version', async () => {
      (prisma.clinicalNote.findFirst as jest.Mock).mockResolvedValue(
        draft({ status: 'signed', approved_at: new Date('2026-07-28T09:00:00Z'), approved_by: 'u1' }),
      );

      await run(['note:write'], () => service.amend(NOTE_ID, { plan: 'Add azithromycin.' }));

      // The original row only ever changes status; its clinical text is untouched.
      expect(prisma.clinicalNote.update).toHaveBeenCalledWith({
        where: { id: NOTE_ID },
        data: { status: 'amended' },
      });
      const created = (prisma.clinicalNote.create as jest.Mock).mock.calls[0][0].data;
      expect(created.plan).toBe('Add azithromycin.');
      expect(created.subjective).toBe('Cough for three days.');
      expect(created.version).toBe(2);
      expect(created.supersedes_id).toBe(NOTE_ID);
      expect(created.status).toBe('draft');
      expect(created.ai_drafted).toBe(false);
    });

    it('locks on approved_at even if the status was moved on afterwards', async () => {
      (prisma.clinicalNote.findFirst as jest.Mock).mockResolvedValue(
        draft({ status: 'amended', approved_at: new Date('2026-07-28T09:00:00Z') }),
      );
      await run(['note:write'], () => service.amend(NOTE_ID, { plan: 'Something else.' }));
      expect(prisma.clinicalNote.create).toHaveBeenCalled();
    });

    it('rejects an amendment to a note that does not exist', async () => {
      (prisma.clinicalNote.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(run(['note:write'], () => service.amend(NOTE_ID, { plan: 'x' }))).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
