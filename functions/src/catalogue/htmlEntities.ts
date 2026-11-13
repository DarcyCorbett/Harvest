export function decodeEntities(value: string): string {
  return value
    // Core entities (&amp; must come first to avoid double-decoding)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Whitespace / punctuation
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&deg;/g, '°')
    .replace(/&times;/g, '×')
    .replace(/&divide;/g, '÷')
    // Quotes
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&raquo;/g, '»')
    .replace(/&laquo;/g, '«')
    // Fractions / maths
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾')
    .replace(/&frac13;/g, '⅓')
    .replace(/&frac23;/g, '⅔')
    .replace(/&frac18;/g, '⅛')
    .replace(/&frac38;/g, '⅜')
    .replace(/&frac58;/g, '⅝')
    .replace(/&frac78;/g, '⅞')
    .replace(/&Prime;/g, '″')
    .replace(/&prime;/g, '′')
    // Accented characters
    .replace(/&[Ee]acute;/g, (m) => (m[1] === 'E' ? 'É' : 'é'))
    .replace(/&[Ee]grave;/g, (m) => (m[1] === 'E' ? 'È' : 'è'))
    .replace(/&[Ee]circ;/g, (m) => (m[1] === 'E' ? 'Ê' : 'ê'))
    .replace(/&[Aa]grave;/g, (m) => (m[1] === 'A' ? 'À' : 'à'))
    .replace(/&[Aa]acute;/g, (m) => (m[1] === 'A' ? 'Á' : 'á'))
    .replace(/&[Aa]circ;/g, (m) => (m[1] === 'A' ? 'Â' : 'â'))
    .replace(/&[Aa]uml;/g, (m) => (m[1] === 'A' ? 'Ä' : 'ä'))
    .replace(/&[Oo]acute;/g, (m) => (m[1] === 'O' ? 'Ó' : 'ó'))
    .replace(/&[Oo]uml;/g, (m) => (m[1] === 'O' ? 'Ö' : 'ö'))
    .replace(/&[Uu]acute;/g, (m) => (m[1] === 'U' ? 'Ú' : 'ú'))
    .replace(/&[Uu]uml;/g, (m) => (m[1] === 'U' ? 'Ü' : 'ü'))
    .replace(/&[Ii]acute;/g, (m) => (m[1] === 'I' ? 'Í' : 'í'))
    .replace(/&[Cc]cedil;/g, (m) => (m[1] === 'C' ? 'Ç' : 'ç'))
    .replace(/&[Nn]tilde;/g, (m) => (m[1] === 'N' ? 'Ñ' : 'ñ'))
    .replace(/&szlig;/g, 'ß')
    // Symbols
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    // Numeric references: decimal &#123; and hex &#xAB; with bounds check
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    });
}
