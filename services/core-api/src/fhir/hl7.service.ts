import { Injectable, Logger } from '@nestjs/common';

export interface Hl7Segment {
  type: string;
  fields: string[];
}

export interface Hl7Message {
  raw: string;
  segments: Hl7Segment[];
  messageType: string;
  triggerEvent: string;
  controlId: string;
  sendingApplication: string;
  version: string;
}

const FIELD = '|';
const SEGMENT = /\r\n|\r|\n/;

export function parseHl7(raw: string): Hl7Message {
  const segments = raw
    .split(SEGMENT)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(FIELD);
      return { type: fields[0] ?? '', fields };
    });

  const msh = segments.find((s) => s.type === 'MSH');
  const [messageType = '', triggerEvent = ''] = (msh?.fields[8] ?? '').split('^');

  return {
    raw,
    segments,
    messageType,
    triggerEvent,
    controlId: msh?.fields[9] ?? '',
    sendingApplication: msh?.fields[2] ?? '',
    version: msh?.fields[11] ?? '2.5',
  };
}

export interface Ack {
  code: 'AA' | 'AE' | 'AR';
  message: string;
  hl7: string;
}

/**
 * HL7 v2 bridge for ADT (admit/discharge/transfer), ORM (orders), ORU (results)
 * and RDS (pharmacy dispense) messages exchanged with legacy hospital systems.
 */
@Injectable()
export class Hl7Service {
  private readonly logger = new Logger(Hl7Service.name);

  /** Builds an MSA acknowledgement in the form the sending system expects. */
  buildAck(message: Hl7Message, code: Ack['code'], text: string): string {
    const now = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    return [
      `MSH|^~\\&|MEDICORE|HOSP|${message.sendingApplication}|EXT|${now}||ACK|${message.controlId}|P|${message.version}`,
      `MSA|${code}|${message.controlId}|${text}`,
    ].join('\r');
  }

  private field(message: Hl7Message, segment: string, index: number): string | null {
    return message.segments.find((s) => s.type === segment)?.fields[index] ?? null;
  }

  private component(value: string | null, index: number): string | null {
    return value?.split('^')[index] ?? null;
  }

  /** Routes an inbound message to its handler and returns an ACK. */
  async receive(raw: string): Promise<Ack> {
    let message: Hl7Message;
    try {
      message = parseHl7(raw);
    } catch (e) {
      return { code: 'AR', message: `Unparseable message: ${String(e)}`, hl7: '' };
    }

    if (message.messageType === '') {
      return { code: 'AR', message: 'Missing MSH-9 message type', hl7: this.buildAck(message, 'AR', 'Missing message type') };
    }

    try {
      const parsed = this.interpret(message);
      this.logger.log(
        `Received ${message.messageType}^${message.triggerEvent} (${message.controlId}) — ${parsed.summary}`,
      );
      return {
        code: 'AA',
        message: parsed.summary,
        hl7: this.buildAck(message, 'AA', 'Message accepted'),
      };
    } catch (e) {
      return {
        code: 'AE',
        message: String(e),
        hl7: this.buildAck(message, 'AE', `Processing error: ${String(e)}`),
      };
    }
  }

  /** Extracts the fields each supported message family carries. */
  interpret(message: Hl7Message): { kind: string; summary: string; data: Record<string, unknown> } {
    const patientId = this.component(this.field(message, 'PID', 3), 0);
    const familyName = this.component(this.field(message, 'PID', 5), 0);
    const givenName = this.component(this.field(message, 'PID', 5), 1);

    switch (message.messageType) {
      case 'ADT': {
        const pv1 = this.field(message, 'PV1', 3);
        return {
          kind: 'adt',
          summary: `ADT^${message.triggerEvent} for ${patientId}`,
          data: {
            trigger: message.triggerEvent,
            patient_identifier: patientId,
            family_name: familyName,
            given_name: givenName,
            patient_class: this.field(message, 'PV1', 2),
            assigned_location: pv1,
            ward: this.component(pv1, 0),
            room: this.component(pv1, 1),
            bed: this.component(pv1, 2),
            admit_datetime: this.field(message, 'PV1', 44),
            discharge_datetime: this.field(message, 'PV1', 45),
          },
        };
      }
      case 'ORM': {
        const obr = this.field(message, 'OBR', 4);
        return {
          kind: 'order',
          summary: `Order ${this.component(obr, 0)} for ${patientId}`,
          data: {
            patient_identifier: patientId,
            placer_order_number: this.field(message, 'ORC', 2),
            filler_order_number: this.field(message, 'ORC', 3),
            order_control: this.field(message, 'ORC', 1),
            universal_service_id: this.component(obr, 0),
            service_description: this.component(obr, 1),
            priority: this.field(message, 'OBR', 5),
          },
        };
      }
      case 'ORU': {
        const observations = message.segments
          .filter((s) => s.type === 'OBX')
          .map((s) => ({
            set_id: s.fields[1],
            value_type: s.fields[2],
            identifier: this.component(s.fields[3] ?? null, 0),
            display: this.component(s.fields[3] ?? null, 1),
            value: s.fields[5],
            unit: s.fields[6],
            reference_range: s.fields[7],
            abnormal_flag: s.fields[8],
            status: s.fields[11],
          }));
        return {
          kind: 'result',
          summary: `${observations.length} observations for ${patientId}`,
          data: {
            patient_identifier: patientId,
            accession: this.component(this.field(message, 'OBR', 3), 0),
            observations,
          },
        };
      }
      case 'RDS': {
        const rxd = message.segments.find((s) => s.type === 'RXD');
        return {
          kind: 'dispense',
          summary: `Dispense for ${patientId}`,
          data: {
            patient_identifier: patientId,
            dispense_sub_id: rxd?.fields[1],
            dispense_code: this.component(rxd?.fields[2] ?? null, 0),
            dispense_name: this.component(rxd?.fields[2] ?? null, 1),
            dispensed_at: rxd?.fields[3],
            actual_dispense_amount: rxd?.fields[4],
            units: this.component(rxd?.fields[5] ?? null, 0),
            lot_number: rxd?.fields[18],
            expiry_date: rxd?.fields[19],
          },
        };
      }
      default:
        throw new Error(`Unsupported message type ${message.messageType}`);
    }
  }

  /** Renders an outbound ADT^A01/A03/A02 for downstream legacy systems. */
  buildAdt(
    trigger: 'A01' | 'A02' | 'A03',
    data: {
      patientIdentifier: string;
      familyName: string;
      givenName: string;
      birthDate: string;
      gender: string;
      ward: string;
      room: string;
      bed: string;
      patientClass: string;
      controlId: string;
      occurredAt: Date;
    },
  ): string {
    const ts = data.occurredAt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dob = data.birthDate.replace(/-/g, '');
    const sex = data.gender === 'male' ? 'M' : data.gender === 'female' ? 'F' : 'O';
    return [
      `MSH|^~\\&|MEDICORE|HOSP|EXT|EXT|${ts}||ADT^${trigger}|${data.controlId}|P|2.5`,
      `EVN|${trigger}|${ts}`,
      `PID|1||${data.patientIdentifier}^^^MEDICORE^MR||${data.familyName}^${data.givenName}||${dob}|${sex}`,
      `PV1|1|${data.patientClass}|${data.ward}^${data.room}^${data.bed}`,
    ].join('\r');
  }
}
