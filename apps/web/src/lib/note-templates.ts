/**
 * Starting scaffolds for the SOAP editor.
 *
 * Templates are prompts, not prose: they place the headings a clinician is
 * expected to address and leave the content blank, so nothing that was never
 * examined can end up in the record by inertia.
 */

export interface SoapSections {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface NoteTemplate {
  id: string;
  label: string;
  /** Note type the template is written for. */
  noteType: 'soap' | 'progress' | 'nursing' | 'discharge';
  sections: SoapSections;
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    noteType: 'soap',
    sections: { subjective: '', objective: '', assessment: '', plan: '' },
  },
  {
    id: 'general-consult',
    label: 'General consultation',
    noteType: 'soap',
    sections: {
      subjective: '• Presenting complaint:\n• History of presenting complaint:\n• Relevant past history:\n• Medications and allergies reviewed:\n• Ideas, concerns, expectations:',
      objective: '• General appearance:\n• Vital signs:\n• Systems examined:\n• Relevant negatives:',
      assessment: '• Working diagnosis:\n• Differential:\n• Severity / red flags:',
      plan: '• Investigations:\n• Treatment:\n• Safety netting advice:\n• Follow-up:',
    },
  },
  {
    id: 'follow-up',
    label: 'Follow-up review',
    noteType: 'progress',
    sections: {
      subjective: '• Interval history since last review:\n• Adherence to treatment:\n• Side effects reported:',
      objective: '• Vital signs:\n• Targeted examination:\n• Results reviewed:',
      assessment: '• Response to treatment:\n• Current control:',
      plan: '• Medication changes:\n• Monitoring:\n• Next review:',
    },
  },
  {
    id: 'nursing-shift',
    label: 'Nursing shift note',
    noteType: 'nursing',
    sections: {
      subjective: '• Patient-reported comfort and pain:\n• Concerns raised:',
      objective: '• Observations and EWS:\n• Intake and output:\n• Skin, mobility, lines and drains:',
      assessment: '• Clinical stability this shift:\n• Escalations made:',
      plan: '• Care due next shift:\n• Handover points:',
    },
  },
  {
    id: 'discharge-summary',
    label: 'Discharge summary',
    noteType: 'discharge',
    sections: {
      subjective: '• Reason for admission:\n• Course of stay:',
      objective: '• Key investigations and results:\n• Procedures performed:',
      assessment: '• Discharge diagnosis:\n• Complications:',
      plan: '• Discharge medications:\n• Follow-up arrangements:\n• Advice given to the patient:\n• When to seek help:',
    },
  },
  {
    id: 'acute-abdomen',
    label: 'Acute abdominal pain',
    noteType: 'soap',
    sections: {
      subjective: '• Site, onset, character, radiation:\n• Aggravating and relieving factors:\n• Bowel habit, urinary symptoms, appetite:\n• Last menstrual period (if applicable):',
      objective: '• Vital signs:\n• Abdominal examination — tenderness, guarding, rebound:\n• Bowel sounds:\n• Per rectum / pelvic examination if indicated:',
      assessment: '• Working diagnosis:\n• Surgical causes considered and excluded:',
      plan: '• Bloods, urinalysis, imaging:\n• Analgesia and fluids:\n• Surgical review:\n• Reassessment interval:',
    },
  },
];

export function templateById(id: string): NoteTemplate | undefined {
  return NOTE_TEMPLATES.find((template) => template.id === id);
}
