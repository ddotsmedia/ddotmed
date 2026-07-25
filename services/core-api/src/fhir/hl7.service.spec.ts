import { Hl7Service, parseHl7 } from './hl7.service';

const adt = [
  'MSH|^~\\&|PAS|HOSP|MEDICORE|HOSP|20260725103000||ADT^A01|CTRL001|P|2.5',
  'EVN|A01|20260725103000',
  'PID|1||MRN26000001^^^HOSP^MR||Mansouri^Ahmed||19850314|M',
  'PV1|1|I|WARD3^R12^B2||||||||||||||||ADM001|||||||||||||||||||||||||20260725103000',
].join('\r');

const oru = [
  'MSH|^~\\&|ANALYSER|LAB|MEDICORE|HOSP|20260725120000||ORU^R01|CTRL002|P|2.5',
  'PID|1||MRN26000001^^^HOSP^MR||Mansouri^Ahmed',
  'OBR|1|ORD9|LAB-2026-000042|24323-8^CMP^LN',
  'OBX|1|NM|2823-3^Potassium^LN||6.8|mmol/L|3.5-5.1|HH|||F',
].join('\r');

describe('parseHl7', () => {
  it('extracts the message type, trigger event and control id', () => {
    const m = parseHl7(adt);
    expect(m.messageType).toBe('ADT');
    expect(m.triggerEvent).toBe('A01');
    expect(m.controlId).toBe('CTRL001');
    expect(m.version).toBe('2.5');
  });

  it('splits every segment', () => {
    expect(parseHl7(adt).segments.map((s) => s.type)).toEqual(['MSH', 'EVN', 'PID', 'PV1']);
  });
});

describe('Hl7Service', () => {
  const service = new Hl7Service();

  it('accepts an ADT message and returns an AA acknowledgement', async () => {
    const ack = await service.receive(adt);
    expect(ack.code).toBe('AA');
    expect(ack.hl7).toContain('MSA|AA|CTRL001');
  });

  it('interprets ADT assigned location into ward, room and bed', () => {
    const data = service.interpret(parseHl7(adt)).data;
    expect(data).toMatchObject({
      trigger: 'A01',
      patient_identifier: 'MRN26000001',
      family_name: 'Mansouri',
      given_name: 'Ahmed',
      ward: 'WARD3',
      room: 'R12',
      bed: 'B2',
    });
  });

  it('interprets ORU observations with their units and flags', () => {
    const parsed = service.interpret(parseHl7(oru));
    expect(parsed.kind).toBe('result');
    const observations = parsed.data.observations as Array<Record<string, string>>;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      identifier: '2823-3',
      value: '6.8',
      unit: 'mmol/L',
      abnormal_flag: 'HH',
    });
    expect(parsed.data.accession).toBe('LAB-2026-000042');
  });

  it('rejects an unsupported message type with an AE acknowledgement', async () => {
    const unsupported = 'MSH|^~\\&|X|Y|Z|W|20260725||SIU^S12|CTRL9|P|2.5';
    const ack = await service.receive(unsupported);
    expect(ack.code).toBe('AE');
    expect(ack.hl7).toContain('MSA|AE|CTRL9');
  });

  it('rejects a message with no MSH-9 message type', async () => {
    const ack = await service.receive('MSH|^~\\&|X|Y|Z|W|20260725|||CTRL0|P|2.5');
    expect(ack.code).toBe('AR');
  });

  it('builds a well-formed outbound ADT^A01', () => {
    const out = service.buildAdt('A01', {
      patientIdentifier: 'MRN26000001',
      familyName: 'Mansouri',
      givenName: 'Ahmed',
      birthDate: '1985-03-14',
      gender: 'male',
      ward: 'WARD3',
      room: 'R12',
      bed: 'B2',
      patientClass: 'I',
      controlId: 'OUT001',
      occurredAt: new Date('2026-07-25T10:30:00Z'),
    });
    const parsed = parseHl7(out);
    expect(parsed.messageType).toBe('ADT');
    expect(parsed.triggerEvent).toBe('A01');
    expect(out).toContain('PID|1||MRN26000001^^^MEDICORE^MR||Mansouri^Ahmed||19850314|M');
    expect(out).toContain('PV1|1|I|WARD3^R12^B2');
  });

  it('maps gender to the HL7 sex code', () => {
    const base = {
      patientIdentifier: 'X',
      familyName: 'A',
      givenName: 'B',
      birthDate: '2000-01-01',
      ward: 'W',
      room: 'R',
      bed: 'B',
      patientClass: 'O',
      controlId: 'C',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    };
    expect(service.buildAdt('A01', { ...base, gender: 'female' })).toContain('|20000101|F');
    expect(service.buildAdt('A01', { ...base, gender: 'other' })).toContain('|20000101|O');
  });
});
