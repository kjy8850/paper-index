// =====================================================================
// Layer 4 (Claude Deep Parser) 가 사용하는 JSON Schema 모음.
// schema 의 모든 필드는 nullable 로 두어 모델이 자신없는 항목을 빠뜨릴 수 있게 함.
// =====================================================================

const NUMBER_OR_NULL = { type: ['number', 'null'] };
const STRING_OR_NULL = { type: ['string', 'null'] };
const BOOL_OR_NULL   = { type: ['boolean', 'null'] };

// 공통 메타 (어느 paper_type 이든 항상 채워주길 권장)
const COMMON = {
  key_findings:        { type: 'string', description: '핵심 결론 3-5문장 한국어' },
  limitations:         STRING_OR_NULL,
  reference_systems:   { type: 'array', items: STRING_OR_NULL, description: '비교 대상 / 레퍼런스' },
  equipment_methods:   { type: 'array', items: STRING_OR_NULL, description: '장비 / 측정' },
  authors_summary:     STRING_OR_NULL,
};

// composition: PR 조성물 — composition_data 와 1:1 정렬
const COMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    paper_type:   { type: 'string', enum: ['composition'] },
    relevance:    { type: 'string', enum: ['yes', 'no'] }, // unsure 재판정 결과
    resin_type:   STRING_OR_NULL,
    resin_mw:     {
      type: 'object', additionalProperties: false,
      properties: { Mn: NUMBER_OR_NULL, Mw: NUMBER_OR_NULL, PDI: NUMBER_OR_NULL },
    },
    resin_ratio:  STRING_OR_NULL,
    pag_type:     STRING_OR_NULL,
    pag_ratio:    STRING_OR_NULL,
    solvent:      STRING_OR_NULL,
    quencher:     STRING_OR_NULL,
    additives:    { type: 'array', items: STRING_OR_NULL },
    sensitivity:  NUMBER_OR_NULL,   // mJ/cm^2
    resolution:   NUMBER_OR_NULL,   // nm
    ler:          NUMBER_OR_NULL,
    euv_dose:     NUMBER_OR_NULL,
    optimal_flag: BOOL_OR_NULL,
    ...COMMON,
  },
  required: ['paper_type', 'relevance', 'key_findings'],
};

// reaction: 수지 합성 반응
const REACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    paper_type: { type: 'string', enum: ['reaction'] },
    relevance:  { type: 'string', enum: ['yes', 'no'] },

    monomers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name:    STRING_OR_NULL,
          content: STRING_OR_NULL,
          order:   STRING_OR_NULL,
        },
      },
    },
    initiator_type:    STRING_OR_NULL,
    initiator_content: STRING_OR_NULL,
    initiator_method:  STRING_OR_NULL,

    temperature:   NUMBER_OR_NULL, // °C
    dropping_time: NUMBER_OR_NULL, // h
    aging_time:    NUMBER_OR_NULL, // h

    solvent:        STRING_OR_NULL,
    solvent_ratio:  STRING_OR_NULL,
    atmosphere:     STRING_OR_NULL,
    monomer_conc:   NUMBER_OR_NULL,

    polymerization_type: STRING_OR_NULL,
    cta_type:            STRING_OR_NULL,
    cta_content:         STRING_OR_NULL,

    methanolysis:       BOOL_OR_NULL,
    methanolysis_temp:  NUMBER_OR_NULL,
    precipitation: {
      type: 'object', additionalProperties: false,
      properties: {
        solvent: STRING_OR_NULL,
        ratio:   STRING_OR_NULL,
      },
    },
    filtration: STRING_OR_NULL,
    drying:     STRING_OR_NULL,

    yield_pct:           NUMBER_OR_NULL,
    mw_result: {
      type: 'object', additionalProperties: false,
      properties: { Mn: NUMBER_OR_NULL, Mw: NUMBER_OR_NULL, PDI: NUMBER_OR_NULL },
    },
    composition_result: STRING_OR_NULL,

    deprotection_temp:  NUMBER_OR_NULL,
    activation_energy:  NUMBER_OR_NULL,

    litho_sensitivity:  NUMBER_OR_NULL,
    litho_resolution:   NUMBER_OR_NULL,
    litho_ler:          NUMBER_OR_NULL,
    litho_euv_dose:     NUMBER_OR_NULL,
    ...COMMON,
  },
  required: ['paper_type', 'relevance', 'key_findings'],
};

// process / other / unknown 은 자유 형식 + 공통
const FREEFORM_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    paper_type: { type: 'string', enum: ['process', 'other', 'unknown', 'abstract_only'] },
    relevance:  { type: 'string', enum: ['yes', 'no'] },
    notes:      STRING_OR_NULL,
    ...COMMON,
  },
  required: ['paper_type', 'relevance', 'key_findings'],
};

export function getSchemaForType(paperType) {
  switch (paperType) {
    case 'composition': return COMPOSITION_SCHEMA;
    case 'reaction':    return REACTION_SCHEMA;
    case 'process':
    case 'other':
    case 'abstract_only':
    case 'unknown':
    default:            return FREEFORM_SCHEMA;
  }
}

export const SCHEMAS = {
  composition: COMPOSITION_SCHEMA,
  reaction:    REACTION_SCHEMA,
  freeform:    FREEFORM_SCHEMA,
};
