/**
 * ISO 3166-1 alpha-2 codes for `territory` (HCS 1.0 Draft §3.1.6.7) and RSL `geo` tokens.
 *
 * The 249 officially assigned codes, cross-checked on 2026-09-24 against two public copies of
 * the ISO list. User-assigned (e.g. XK) and reserved codes (e.g. EU, UK) are not included.
 */

export const ISO_3166_ALPHA_2: ReadonlySet<string> = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
   BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
   CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
   DE DJ DK DM DO DZ
   EC EE EG EH ER ES ET
   FI FJ FK FM FO FR
   GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
   HK HM HN HR HT HU
   ID IE IL IM IN IO IQ IR IS IT
   JE JM JO JP
   KE KG KH KI KM KN KP KR KW KY KZ
   LA LB LC LI LK LR LS LT LU LV LY
   MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ
   OM
   PA PE PF PG PH PK PL PM PN PR PS PT PW PY
   QA
   RE RO RS RU RW
   SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
   TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
   UA UG UM US UY UZ
   VA VC VE VG VI VN VU
   WF WS
   YE YT
   ZA ZM ZW`.split(/\s+/),
);

/** Member states of the European Union, for the RSL `EU` geo token (as of 2026-09). */
export const EU_MEMBER_STATES: readonly string[] = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
];

export function isCountryCode(code: string): boolean {
  return ISO_3166_ALPHA_2.has(code);
}

/**
 * The countries covered by RSL geo tokens. HCS §3.1.6.7 limits regional terms to the countries
 * they cover, so `EU` becomes its member states.
 */
export function expandGeo(tokens: readonly string[]): Set<string> {
  return new Set(tokens.flatMap((token) => (token === 'EU' ? EU_MEMBER_STATES : [token])));
}
