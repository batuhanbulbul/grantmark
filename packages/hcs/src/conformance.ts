/**
 * Conformance checks for HCS declarations (HCS 1.0 Draft, 2026-08-08).
 *
 * `checkDocument` applies every rule that can be decided from the document alone: document
 * structure, `<hcs:right>` attributes and children, usage tokens, subject-scope vocabularies,
 * `<license>` contents, the required `<legal>` elements (§6.4) and the `<schema>` profile
 * (§3.2). A declaration that fails any of them is not operative (§3). Rules that need a time or
 * outside records (lifecycle, registry lookups, the Rights Subject Record, conflicts, minors)
 * are applied by later stages. Problems with `<hcs:certification>` are warnings only, because
 * certification does not affect whether a declaration is operative (§3.3).
 */

import { isValidHcsId } from './ids';
import {
  collapse,
  isAbsoluteUri,
  isDecimal,
  isHttpsUrl,
  isMailtoUrl,
  isQName,
  parsePositiveInteger,
  parseTimestamp,
  splitList,
} from './lexical';
import {
  HCS_NAMESPACE,
  RSL_NAMESPACE,
  type HcsComponentReference,
  type HcsDocument,
  type HcsLicense,
  type HcsNode,
  type HcsRight,
} from './parser';
import { checkDefaultDeclarationObject, checkRightsSubjectObject, type SchemaProblem } from './profiles';
import {
  DECLARATION_STATUSES,
  RSL_DISCLAIMER_TOKENS,
  RSL_LEGAL_TYPES,
  RSL_PAYMENT_TYPES,
  RSL_REPORTING_TYPES,
  RSL_USER_TOKENS,
  RSL_WARRANTY_TOKENS,
  SUBJECT_CATEGORIES,
  SUBJECT_SCOPES,
  USAGE_TOKENS,
  type DeclarationStatus,
  type SubjectCategory,
  type UsageToken,
} from './vocabulary';

export type FindingCode =
  | 'hcs_namespace_not_on_root'
  | 'invalid_root_attribute'
  | 'unexpected_root_element'
  | 'duplicate_registration_id'
  | 'missing_attribute'
  | 'unknown_attribute'
  | 'foreign_attribute'
  | 'invalid_attribute_value'
  | 'subject_identification'
  | 'invalid_subject_scope'
  | 'element_count'
  | 'unexpected_element'
  | 'unexpected_text'
  | 'unrecognized_usage_token'
  | 'invalid_element_value'
  | 'legal_attestation'
  | 'legal_contact'
  | 'schema_invalid'
  | 'component_reference'
  | 'certification_invalid';

export interface Finding<Code extends string = FindingCode> {
  readonly code: Code;
  /** The rule that fails, e.g. "HCS §6.4" or "RSL §3.5". */
  readonly rule: string;
  /** Location inside the declaration, e.g. `@registry` or `license[2]/permits[1]`. */
  readonly at: string;
  readonly message: string;
}

/** A Timestamp as written and as milliseconds since the epoch. */
export interface Timestamp {
  readonly text: string;
  readonly time: number;
}

/** Tokens of `<permits>` or `<prohibits>` by `type`, deduplicated. Absent types are unset. */
export interface TypedTokens {
  readonly usage?: readonly UsageToken[] | undefined;
  readonly user?: readonly string[] | undefined;
  readonly geo?: readonly string[] | undefined;
}

export interface PaymentTerms {
  /** The `type` attribute as written; interpretation is left to the evaluator. */
  readonly type?: string | undefined;
  readonly amount?: { readonly currency: string; readonly value: string } | undefined;
  readonly standard?: string | undefined;
  readonly custom?: string | undefined;
  readonly accepts?: { readonly type: string; readonly value: string } | undefined;
}

export interface ReportingTerms {
  readonly type: string;
  readonly profile: string;
  readonly endpoint?: string | undefined;
}

export interface LicenseTerms {
  readonly permits: TypedTokens;
  readonly prohibits: TypedTokens;
  readonly payment?: PaymentTerms | undefined;
  readonly reporting: readonly ReportingTerms[];
  /** The `<legal type="contact">` URL (§6.4). */
  readonly contact: string;
  readonly warranty?: readonly string[] | undefined;
  readonly disclaimer?: readonly string[] | undefined;
  readonly proof?: readonly string[] | undefined;
  /** The exact source text of the `<license>` element. */
  readonly source: string;
}

/** A conforming declaration, with whitespace-collapsed and deduplicated values. */
export interface Declaration {
  readonly registry: string;
  readonly registrationId: string;
  readonly issued: Timestamp;
  readonly subject: SubjectCategory;
  /** Absent when the declaration covers every Rights Scope (§3.1.6.2). */
  readonly subjectScope?: readonly string[] | undefined;
  /** Absent when the declaration has no territorial limit (§3.1.6.7). */
  readonly territory?: readonly string[] | undefined;
  /** Exactly one of `subjectId` and `subjectClass` is set. */
  readonly subjectId?: string | undefined;
  readonly subjectClass?: string | undefined;
  readonly status: DeclarationStatus;
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
  readonly validFrom?: Timestamp | undefined;
  readonly validUntil?: Timestamp | undefined;
  /** `max-age` on `<hcs:right>`, in days. */
  readonly maxAge?: number | undefined;
  /** `max-age` on the `<rsl>` root, in days. */
  readonly documentMaxAge?: number | undefined;
  readonly server?: string | undefined;
  readonly schema: Readonly<Record<string, unknown>>;
  /** The Schema Profile Identifier from `additionalType`. */
  readonly profile: string;
  readonly terms?: string | undefined;
  readonly licenses: readonly LicenseTerms[];
  /** Component HCRNs listed with `<hcs:includes>`. */
  readonly includes: readonly string[];
  /** The title HCRN named by `<hcs:included>`. */
  readonly included?: string | undefined;
  /** The exact source text of the `<hcs:right>` element. */
  readonly source: string;
}

export interface DeclarationCheck {
  /** Every failed rule. Any reason makes the declaration non-operative. */
  readonly reasons: readonly Finding[];
  /** Problems that do not affect operativeness. */
  readonly warnings: readonly Finding[];
  /** Present only when there are no reasons. */
  readonly declaration?: Declaration | undefined;
}

type Report = (code: FindingCode, rule: string, at: string, message: string) => void;

const APPENDIX_A = 'HCS Appendix A';

const RIGHT_ATTRIBUTES = [
  'registry', 'registration-id', 'issued', 'subject', 'subject-scope', 'territory', 'subject-id',
  'subject-class', 'status', 'supersedes', 'superseded-by', 'valid-from', 'valid-until', 'max-age',
  'server',
];

const join = (path: string, part: string) => (path === '' ? part : `${path}/${part}`);
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** Reports attributes other than `allowed`, and any namespaced attribute. */
function checkAttributeNames(node: HcsNode, allowed: readonly string[], at: string, report: Report): void {
  for (const name of Object.keys(node.attributes)) {
    if (!allowed.includes(name)) {
      report('unknown_attribute', APPENDIX_A, join(at, `@${name}`), `attribute ${name} is not defined here`);
    }
  }
  for (const attribute of node.foreignAttributes) {
    report(
      'foreign_attribute',
      APPENDIX_A,
      join(at, `@${attribute.name}`),
      `namespaced attribute ${attribute.name} is not allowed on this element`,
    );
  }
}

/** Reports stray text and misplaced RSL/HCS children; extension elements are allowed. */
function checkContainer(node: HcsNode, at: string, report: Report): void {
  if (collapse(node.text) !== '') report('unexpected_text', APPENDIX_A, join(at, 'text()'), 'text is not allowed here');
  for (const child of node.unexpected) {
    report('unexpected_element', APPENDIX_A, join(at, child.name), `<${child.name}> is not allowed here`);
  }
}

/** Reports any child element of an element that holds only text. */
function checkLeaf(node: HcsNode, at: string, report: Report): void {
  for (const child of [...node.unexpected, ...node.extensions]) {
    report('unexpected_element', APPENDIX_A, join(at, child.name), `<${child.name}> is not allowed here`);
  }
}

/**
 * Reads an attribute after whitespace collapsing. Returns undefined when it is absent or
 * invalid; invalid values are reported.
 */
function readAttribute<T>(
  node: HcsNode,
  name: string,
  at: string,
  rule: string,
  parse: (value: string) => T | undefined,
  expected: string,
  report: Report,
  required = false,
): T | undefined {
  const raw = node.attributes[name];
  if (raw === undefined) {
    if (required) report('missing_attribute', rule, join(at, `@${name}`), `${name} is required`);
    return undefined;
  }
  const value = parse(collapse(raw));
  if (value === undefined) {
    report('invalid_attribute_value', rule, join(at, `@${name}`), `${name} must be ${expected}, found "${raw}"`);
  }
  return value;
}

const asHttps = (v: string) => (isHttpsUrl(v) ? v : undefined);
const asHcrn = (v: string) => (isValidHcsId(v, 'HCRN') ? v : undefined);
const asHcsi = (v: string) => (isValidHcsId(v, 'HCSI') ? v : undefined);
const asTimestamp = (v: string): Timestamp | undefined => {
  const time = parseTimestamp(v);
  return time === undefined ? undefined : { text: v, time };
};
const asOneOf =
  <T extends string>(list: readonly T[]) =>
  (v: string): T | undefined =>
    isOneOf(list, v) ? v : undefined;
const asList = (valid: (item: string) => boolean) => (v: string) => {
  const items = splitList(v);
  return items.length > 0 && items.every(valid) ? unique(items) : undefined;
};

function checkTypedTokens(
  nodes: readonly HcsNode[],
  kind: 'permits' | 'prohibits',
  at: string,
  report: Report,
): TypedTokens {
  const rule = kind === 'permits' ? 'RSL §3.5' : 'RSL §3.6';
  const result: { usage?: UsageToken[]; user?: string[]; geo?: string[] } = {};
  nodes.forEach((node, i) => {
    const path = join(at, `${kind}[${i + 1}]`);
    checkAttributeNames(node, ['type'], path, report);
    checkLeaf(node, path, report);
    const type = readAttribute(node, 'type', path, rule, asOneOf(['usage', 'user', 'geo'] as const), 'usage, user or geo', report, true);
    if (type === undefined) return;
    if (result[type] !== undefined) {
      report('element_count', rule, path, `at most one <${kind} type="${type}"> is allowed`);
      return;
    }
    const tokens = unique(splitList(node.text));
    if (tokens.length === 0) {
      report('invalid_element_value', rule, path, `<${kind}> must list at least one token`);
      return;
    }
    if (type === 'usage') {
      const unrecognized = tokens.filter((t) => !isOneOf(USAGE_TOKENS, t));
      if (unrecognized.length > 0) {
        report(
          'unrecognized_usage_token',
          'HCS §3',
          path,
          `usage token ${unrecognized.join(', ')} is not recognized; only ${USAGE_TOKENS.join(' and ')} are allowed`,
        );
        return;
      }
      result.usage = tokens as UsageToken[];
    } else {
      const valid = type === 'user' ? (t: string) => RSL_USER_TOKENS.includes(t) || isQName(t) : (t: string) => /^([A-Z]{2}|EU)$/.test(t);
      const invalid = tokens.filter((t) => !valid(t));
      if (invalid.length > 0) {
        report('invalid_element_value', rule, path, `${type} token ${invalid.join(', ')} is not valid`);
        return;
      }
      result[type] = tokens;
    }
  });
  return result;
}

/** Reports more than one element of a kind and returns the first. */
function atMostOne<T extends HcsNode>(nodes: readonly T[], name: string, at: string, rule: string, report: Report): T | undefined {
  if (nodes.length > 1) report('element_count', rule, join(at, name), `at most one <${name}> is allowed`);
  return nodes[0];
}

function checkPayment(license: HcsLicense, at: string, report: Report): PaymentTerms | undefined {
  const payment = atMostOne(license.payments, 'payment', at, 'RSL §3.7', report);
  if (payment === undefined) return undefined;
  const path = join(at, 'payment');
  checkAttributeNames(payment, ['type'], path, report);
  checkContainer(payment, path, report);
  const type = readAttribute(payment, 'type', path, 'RSL §3.7', (v) => (RSL_PAYMENT_TYPES.includes(v) || isQName(v) ? v : undefined), 'an RSL payment type or a QName', report);

  const leaf = (nodes: readonly HcsNode[], name: string, rule: string, attributes: string[] = []) => {
    const node = atMostOne(nodes, name, path, rule, report);
    if (node !== undefined) {
      checkAttributeNames(node, attributes, join(path, name), report);
      checkLeaf(node, join(path, name), report);
    }
    return node;
  };
  const invalid = (name: string, rule: string, message: string) =>
    report('invalid_element_value', rule, join(path, name), message);

  const standardNode = leaf(payment.standard, 'standard', 'RSL §3.8');
  const standard = standardNode && collapse(standardNode.text);
  if (standard !== undefined && !isAbsoluteUri(standard)) invalid('standard', 'RSL §3.8', '<standard> must be an absolute URL');

  const customNode = leaf(payment.custom, 'custom', 'RSL §3.9');
  const custom = customNode && collapse(customNode.text);
  if (custom === '') invalid('custom', 'RSL §3.9', '<custom> must be a URL or path');

  let amount: PaymentTerms['amount'];
  const amountNode = leaf(payment.amounts, 'amount', 'RSL §3.10', ['currency']);
  if (amountNode !== undefined) {
    const currency = amountNode.attributes.currency;
    const value = collapse(amountNode.text);
    if (currency === undefined) {
      report('missing_attribute', 'RSL §3.10', join(path, 'amount/@currency'), 'currency is required');
    } else if (!/^[A-Z]{3}$/.test(currency)) {
      report('invalid_attribute_value', 'RSL §3.10', join(path, 'amount/@currency'), `currency must be an ISO 4217 code, found "${currency}"`);
    }
    if (!isDecimal(value)) invalid('amount', 'RSL §3.10', `<amount> must be a decimal, found "${value}"`);
    if (currency !== undefined) amount = { currency, value };
  }

  let accepts: PaymentTerms['accepts'];
  const acceptsNode = leaf(payment.accepts, 'accepts', 'RSL §3.11', ['type']);
  if (acceptsNode !== undefined) {
    const acceptsType = acceptsNode.attributes.type;
    if (acceptsType === undefined) {
      report('missing_attribute', 'RSL §3.11', join(path, 'accepts/@type'), 'type is required');
    } else {
      accepts = { type: acceptsType, value: acceptsNode.text };
    }
  }

  return { type, amount, standard, custom, accepts };
}

function checkReporting(license: HcsLicense, at: string, report: Report): ReportingTerms[] {
  const result: ReportingTerms[] = [];
  license.reporting.forEach((node, i) => {
    const path = join(at, `reporting[${i + 1}]`);
    const rule = 'RSL §3.12';
    checkAttributeNames(node, ['type', 'profile', 'endpoint'], path, report);
    checkLeaf(node, path, report);
    const type = readAttribute(node, 'type', path, rule, asOneOf(RSL_REPORTING_TYPES), RSL_REPORTING_TYPES.join(', '), report, true);
    const profile = readAttribute(node, 'profile', path, rule, (v) => (isAbsoluteUri(v) ? v : undefined), 'an absolute URI', report, true);
    const endpoint = readAttribute(node, 'endpoint', path, rule, asHttps, 'an absolute HTTPS URL', report);
    if (type !== undefined && profile !== undefined) result.push({ type, profile, endpoint });
  });
  return result;
}

interface LegalTerms {
  contact?: string;
  warranty?: string[];
  disclaimer?: string[];
  proof?: string[];
}

function checkLegal(license: HcsLicense, at: string, report: Report): LegalTerms {
  const byType = new Map<string, HcsNode[]>();
  license.legal.forEach((node, i) => {
    const path = join(at, `legal[${i + 1}]`);
    checkAttributeNames(node, ['type'], path, report);
    checkLeaf(node, path, report);
    const type = readAttribute(node, 'type', path, 'RSL §3.13', asOneOf(RSL_LEGAL_TYPES), RSL_LEGAL_TYPES.join(', '), report, true);
    if (type !== undefined) byType.set(type, [...(byType.get(type) ?? []), node]);
  });

  const attestations = byType.get('attestation') ?? [];
  if (attestations.length !== 1) {
    report('legal_attestation', 'HCS §6.4', at, `exactly one <legal type="attestation"> is required, found ${attestations.length}`);
  } else if (collapse(attestations[0]!.text) !== 'true') {
    report('legal_attestation', 'HCS §6.4', at, '<legal type="attestation"> must contain the lowercase token true');
  }

  const result: LegalTerms = {};
  const contacts = byType.get('contact') ?? [];
  if (contacts.length !== 1) {
    report('legal_contact', 'HCS §6.4', at, `exactly one <legal type="contact"> is required, found ${contacts.length}`);
  } else {
    const contact = collapse(contacts[0]!.text);
    if (isHttpsUrl(contact) || isMailtoUrl(contact)) result.contact = contact;
    else report('legal_contact', 'HCS §6.4', at, '<legal type="contact"> must be a single https or mailto URL');
  }

  const list = (type: 'warranty' | 'disclaimer' | 'proof', valid: (token: string) => boolean) => {
    const nodes = byType.get(type) ?? [];
    if (nodes.length > 1) report('element_count', 'RSL §3.13', at, `at most one <legal type="${type}"> is allowed`);
    if (nodes[0] === undefined) return;
    const tokens = unique(splitList(nodes[0].text));
    if (tokens.length > 0 && tokens.every(valid)) result[type] = tokens;
    else report('invalid_element_value', 'RSL §3.13', at, `<legal type="${type}"> has an invalid value`);
  };
  list('warranty', (t) => RSL_WARRANTY_TOKENS.includes(t));
  list('disclaimer', (t) => RSL_DISCLAIMER_TOKENS.includes(t));
  list('proof', isAbsoluteUri);
  return result;
}

function checkLicense(license: HcsLicense, at: string, source: string, report: Report): LicenseTerms | undefined {
  checkAttributeNames(license, [], at, report);
  checkContainer(license, at, report);
  const permits = checkTypedTokens(license.permits, 'permits', at, report);
  const prohibits = checkTypedTokens(license.prohibits, 'prohibits', at, report);
  const payment = checkPayment(license, at, report);
  const reporting = checkReporting(license, at, report);
  const legal = checkLegal(license, at, report);
  if (legal.contact === undefined) return undefined;
  return {
    permits,
    prohibits,
    payment,
    reporting,
    contact: legal.contact,
    warranty: legal.warranty,
    disclaimer: legal.disclaimer,
    proof: legal.proof,
    source,
  };
}

function checkCertifications(right: HcsRight, issued: Timestamp | undefined, warn: Report): void {
  const rule = 'HCS §3.3';
  atMostOne(right.certifications, 'hcs:certification', '', rule, warn);
  for (const node of right.certifications) {
    const at = 'hcs:certification';
    checkAttributeNames(node, ['name', 'contact', 'role', 'time', 'jws'], at, warn);
    checkLeaf(node, at, warn);
    if (collapse(node.text) !== '') warn('certification_invalid', rule, at, '<hcs:certification> must be empty');
    readAttribute(node, 'name', at, rule, (v) => (v === '' ? undefined : v), 'a non-empty name', warn, true);
    readAttribute(node, 'contact', at, rule, (v) => (isHttpsUrl(v) || isMailtoUrl(v) ? v : undefined), 'an https or mailto URL', warn, true);
    readAttribute(node, 'role', at, rule, (v) => (/^[a-z]+(-[a-z]+)*$/.test(v) ? v : undefined), 'lowercase words joined by single hyphens', warn);
    const time = readAttribute(node, 'time', at, rule, asTimestamp, 'a Timestamp', warn, true);
    if (time !== undefined && issued !== undefined && time.time < issued.time) {
      warn('certification_invalid', rule, join(at, '@time'), 'certification time must not precede issued');
    }
    readAttribute(node, 'jws', at, 'HCS §3.3.4', (v) => (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v) ? v : undefined), 'a JWS in compact serialization', warn, true);
  }
}

function checkComponentReferences(right: HcsRight, isDefault: boolean, report: Report): { includes: string[]; included?: string } {
  const rule = 'HCS §3.4';
  if (right.includes.length > 0 && right.included.length > 0) {
    report('component_reference', rule, 'hcs:included', 'a declaration must not contain both <hcs:includes> and <hcs:included>');
  }
  if (isDefault && right.includes.length + right.included.length > 0) {
    report('component_reference', rule, 'hcs:includes', 'Default Declarations must not contain component references');
  }
  atMostOne(right.included, 'hcs:included', '', rule, report);

  const read = (node: HcsComponentReference, at: string) => {
    checkAttributeNames(node, ['registration-id'], at, report);
    checkContainer(node, at, report);
    for (const child of node.extensions) {
      report('unexpected_element', APPENDIX_A, join(at, child.name), `<${child.name}> is not allowed here`);
    }
    const schema = atMostOne(node.schemas, 'schema', at, rule, report);
    if (schema !== undefined) {
      checkAttributeNames(schema, ['type'], join(at, 'schema'), report);
      checkLeaf(schema, join(at, 'schema'), report);
      readAttribute(schema, 'type', join(at, 'schema'), 'RSL §3.15', asOneOf(['application/ld+json']), 'application/ld+json', report);
    }
    return readAttribute(node, 'registration-id', at, rule, asHcrn, 'a valid HCRN', report, true);
  };

  const includes = right.includes
    .map((node, i) => read(node, `hcs:includes[${i + 1}]`))
    .filter((id): id is string => id !== undefined);
  const included = right.included[0] && read(right.included[0], 'hcs:included');
  return included === undefined ? { includes } : { includes, included };
}

function checkSchema(
  right: HcsRight,
  subject: SubjectCategory | undefined,
  subjectId: string | undefined,
  subjectClass: string | undefined,
  report: Report,
): Record<string, unknown> | undefined {
  if (right.schemas.length !== 1) {
    report('element_count', 'HCS §3.1', 'schema', `exactly one <schema> is required, found ${right.schemas.length}`);
    return undefined;
  }
  const node = right.schemas[0]!;
  checkAttributeNames(node, ['type'], 'schema', report);
  checkLeaf(node, 'schema', report);
  const type = readAttribute(node, 'type', 'schema', 'HCS §3.2', asOneOf(['application/ld+json']), 'application/ld+json', report, true);
  if (type === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(node.text);
  } catch {
    report('schema_invalid', 'HCS §3.2', 'schema', '<schema> must contain JSON-LD');
    return undefined;
  }

  let problems: SchemaProblem[] | undefined;
  if (subject !== undefined && subjectId !== undefined && subjectClass === undefined) {
    problems = checkRightsSubjectObject(value, { subject, subjectId });
  } else if (subject !== undefined && subjectClass !== undefined && subjectId === undefined) {
    problems = checkDefaultDeclarationObject(value, { subject, subjectClass });
  }
  for (const problem of problems ?? []) {
    report('schema_invalid', problem.rule, problem.at === '' ? 'schema' : `schema/${problem.at}`, problem.message);
  }
  return problems?.length === 0 ? (value as Record<string, unknown>) : undefined;
}

function checkRight(document: HcsDocument, right: HcsRight, report: Report, warn: Report): Declaration | undefined {
  checkAttributeNames(right, RIGHT_ATTRIBUTES, '', report);
  checkContainer(right, '', report);
  const read = <T>(name: string, rule: string, parse: (v: string) => T | undefined, expected: string, required = false) =>
    readAttribute(right, name, '', rule, parse, expected, report, required);

  const registry = read('registry', 'HCS §3.1.1', asHttps, 'an absolute HTTPS URL', true);
  const registrationId = read('registration-id', 'HCS §3.1.2', asHcrn, 'a valid HCRN', true);
  const issued = read('issued', 'HCS §3.1.3', asTimestamp, 'a Timestamp', true);
  const subject = read('subject', 'HCS §3.1.6.1', asOneOf(SUBJECT_CATEGORIES), SUBJECT_CATEGORIES.join(', '), true);
  const territory = read('territory', 'HCS §3.1.6.7', asList((c) => /^[A-Z]{2}$/.test(c)), 'a list of ISO 3166-1 alpha-2 codes');
  const subjectId = read('subject-id', 'HCS §3.1.4', asHcsi, 'a valid HCSI');
  const subjectClass = read('subject-class', 'HCS §3.1.5', asHttps, 'an absolute HTTPS URL');
  const status = read('status', 'HCS §3.1.7.1', asOneOf(DECLARATION_STATUSES), DECLARATION_STATUSES.join(', ')) ?? 'active';
  const hcrnList = asList((id) => isValidHcsId(id, 'HCRN'));
  const supersedes = read('supersedes', 'HCS §3.1.7.3', hcrnList, 'a list of valid HCRNs') ?? [];
  const supersededBy = read('superseded-by', 'HCS §3.1.7.3', hcrnList, 'a list of valid HCRNs') ?? [];
  const validFrom = read('valid-from', 'HCS §3.1.7.2', asTimestamp, 'a Timestamp');
  const validUntil = read('valid-until', 'HCS §3.1.7.2', asTimestamp, 'a Timestamp');
  const maxAge = read('max-age', 'HCS §3.1.8', parsePositiveInteger, 'a positive integer');
  const server = read('server', 'HCS §3.1.10', asHttps, 'an absolute HTTPS URL');

  const hasSubjectId = right.attributes['subject-id'] !== undefined;
  if (hasSubjectId === (right.attributes['subject-class'] !== undefined)) {
    report('subject_identification', 'HCS §3.1', '@subject-id', 'exactly one of subject-id and subject-class is required');
  }
  if (status === 'superseded' && right.attributes['superseded-by'] === undefined) {
    report('missing_attribute', 'HCS §3.1.7.3', '@superseded-by', 'superseded-by is required when status="superseded"');
  }

  let subjectScope: string[] | undefined;
  const rawScope = right.attributes['subject-scope'];
  if (rawScope !== undefined) {
    const scopes = unique(splitList(rawScope));
    if (subject === 'mark') {
      report('invalid_subject_scope', 'HCS §3.1.6.2', '@subject-scope', 'subject-scope must not be used with subject="mark"');
    } else if (scopes.length === 0) {
      report('invalid_subject_scope', 'HCS §3.1.6.2', '@subject-scope', 'subject-scope must list at least one value');
    } else if (subject !== undefined) {
      const undefinedScopes = scopes.filter((s) => !SUBJECT_SCOPES[subject].includes(s));
      if (undefinedScopes.length > 0) {
        report(
          'invalid_subject_scope',
          'HCS §3.1.6.2',
          '@subject-scope',
          `${undefinedScopes.join(', ')} is not defined for subject="${subject}"`,
        );
      }
    }
    subjectScope = scopes;
  }

  const schema = checkSchema(right, subject, hasSubjectId ? subjectId : undefined, hasSubjectId ? undefined : subjectClass, report);

  if (right.licenses.length === 0) report('element_count', 'HCS §3.1', 'license', 'at least one <license> is required');
  const licenses = right.licenses.map((license, i) =>
    checkLicense(license, `license[${i + 1}]`, document.source.slice(license.element.start, license.element.end), report),
  );

  const termsNode = atMostOne(right.terms, 'terms', '', 'HCS §3.1', report);
  if (termsNode !== undefined) {
    checkAttributeNames(termsNode, [], 'terms', report);
    checkLeaf(termsNode, 'terms', report);
  }

  checkCertifications(right, issued, warn);
  const components = checkComponentReferences(right, right.attributes['subject-class'] !== undefined, report);

  if (
    registry === undefined ||
    registrationId === undefined ||
    issued === undefined ||
    subject === undefined ||
    schema === undefined ||
    licenses.some((l) => l === undefined)
  ) {
    return undefined;
  }
  return {
    registry,
    registrationId,
    issued,
    subject,
    subjectScope,
    territory,
    subjectId,
    subjectClass,
    status,
    supersedes,
    supersededBy,
    validFrom,
    validUntil,
    maxAge,
    documentMaxAge: parsePositiveInteger(collapse(document.attributes['max-age'] ?? '')),
    server,
    schema,
    profile: String(schema.additionalType),
    terms: termsNode && collapse(termsNode.text),
    licenses: licenses as LicenseTerms[],
    includes: components.includes,
    included: components.included,
    source: right.source,
  };
}

function checkRoot(document: HcsDocument): Finding[] {
  const findings: Finding[] = [];
  const add = (code: FindingCode, rule: string, at: string, message: string) => {
    findings.push({ code, rule, at, message });
  };

  if (!document.declaresHcsNamespace) {
    add('hcs_namespace_not_on_root', 'HCS §2.2', '/rsl', 'the <rsl> root must declare the HCS namespace');
  }
  for (const name of Object.keys(document.attributes)) {
    if (name !== 'max-age') {
      add('invalid_root_attribute', APPENDIX_A, `/rsl/@${name}`, `attribute ${name} is not allowed on <rsl>`);
    }
  }
  const maxAge = document.attributes['max-age'];
  if (maxAge !== undefined && parsePositiveInteger(collapse(maxAge)) === undefined) {
    add('invalid_root_attribute', 'HCS §3.1.8', '/rsl/@max-age', `max-age must be a positive integer, found "${maxAge}"`);
  }
  for (const attribute of document.foreignAttributes) {
    if (attribute.uri === RSL_NAMESPACE || attribute.uri === HCS_NAMESPACE) {
      add('invalid_root_attribute', APPENDIX_A, `/rsl/@${attribute.name}`, `attribute ${attribute.name} is not allowed on <rsl>`);
    }
  }
  if (collapse(document.text) !== '') add('unexpected_root_element', APPENDIX_A, '/rsl/text()', 'text is not allowed in <rsl>');
  for (const element of document.unexpected) {
    add('unexpected_root_element', APPENDIX_A, `/rsl/${element.name}`, `<${element.name}> is not allowed in <rsl>`);
  }
  return findings;
}

/** Checks every `<hcs:right>` of a parsed document, in document order. */
export function checkDocument(document: HcsDocument): DeclarationCheck[] {
  const rootFindings = checkRoot(document);
  const idCounts = new Map<string, number>();
  for (const right of document.rights) {
    const id = collapse(right.attributes['registration-id'] ?? '');
    if (id !== '') idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  return document.rights.map((right) => {
    const reasons: Finding[] = [...rootFindings];
    const warnings: Finding[] = [];
    const id = collapse(right.attributes['registration-id'] ?? '');
    if ((idCounts.get(id) ?? 0) > 1) {
      reasons.push({
        code: 'duplicate_registration_id',
        rule: 'HCS §3.1.2',
        at: '@registration-id',
        message: `${id} appears on more than one <hcs:right> in this document`,
      });
    }
    const report: Report = (code, rule, at, message) => reasons.push({ code, rule, at, message });
    const warn: Report = (_code, rule, at, message) =>
      warnings.push({ code: 'certification_invalid', rule, at, message });
    const declaration = checkRight(document, right, report, warn);
    return reasons.length === 0 ? { reasons, warnings, declaration } : { reasons, warnings };
  });
}
