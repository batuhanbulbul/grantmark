/**
 * Reads an RSL document into a typed model of its HCS declarations (HCS 1.0 Draft §3).
 *
 * The parser reports what the document says; it does not decide whether a declaration is
 * conforming or operative. Attribute values and text are kept as the XML reader delivers them,
 * without whitespace normalization, and every child element is either sorted into its role,
 * kept as an extension (any namespace other than RSL and HCS), or reported as unexpected (an
 * RSL or HCS element that has no role in its parent). The evaluator applies the spec's rules
 * to this model.
 */

import {
  readXml,
  type ReadXmlOptions,
  type XmlAttribute,
  type XmlElement,
  type XmlErrorCode,
} from './xml';

export const RSL_NAMESPACE = 'https://rslstandard.org/rsl';
export const HCS_NAMESPACE = 'https://humanconsent.org/hcs';

export interface HcsNode {
  readonly element: XmlElement;
  /** Unprefixed attributes by name. RSL and HCS attributes are in no namespace (§2.2). */
  readonly attributes: Readonly<Record<string, string>>;
  /** Attributes in a namespace. HCS-defined elements do not allow them (Appendix A). */
  readonly foreignAttributes: readonly XmlAttribute[];
  /** Character data directly inside the element. */
  readonly text: string;
  /** Child elements in no namespace or in a namespace other than RSL and HCS. */
  readonly extensions: readonly XmlElement[];
  /** RSL or HCS child elements that have no role in this element. */
  readonly unexpected: readonly XmlElement[];
}

export interface HcsPayment extends HcsNode {
  readonly standard: readonly HcsNode[];
  readonly custom: readonly HcsNode[];
  readonly amounts: readonly HcsNode[];
  readonly accepts: readonly HcsNode[];
}

export interface HcsLicense extends HcsNode {
  readonly permits: readonly HcsNode[];
  readonly prohibits: readonly HcsNode[];
  readonly payments: readonly HcsPayment[];
  readonly reporting: readonly HcsNode[];
  readonly legal: readonly HcsNode[];
}

/** `<hcs:includes>` or `<hcs:included>` (§3.4). */
export interface HcsComponentReference extends HcsNode {
  readonly schemas: readonly HcsNode[];
}

export interface HcsRight extends HcsNode {
  /** The exact source text of the `<hcs:right>` element. */
  readonly source: string;
  readonly schemas: readonly HcsNode[];
  readonly licenses: readonly HcsLicense[];
  readonly terms: readonly HcsNode[];
  readonly certifications: readonly HcsNode[];
  readonly includes: readonly HcsComponentReference[];
  readonly included: readonly HcsComponentReference[];
}

/** The `<rsl>` root and the declarations that are its direct children. */
export interface HcsDocument extends HcsNode {
  /** The decoded document; element offsets point into it. */
  readonly source: string;
  /** Whether the root element declares the HCS namespace, under any prefix (§2.2). */
  readonly declaresHcsNamespace: boolean;
  readonly rights: readonly HcsRight[];
  /** RSL `<content>` elements, which HCS leaves to RSL processing (§3). */
  readonly content: readonly XmlElement[];
}

export type HcsParseErrorCode = XmlErrorCode | 'not_rsl';

export interface HcsParseError {
  readonly code: HcsParseErrorCode;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type HcsParseResult =
  | { readonly ok: true; readonly document: HcsDocument }
  | { readonly ok: false; readonly error: HcsParseError };

const rsl = (local: string) => `${RSL_NAMESPACE} ${local}`;
const hcs = (local: string) => `${HCS_NAMESPACE} ${local}`;

/**
 * Builds the common node fields and groups the children named in `roles`
 * (role name to `"<namespace> <local name>"`).
 */
function sort<K extends string>(
  element: XmlElement,
  roles: Readonly<Record<K, string>>,
): HcsNode & Record<K, XmlElement[]> {
  const roleByName = new Map<string, K>();
  const groups = {} as Record<K, XmlElement[]>;
  for (const role of Object.keys(roles) as K[]) {
    roleByName.set(roles[role], role);
    groups[role] = [];
  }

  const extensions: XmlElement[] = [];
  const unexpected: XmlElement[] = [];
  for (const child of element.children) {
    const role = roleByName.get(`${child.uri} ${child.local}`);
    if (role !== undefined) groups[role].push(child);
    else if (child.uri === RSL_NAMESPACE || child.uri === HCS_NAMESPACE) unexpected.push(child);
    else extensions.push(child);
  }

  const attributes: Record<string, string> = {};
  const foreignAttributes: XmlAttribute[] = [];
  for (const attribute of element.attributes) {
    if (attribute.uri === '') attributes[attribute.local] = attribute.value;
    else foreignAttributes.push(attribute);
  }

  return { ...groups, element, attributes, foreignAttributes, text: element.text, extensions, unexpected };
}

const readLeaf = (element: XmlElement): HcsNode => sort(element, {});

function readPayment(element: XmlElement): HcsPayment {
  const node = sort(element, {
    standard: rsl('standard'),
    custom: rsl('custom'),
    amounts: rsl('amount'),
    accepts: rsl('accepts'),
  });
  return {
    ...node,
    standard: node.standard.map(readLeaf),
    custom: node.custom.map(readLeaf),
    amounts: node.amounts.map(readLeaf),
    accepts: node.accepts.map(readLeaf),
  };
}

function readLicense(element: XmlElement): HcsLicense {
  const node = sort(element, {
    permits: rsl('permits'),
    prohibits: rsl('prohibits'),
    payments: rsl('payment'),
    reporting: rsl('reporting'),
    legal: rsl('legal'),
  });
  return {
    ...node,
    permits: node.permits.map(readLeaf),
    prohibits: node.prohibits.map(readLeaf),
    payments: node.payments.map(readPayment),
    reporting: node.reporting.map(readLeaf),
    legal: node.legal.map(readLeaf),
  };
}

function readComponentReference(element: XmlElement): HcsComponentReference {
  const node = sort(element, { schemas: rsl('schema') });
  return { ...node, schemas: node.schemas.map(readLeaf) };
}

function readRight(element: XmlElement, source: string): HcsRight {
  const node = sort(element, {
    schemas: rsl('schema'),
    licenses: rsl('license'),
    terms: rsl('terms'),
    certifications: hcs('certification'),
    includes: hcs('includes'),
    included: hcs('included'),
  });
  return {
    ...node,
    source: source.slice(element.start, element.end),
    schemas: node.schemas.map(readLeaf),
    licenses: node.licenses.map(readLicense),
    terms: node.terms.map(readLeaf),
    certifications: node.certifications.map(readLeaf),
    includes: node.includes.map(readComponentReference),
    included: node.included.map(readComponentReference),
  };
}

export function parseHcsDocument(
  input: string | Uint8Array,
  options: ReadXmlOptions = {},
): HcsParseResult {
  const result = readXml(input, options);
  if (!result.ok) return result;
  const { source, root } = result;

  if (root.uri !== RSL_NAMESPACE || root.local !== 'rsl') {
    const found = root.uri === '' ? `<${root.local}>` : `<${root.local}> in ${root.uri}`;
    return {
      ok: false,
      error: { code: 'not_rsl', message: `root must be <rsl> in ${RSL_NAMESPACE}, found ${found}` },
    };
  }

  const node = sort(root, { rights: hcs('right'), content: rsl('content') });
  return {
    ok: true,
    document: {
      ...node,
      source,
      declaresHcsNamespace: Object.values(root.namespaces).includes(HCS_NAMESPACE),
      rights: node.rights.map((right) => readRight(right, source)),
    },
  };
}
