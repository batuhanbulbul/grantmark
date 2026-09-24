/**
 * Structural comparison of `<license>` elements, used to match the license a client submits to
 * a license server against the offers in the current declaration.
 *
 * RSL does not say how that match works. Grantmark compares the parsed elements: namespaces
 * instead of prefixes, attributes and children in any order (their order is not significant in
 * the HCS schema), whitespace collapsed, and token order ignored inside list elements. Any other
 * difference, such as a changed price, means no match.
 */

import { collapse, splitList } from './lexical';
import { HCS_NAMESPACE, RSL_NAMESPACE } from './parser';
import { readXml, type XmlElement } from './xml';

const LIST_ELEMENTS = new Set(['permits', 'prohibits', 'legal']);

/** A string that is equal for two elements exactly when they match structurally. */
export function canonicalElement(element: XmlElement): string {
  const attributes = element.attributes
    .map((a) => `${a.uri}|${a.local}=${JSON.stringify(collapse(a.value))}`)
    .sort()
    .join(' ');
  const isList = element.uri === RSL_NAMESPACE && LIST_ELEMENTS.has(element.local);
  const text = isList ? [...new Set(splitList(element.text))].sort().join(' ') : collapse(element.text);
  const children = element.children.map(canonicalElement).sort().join('');
  return `<${element.uri}|${element.local} ${attributes}>${JSON.stringify(text)}${children}</>`;
}

/**
 * The canonical form of a standalone `<license>` fragment, as a client submits it. Unprefixed
 * elements default to the RSL namespace and the `hcs` prefix is bound, as inside an HCS
 * document. Returns undefined unless the input is exactly one RSL `<license>` element.
 */
export function canonicalLicense(fragment: string): string | undefined {
  const result = readXml(`<rsl xmlns="${RSL_NAMESPACE}" xmlns:hcs="${HCS_NAMESPACE}">${fragment}</rsl>`);
  if (!result.ok || result.root.children.length !== 1 || collapse(result.root.text) !== '') return undefined;
  const license = result.root.children[0]!;
  return license.uri === RSL_NAMESPACE && license.local === 'license' ? canonicalElement(license) : undefined;
}
